import { isDemoMode } from "../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentAccountId, getWorkflowRepository } from "../../../../lib/workflow-runtime";
import { isQueueClaimableKind } from "@media-track/workflow";
import type { RetryRefusalReason } from "../../../../lib/activity-view";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { triggerManualSubscriptionSearch } from "../../../../features/acquisition/application/manual-subscription-search-service";

/**
 * Retry a failed task from the activity page. A failed patrol is a historical
 * attempt: create a fresh targeted search using the current subscription policy
 * and link it to the old run, rather than replaying its stale policy snapshot.
 * Other queueable kinds keep the repository's same-run retry behavior.
 */
export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return Response.json({ error: "演示站只读" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { runId?: unknown };
  const runId = typeof body.runId === "string" ? body.runId : null;
  if (!runId) {
    return NextResponse.json({ error: "runId required" }, { status: 400 });
  }
  const repository = getWorkflowRepository();
  const accountId = await getCurrentAccountId();
  const snapshot = await repository.getWorkflowRunSnapshot(runId, accountId);
  if (snapshot?.workflowRun.kind === "type3_monitor" && snapshot.workflowRun.status === "failed") {
    const result = await triggerManualSubscriptionSearch({
      accountId,
      tmdbId: snapshot.title.tmdbId,
      mediaType: snapshot.title.type,
      ...(snapshot.title.type === "movie" ? {} : { seasonNumber: snapshot.season.seasonNumber }),
      storageId: snapshot.connectedStorageId ?? null,
      source: "activity",
      sourceWorkflowRunId: runId,
    });
    return NextResponse.json(result);
  }

  const result = await repository.retryFailedWorkflowRun(runId, accountId);
  if (result.status === "retried") {
    return NextResponse.json(result);
  }
  // Status is checked before kind so a running task is not mislabeled as a
  // permanently non-retriable kind. An unreadable run falls back to the vague
  // response to avoid leaking whether it exists in another account.
  const reason: RetryRefusalReason =
    snapshot &&
    snapshot.workflowRun.status === "failed" &&
    !isQueueClaimableKind(snapshot.workflowRun.kind)
      ? "kind_not_retriable"
      : "not_failed";
  return NextResponse.json({ ...result, reason });
}

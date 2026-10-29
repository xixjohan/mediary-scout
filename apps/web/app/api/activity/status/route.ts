import { connection, NextResponse, type NextRequest } from "next/server";
import { getWorkflowRepository, resolveGlobalWorkspace } from "../../../../lib/workflow-runtime";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { isUserVisibleWorkflowKind, tailAgentStepViews } from "@media-track/workflow";
import { inferActivityText } from "../../../../lib/title-hub";

function parseStatusQueryParams(url: URL): { runId: string | null; tmdbId: number | null } | null {
  const searchParams = url.searchParams;
  const tmdbIdParam = searchParams.get("tmdbId");
  const runId = searchParams.get("runId");

  const tmdbId = tmdbIdParam ? parseInt(tmdbIdParam, 10) : null;
  const hasValidTmdb = typeof tmdbId === "number" && Number.isInteger(tmdbId) && tmdbId > 0;
  const hasValidRunId = typeof runId === "string" && runId.trim().length > 0;

  if (!hasValidRunId && !hasValidTmdb) {
    return null;
  }
  return {
    runId: hasValidRunId ? runId.trim() : null,
    tmdbId: hasValidTmdb ? tmdbId : null,
  };
}

interface FormatRunInput {
  matched: Parameters<typeof isUserVisibleWorkflowKind>[0] extends never ? never : any;
  queuedOrder: readonly string[];
  scope: { accountId: string; connectedStorageId: string | null };
  repository: ReturnType<typeof getWorkflowRepository>;
}

async function formatMatchedRunResponse(input: FormatRunInput): Promise<NextResponse> {
  const { matched, queuedOrder, scope, repository } = input;
  const runStatus = matched.workflowRun.status === "running" ? "running" : "queued";
  const queueIndex = queuedOrder.indexOf(matched.workflowRun.id);
  const queuePosition = runStatus === "queued" && queueIndex >= 0 ? queueIndex + 1 : null;
  const progress = matched.workflowRun.progress ?? null;
  const activity = inferActivityText(runStatus, progress, queuePosition);

  const agentSteps =
    runStatus === "running"
      ? tailAgentStepViews(await repository.listAgentSteps(matched.workflowRun.id, scope))
      : [];

  const auditEvents = (matched.workflowRun.auditEvents ?? []).map((e: { type: string; message: string }) => ({
    type: e.type,
    message: e.message,
  }));

  const phase = progress?.phase ?? (runStatus === "queued" ? "queued" : "transfer");
  const percent = progress?.percent ?? (runStatus === "queued" ? 5 : 45);

  return NextResponse.json({
    status: "active",
    active: true,
    runId: matched.workflowRun.id,
    tmdbId: matched.title.tmdbId,
    title: matched.title.title,
    year: matched.title.year,
    type: matched.title.type,
    posterPath: matched.title.posterPath ?? null,
    runStatus,
    queuePosition,
    phase,
    percent,
    activity,
    startedAt: matched.workflowRun.startedAt,
    steps: agentSteps,
    auditEvents,
    cancellable: true,
  });
}

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  await connection();

  const parsed = parseStatusQueryParams(request.nextUrl);
  if (!parsed) {
    return NextResponse.json({ error: "tmdbId or runId required" }, { status: 400 });
  }
  const { runId, tmdbId } = parsed;

  const repository = getWorkflowRepository();
  const { accountId, connectedStorageId } = await resolveGlobalWorkspace(
    request.nextUrl.searchParams.get("w") ?? undefined,
  );
  const scope = { accountId, connectedStorageId };

  const activeRuns = (await repository.listActiveWorkflowRuns(scope)).filter((s) =>
    isUserVisibleWorkflowKind(s.workflowRun.kind),
  );

  const matched = activeRuns.find(
    (s) => (runId !== null && s.workflowRun.id === runId) || (tmdbId !== null && s.title.tmdbId === tmdbId),
  );

  if (!matched) {
    return NextResponse.json({
      status: "idle",
      active: false,
    });
  }

  const queuedOrder = activeRuns
    .filter((s) => s.workflowRun.status === "queued")
    .sort((a, b) => a.workflowRun.startedAt.localeCompare(b.workflowRun.startedAt))
    .map((s) => s.workflowRun.id);

  return formatMatchedRunResponse({
    matched,
    queuedOrder,
    scope,
    repository,
  });
}

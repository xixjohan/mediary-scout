import { connection, NextResponse, type NextRequest } from "next/server";
import {
  queueManualImport,
  resourceSearchRunId,
  type ResourceSnapshot,
} from "@media-track/workflow";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getWorkflowRepository, resolveGlobalWorkspace } from "../../../../lib/workflow-runtime";

/**
 * POST /api/titles/import — 手动入库 (batch 3, ①).
 *
 * The user picked one row in the 资源 panel; this turns that into a queued
 * `manual_import` run. It does NOT transfer anything itself — the transfer is slow and
 * goes through the drive pacer, so it is queued (see manual-import-command.ts for why a
 * run rather than a `sys_queue_jobs` row).
 *
 * Gates, in this order (the order is the design):
 *   1. scope       — no resolvable account ⇒ 401. Import WRITES to a drive, so it may
 *                    not run unauthenticated.
 *   2. body        — all three fields required and typed. A candidateId alone is not
 *                    enough: the server must know WHICH search it came from.
 *   3. snapshot    — read back from the DB, scoped. A snapshotId the caller does not
 *                    own is invisible (404), not "not found but here's a guess".
 *   4. candidate   — `queueManualImport` re-validates membership and the 30-minute TTL.
 *                    The HTTP layer only forwards the id; it does not decide.
 *
 * The candidate's `providerPayload` (raw share link / magnet) is NEVER in the request
 * and NEVER in the response — plan §3.3. The client holds an opaque handle; this route
 * is what resolves it back to the real link, server-side, at transfer time.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Parse and validate the request body. Split out of POST so the handler stays a thin
 * adapter (and under the repo's complexity budget) — and so the shape rules are
 * testable without an HTTP round-trip.
 *
 * `snapshotId` + `candidateId` are both required: a candidateId alone is only
 * meaningful relative to the search that produced it.
 */
export function parseImportRequestBody(
  value: unknown,
): { ok: true; tmdbId: number; snapshotId: string; candidateId: string } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "invalid body" };
  const body = value as { tmdbId?: unknown; snapshotId?: unknown; candidateId?: unknown };
  const tmdbId = typeof body.tmdbId === "number" ? body.tmdbId : Number.NaN;
  const snapshotId = typeof body.snapshotId === "string" ? body.snapshotId : "";
  const candidateId = typeof body.candidateId === "string" ? body.candidateId : "";
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return { ok: false, error: "tmdbId must be a positive integer" };
  }
  if (snapshotId.length === 0 || candidateId.length === 0) {
    return { ok: false, error: "snapshotId and candidateId are required" };
  }
  return { ok: true, tmdbId, snapshotId, candidateId };
}

export async function POST(request: NextRequest) {
  await connection();

  // 1) Scope, fail-closed.
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId;

  // 2) Body.
  let parsed: ReturnType<typeof parseImportRequestBody>;
  try {
    parsed = parseImportRequestBody(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400, headers: NO_STORE });
  }
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  }
  const { tmdbId, snapshotId, candidateId } = parsed;

  // 3) Read the persisted snapshot back, scoped. `resourceSearchRunId` is the SAME
  //    derivation the search route used to write it, so the two cannot drift.
  const record = await getWorkflowRepository().getWorkflowRunSnapshot(
    resourceSearchRunId(snapshotId),
    accountId,
  );
  if (record === null) {
    // Fail closed: a snapshot this account does not own is invisible. Returning 400
    // here would confirm that the id exists somewhere.
    return NextResponse.json({ error: "snapshot not found" }, { status: 404, headers: NO_STORE });
  }
  const snapshot: ResourceSnapshot | undefined = record.resourceSnapshots.find(
    (entry) => entry.id === snapshotId,
  );
  if (snapshot === undefined) {
    return NextResponse.json({ error: "snapshot not found" }, { status: 404, headers: NO_STORE });
  }
  // Cross-check the title the caller named against the one the snapshot belongs to.
  // Without this the body's tmdbId is validated and then ignored, which would let a
  // client pair title A's snapshot with title B's id — the import would run against
  // the wrong title's directories.
  if (record.title.tmdbId !== tmdbId) {
    return NextResponse.json(
      { error: "snapshot does not belong to this title" },
      { status: 400, headers: NO_STORE },
    );
  }

  // 4) The command re-validates membership + TTL and reserves the run.
  let targetStorageId = record.connectedStorageId;
  if (!targetStorageId) {
    const ws = await resolveGlobalWorkspace(undefined);
    targetStorageId = ws.connectedStorageId;
  }
  const result = await queueManualImport({
    request: {
      snapshot,
      candidateId,
      title: record.title,
      season: record.season,
      accountId,
      connectedStorageId: targetStorageId,
    },
    repository: getWorkflowRepository(),
  });

  switch (result.status) {
    case "rejected":
      // 410, not 400: the candidate WAS valid and its window has closed (or it was
      // never from this search). Either way the user's next step is the same — search
      // again — and 410 tells the client not to retry this exact request.
      return NextResponse.json(
        { error: result.copy, reason: result.reason },
        { status: 410, headers: NO_STORE },
      );
    case "already_running":
      // 200, not 202: nothing new was queued. Reporting 202 would make the client show
      // progress for a run it did not start.
      return NextResponse.json(
        { status: "already_running", workflowRunId: result.workflowRunId },
        { headers: NO_STORE },
      );
    case "queued":
      // 202: accepted, work is queued, nothing has transferred yet.
      return NextResponse.json(
        { status: "queued", workflowRunId: result.workflowRunId },
        { status: 202, headers: NO_STORE },
      );
  }
}

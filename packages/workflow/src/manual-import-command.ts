import type { MediaTitle, ResourceSnapshot, TrackedSeason } from "./domain.js";
import { decisionFromSelection, HumanCandidateSelector, type CandidateSelection } from "./candidate-selector.js";
import type {
  PersistWorkflowRunSnapshotInput,
  WorkflowRepository,
  WorkflowRunReservationResult,
} from "./repository.js";

/** Batch 3's new kind. Exported so the worker's claim call site and this command
 *  cannot drift apart on the spelling. */
export const MANUAL_IMPORT_KIND = "manual_import" as const;

/**
 * Reserve the `manual_import` run that carries one user-triggered import (batch 3, ①).
 *
 * **Where this deviates from the plan, and why.** The plan says 「入 sys_queue_jobs」,
 * but `sys_queue_jobs` has NO producer and NO consumer anywhere in this codebase — the
 * table exists (`sqlite-queue.ts`) and `SqliteJobQueue` implements the port, but nothing
 * instantiates it. The mechanism that actually runs background work here is a
 * `workflow_runs` row with `status='queued'`, claimed by
 * `claimNextQueuedWorkflowRun({ kind })` — 7 call sites, all of them this pattern.
 *
 * So this reserves a run instead of enqueuing a job. What the plan asked for is
 * preserved: **not synchronous in the HTTP request** (the transfer is slow and goes
 * through the drive pacer) and **a new WorkflowKind**. What is dropped is a second,
 * parallel queue mechanism that would have to be wired end-to-end (claim loop, stale
 * reaper, retry/dead-letter) for exactly one job kind — duplicating what
 * `claimNextQueuedWorkflowRun` already does, including G10's crash recovery.
 *
 * The `manual-import-job.ts` payload validation is NOT dead under this design: the
 * worker reads the run back out of SQLite, and that IS a read-back across a process
 * boundary. It re-validates the candidate against the snapshot (and the TTL) before
 * transferring, for the same reason `parseManualImportJobPayload` exists.
 */
export interface QueueManualImportInput {
  /** The persisted snapshot the candidate was chosen from (already loaded, scoped). */
  snapshot: ResourceSnapshot;
  /** The candidate the user picked. Validated against `snapshot` here, not trusted. */
  candidateId: string;
  title: MediaTitle;
  season: TrackedSeason;
  accountId: string;
  connectedStorageId?: string | null;
  createWorkflowRunId?: () => string;
  now?: () => string;
}

export type ManualImportRequestResult =
  | { status: "queued"; workflowRunId: string }
  | { status: "already_running"; workflowRunId: string }
  /** The candidate is not in this snapshot, or the window closed. */
  | { status: "rejected"; reason: "not_found" | "expired"; copy: string };

/**
 * Reserve the run. The candidate→selection step goes through the SAME
 * `decisionFromSelection` the agent path uses, so the persisted decision is
 * structurally identical apart from `source` (plan's batch-3 acceptance).
 */
export async function queueManualImport(input: {
  request: QueueManualImportInput;
  repository: Pick<WorkflowRepository, "reserveWorkflowRun">;
  ttlMs?: number;
}): Promise<ManualImportRequestResult> {
  const now = input.request.now ?? (() => new Date().toISOString());
  const selector = new HumanCandidateSelector(input.request.candidateId);
  const selection: CandidateSelection = selector.select({ snapshot: input.request.snapshot });

  if (selection.selectedCandidateIds.length === 0) {
    // An empty selection is the selector's way of saying "not from this snapshot".
    // The TTL is NOT checked here on purpose: membership is the actionable fact.
    return { status: "rejected", reason: "not_found", copy: "这个候选不属于本次搜索，可能已过期或链接已失效。请重新查询资源。" };
  }

  const createdAtMs = Date.parse(input.request.snapshot.createdAt);
  const ttl = input.ttlMs ?? 30 * 60 * 1000;
  if (!Number.isFinite(createdAtMs) || Date.now() - createdAtMs > ttl) {
    return { status: "rejected", reason: "expired", copy: "资源查询已超过 30 分钟，候选已失效。请重新查询后再入库。" };
  }

  const workflowRunId = input.request.createWorkflowRunId?.() ?? crypto.randomUUID();
  const queuedAt = now();

  const reservation: WorkflowRunReservationResult = await input.repository.reserveWorkflowRun(
    buildManualImportReservation({
      request: input.request,
      snapshot: input.request.snapshot,
      selection,
      workflowRunId,
      queuedAt,
    }),
  );

  if (reservation.status === "already_active") {
    return { status: "already_running", workflowRunId: reservation.snapshot.workflowRun.id };
  }
  return { status: "queued", workflowRunId };
}

/** Assemble the reservation. Split out so the payload shape is unit-testable alone. */
export function buildManualImportReservation(input: {
  request: QueueManualImportInput;
  snapshot: ResourceSnapshot;
  selection: CandidateSelection;
  workflowRunId: string;
  queuedAt: string;
}): PersistWorkflowRunSnapshotInput & { blockIfTitleHasActiveRun?: boolean } {
  return {
    ...(input.request.accountId ? { accountId: input.request.accountId } : {}),
    ...(input.request.connectedStorageId != null
      ? { connectedStorageId: input.request.connectedStorageId }
      : {}),
    title: input.request.title,
    season: input.request.season,
    workflowRun: {
      id: input.workflowRunId,
      kind: MANUAL_IMPORT_KIND,
      status: "queued",
      trackedSeasonId: input.request.season.id,
      startedAt: input.queuedAt,
      finishedAt: null,
      auditEvents: [
        {
          type: "manual_import_queued",
          message: `Queued manual import ${input.workflowRunId}`,
          data: { candidateId: input.selection.selectedCandidateIds[0] },
        },
      ],
    },
    episodes: [],
    // The snapshot rides along so the worker can re-read the candidate — and re-validate
    // it — after the run comes back out of SQLite.
    resourceSnapshots: [input.snapshot],
    decisions: [
      decisionFromSelection({
        selection: input.selection,
        snapshot: input.snapshot,
        source: "human",
        node: "manual_import",
      }),
    ],
    transferAttempts: [],
    notifications: [],
    // A manual import writes into the title's directories; two concurrent ones would
    // race on staging and dedup exactly as two agent acquisitions would.
    blockIfTitleHasActiveRun: true,
  };
}

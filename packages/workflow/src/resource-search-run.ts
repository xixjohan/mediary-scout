import type { MediaTitle, ResourceSnapshot, TrackedSeason, WorkflowKind } from "./domain.js";
import type { PersistWorkflowRunSnapshotInput } from "./repository.js";
import { isUserVisibleWorkflowKind } from "./domain.js";

/**
 * The record that lets a manual import recover a candidate's payload (batch 3).
 *
 * The problem this solves: `POST /api/titles/resources` answers from a TTL cache, and
 * the candidateId it hands the user is only meaningful while that cache lives. The
 * plan's §3.2 decision is that import must read the payload from a PERSISTED
 * `resource_snapshots` row — not from `CandidateRegistry`, which is process memory.
 * But `resource_snapshots.workflow_run_id` is NOT NULL, so a snapshot cannot exist
 * without a run to hang it on.
 *
 * So a user-triggered search persists ONE run of kind `resource_search` whose only
 * content is that snapshot. It is a RECORD, not work:
 *   · status is `succeeded`, so `isActiveWorkflowStatus` (queued|running) excludes it
 *     from 活动 — the user never sees a row for a search they ran;
 *   · it emits no notification, so it never appears in 已完成 either;
 *   · `isUserVisibleWorkflowKind` also excludes the kind, as a second line of defence
 *     for any future list that forgets the status filter.
 *
 * The alternative was a schema migration making `workflow_run_id` nullable plus a new
 * `saveResourceSnapshot` port method. That is the cleaner data model, but it is a
 * table rebuild and a wider port surface for a path whose write volume is one row per
 * user-initiated, 60-second-cooled search. Chosen for reversibility over elegance; if
 * search volume ever justifies it, the migration is still available.
 */
export const RESOURCE_SEARCH_KIND: WorkflowKind = "resource_search";

/**
 * The run id a search snapshot is persisted under. Exported so the import route derives
 * it the SAME way the search route wrote it — a private constant on either side would
 * let them drift, and the failure mode is silent: the import would simply find nothing
 * and tell the user 「请重新查询」 for a search that succeeded seconds ago.
 */
export function resourceSearchRunId(snapshotId: string): string {
  return `search_${snapshotId}`;
}

export interface BuildResourceSearchRunInput {
  snapshot: ResourceSnapshot;
  title: MediaTitle;
  season: TrackedSeason;
  accountId: string;
  connectedStorageId?: string | null;
  /** Injectable clock (ISO string) so tests are deterministic. */
  now: string;
}

/**
 * Assemble the run that carries one search's snapshot.
 *
 * Everything except `resourceSnapshots` is empty BY DESIGN: a search observed
 * candidates, it did not transfer anything, decide anything, or notify anyone. A
 * non-empty `episodes`/`decisions`/`transferAttempts` here would be a lie that later
 * readers (the janitor, the library view) would act on.
 */
export function buildResourceSearchRun(input: BuildResourceSearchRunInput): PersistWorkflowRunSnapshotInput {
  return {
    title: input.title,
    season: input.season,
    workflowRun: {
      id: resourceSearchRunId(input.snapshot.id),
      kind: RESOURCE_SEARCH_KIND,
      // `succeeded`, not `queued`: a queued row would count as active and block the
      // season forever (reserveWorkflowRun would answer already_active).
      status: "succeeded",
      trackedSeasonId: input.season.id,
      startedAt: input.now,
      finishedAt: input.now,
      auditEvents: [],
    },
    episodes: [],
    resourceSnapshots: [input.snapshot],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    accountId: input.accountId,
    connectedStorageId: input.connectedStorageId ?? null,
  };
}

/** A search record must never surface as work the system is doing. */
export function resourceSearchIsUserVisible(): boolean {
  return isUserVisibleWorkflowKind(RESOURCE_SEARCH_KIND);
}

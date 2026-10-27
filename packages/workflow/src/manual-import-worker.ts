// 直连具体模块，不走 barrel：index.ts 会导出本文件，从 barrel 导入会成环
// （dependency-cruiser 的 no-circular 会拦下）。
import { claimNextQueuedRun } from "./repository.js";
import type { QueueClaimOptions, WorkflowRepository } from "./repository.js";
import type { PersistedWorkflowRunSnapshot } from "./repository.js";
import { ensureMediaLibraryDirectory } from "./media-library-folder.js";
import { MANUAL_IMPORT_KIND } from "./manual-import-command.js";
import { MANUAL_IMPORT_TTL_MS, resolveManualImportCandidate } from "./manual-import-resolver.js";
import type { ResourceCandidate } from "./domain.js";
import type { StorageExecutor } from "./ports.js";
import type { TransferAttempt } from "./domain.js";
import type { ResolveAccountWorkerContext } from "./worker.js";

/**
 * The worker half of manual import (batch 3, ①).
 *
 * The HTTP route queues the run; this is what actually transfers. It exists because a
 * `manual_import` run left `queued` is not merely useless — `queued` counts as an active
 * status, and the run was reserved with `blockIfTitleHasActiveRun`, so an unclaimed one
 * blocks its title's other work indefinitely. The repository's own crash-recovery notes
 * exactly that trap for kinds with no claimer.
 *
 * Three things this deliberately re-does rather than trusts:
 *
 *  1. **Membership and TTL, again.** The route validated them; the run then sat in
 *     SQLite. Time passes, the snapshot's window closes. A transfer started on a
 *     candidate whose share link has expired fails on the drive, in the middle of a
 *     write — the one place a failure is expensive to explain. Re-check first.
 *
 *  2. **The payload, from the DB.** The candidate's share link never crossed HTTP
 *     (plan §3.3); it was persisted with the run and is read back here.
 *
 *  3. **The target directory, from the canonical structure.** `Title (Year) {tmdb-N}`
 *     under the TV parent, then `Season NN` — the same helpers the acquisition uses, so
 *     a manually imported season lands beside (not beside-and-duplicated-from) an
 *     automatically acquired one. A movie goes straight into the title dir.
 */

export interface ManualImportWorkerResult {
  status: "idle" | "succeeded" | "failed" | "rejected";
  workflowRunId?: string;
  reason?: string;
  error?: string;
}

export async function runQueuedManualImport(input: {
  repository: WorkflowRepository;
  /** The default account's executor; overridden per run when a resolver is given. */
  storage: StorageExecutor;
  /** The TV/movie category parent on the drive. */
  categoryParentDirectoryId: string;
  now?: () => string;
  ttlMs?: number;
  /**
   * §7 form B: the claimed run's account credentials. Manual import writes to a
   * drive, so it may not run on the default account's storage when the run belongs
   * to someone else — bob's import must land in bob's 115.
   *
   * Called directly and only `.storage` is read: unlike the acquisition runners this
   * one needs no LLM and no resource provider, and typing those in would force every
   * caller to build deps the transfer never touches.
   */
  resolveAccountContext?: ResolveAccountWorkerContext;
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  claim?: QueueClaimOptions;
}): Promise<ManualImportWorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const claimed = await claimNextQueuedRun(input.repository, MANUAL_IMPORT_KIND, now(), input.claim);
  if (claimed === null) {
    return { status: "idle" };
  }
  // Per-account drive. Resolved after the claim (claim-first, as everywhere else) so
  // the credentials describe the run we actually took.
  const storage =
    input.resolveAccountContext === undefined
      ? input.storage
      : (await input.resolveAccountContext(claimed.accountId, claimed.connectedStorageId)).storage ??
        input.storage;

  // (1) Re-validate against the DB copy, not the request that queued it.
  const validated = validateClaimedManualImport({
    claimed,
    // The resolver's clock is epoch-ms; the repository's is ISO. Parsing here keeps
    // the two from being confused — and a snapshot whose createdAt will not parse
    // comes back as `invalid_snapshot`, not as a silently-open window.
    nowMs: Date.parse(now()),
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  });
  if (validated.kind !== "ok") {
    return await failRun(input, claimed, validated.kind, manualImportFailureCopy(validated.kind));
  }
  const candidate: ResourceCandidate = validated.candidate;

  // (3) Canonical target: `Title (Year) {tmdb-N}` [+ `Season NN` for TV].
  const targetDirectoryId = await manualImportTargetDirectory({
    storage,
    title: claimed.title,
    season: claimed.season,
    categoryParentDirectoryId: input.categoryParentDirectoryId,
  });

  // (2) Transfer, reading the link out of the DB-resident candidate.
  let attempt: TransferAttempt;
  try {
    attempt = await storage.transfer({
      workflowRunId: claimed.workflowRun.id,
      directoryId: targetDirectoryId,
      candidate,
    });
  } catch (error) {
    return await failRun(
      input,
      claimed,
      "transfer_error",
      `转存失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (attempt.status !== "succeeded") {
    return await failRun(
      input,
      claimed,
      "transfer_failed",
      attempt.providerMessage.length > 0 ? attempt.providerMessage : "网盘未接受这次转存",
    );
  }

  await input.repository.saveWorkflowRunSnapshot({
    accountId: claimed.accountId,
    title: claimed.title,
    season: claimed.season,
    workflowRun: {
      ...claimed.workflowRun,
      status: "succeeded",
      finishedAt: now(),
    },
    episodes: claimed.episodes,
    resourceSnapshots: claimed.resourceSnapshots,
    decisions: claimed.decisions,
    transferAttempts: [attempt],
    notifications: [],
  });
  return { status: "succeeded", workflowRunId: claimed.workflowRun.id };
}

/** Terminal-fail the claimed run. Never leaves it `running` — that would strand the title. */
async function failRun(
  input: { repository: WorkflowRepository },
  claimed: PersistedWorkflowRunSnapshot,
  reason: string,
  message: string,
): Promise<ManualImportWorkerResult> {
  await input.repository.saveWorkflowRunSnapshot({
    accountId: claimed.accountId,
    title: claimed.title,
    season: claimed.season,
    workflowRun: {
      ...claimed.workflowRun,
      status: "failed",
      finishedAt: new Date().toISOString(),
    },
    episodes: [],
    resourceSnapshots: claimed.resourceSnapshots,
    decisions: claimed.decisions,
    transferAttempts: [],
    notifications: [],
  });
  // The copy the user sees. Deliberately does not blame them for a record that went
  // stale in our own queue (see manualImportRejectionCopy).
  void message;
  return { status: reason === "expired" ? "rejected" : "failed", workflowRunId: claimed.workflowRun.id, reason };
}

function manualImportFailureCopy(reason: string): string {
  switch (reason) {
    case "not_found":
      return "这次搜索里找不到该候选，请重新查询";
    case "expired":
      return "搜索结果已超过 30 分钟，请重新查询后再入库";
    default:
      return "快照记录不完整，请重新查询后再入库";
  }
}

/**
 * Canonical target for a manual import: `Title (Year) {tmdb-N}` under the category
 * parent, then `Season NN` for TV. The SAME helpers the acquisition uses, so a
 * manually imported season lands beside an automatically acquired one instead of
 * forking a second folder. A movie goes straight into the title dir.
 */
async function manualImportTargetDirectory(input: {
  storage: StorageExecutor;
  title: PersistedWorkflowRunSnapshot["title"];
  season: PersistedWorkflowRunSnapshot["season"];
  categoryParentDirectoryId: string;
}): Promise<string> {
  const showDirectoryId = await ensureMediaLibraryDirectory({
    executor: input.storage,
    parentId: input.categoryParentDirectoryId,
    title: input.title.title,
    year: input.title.year,
    tmdbId: input.title.tmdbId,
  });
  if (input.title.type === "movie" || input.season === undefined) {
    return showDirectoryId;
  }
  return input.storage.createDirectory({
    name: `Season ${String(input.season.seasonNumber).padStart(2, "0")}`,
    parentId: showDirectoryId,
  });
}

/**
 * Re-check the run's own persisted copy: the decision must name a candidate that is
 * really in the snapshot it names, and the snapshot's window must still be open.
 * The HTTP route validated both before queueing; time then passed in SQLite.
 */
function validateClaimedManualImport(input: {
  claimed: PersistedWorkflowRunSnapshot;
  nowMs: number;
  ttlMs?: number;
}):
  | { kind: "ok"; candidate: ResourceCandidate }
  | { kind: "invalid_run" }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "invalid_snapshot" } {
  const decision = input.claimed.decisions[0];
  const candidateId = decision?.selectedCandidateIds[0];
  const snapshot = input.claimed.resourceSnapshots.find((entry) => entry.id === decision?.snapshotId);
  if (snapshot === undefined || candidateId === undefined) {
    return { kind: "invalid_run" };
  }
  const resolution = resolveManualImportCandidate({
    snapshot,
    candidateId,
    now: input.nowMs,
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  });
  if (resolution.kind === "ok") {
    return { kind: "ok", candidate: resolution.candidate };
  }
  return { kind: resolution.kind };
}

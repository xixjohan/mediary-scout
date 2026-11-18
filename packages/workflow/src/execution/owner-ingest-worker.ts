import { claimNextQueuedRun } from "../persistence/repository.js";
import type { QueueClaimOptions, WorkflowRepository, PersistedWorkflowRunSnapshot } from "../persistence/repository.js";
import { triggerPostIngestSyncIfSucceeded } from "../strm/pinpoint-ingest-sync.js";
import type { StorageExecutor } from "../domain/ports.js";
import { isBrandStorageAuthError } from "../storage/storage-auth-error.js";
import type { AccountWorkerContext, ResolveAccountWorkerContext } from "./worker.js";
import { OWNER_INGEST_KIND } from "./owner-ingest-command.js";
import { MANUAL_IMPORT_TTL_MS, resolveManualImportCandidate } from "./manual-import-resolver.js";
import type { ResourceCandidate, TransferAttempt } from "../domain/domain.js";

/**
 * 站长「关键字投放」的 worker 半边。
 *
 * 三个刻意「不信任上游」的点（与 manual_import 同源，理由一致）：
 *  1. **候选成员与 TTL 再核对一遍**——HTTP 层校验过，但 run 在 SQLite 里等过一段时间；
 *  2. **payload 从库里取回**——候选的分享链/磁力从不过 HTTP（只传不透明 candidateId）；
 *  3. **目标目录用用户选的**——不按身份推算，也不再建 `Title (Year) {tmdb-N}`。
 *     用户既然自己选了目录，worker 的职责就是「往里放，并确认真的放下了」。
 *
 * 与 manual_import 的关键差别：**落盘判定只认 StorageExecutor.transfer 的结论**
 * （分享链看 before/after 目录 diff、磁力看轮询结果）。「提交成功」不是「已入库」。
 */

export interface OwnerIngestWorkerResult {
  status: "idle" | "succeeded" | "failed" | "rejected";
  workflowRunId?: string;
  reason?: string;
  error?: string;
}

function targetDirectoryOf(claimed: PersistedWorkflowRunSnapshot): string | null {
  // 目标目录写在审计事件里（排队那一刻的意图），而不是从提交时的请求读——
  // run 可能来自另一个进程。
  for (let index = claimed.workflowRun.auditEvents.length - 1; index >= 0; index -= 1) {
    const event = claimed.workflowRun.auditEvents[index];
    if (event?.type !== "owner_ingest_queued") continue;
    const target = event.data?.["targetDirectoryId"];
    if (typeof target === "string" && target.length > 0) return target;
  }
  return null;
}

function boundTitleOf(claimed: PersistedWorkflowRunSnapshot): boolean {
  for (const event of claimed.workflowRun.auditEvents) {
    if (event.type === "owner_ingest_queued" && event.data?.["boundTitle"] === true) return true;
  }
  return false;
}

async function notifyFreezeIfBrandAuthError(input: {
  connectedStorageId: string | null | undefined;
  error: unknown;
  onAuthErrorFreeze?: ((storageId: string, reason: string) => Promise<void>) | undefined;
}): Promise<void> {
  const { connectedStorageId, error, onAuthErrorFreeze } = input;
  if (!onAuthErrorFreeze || !connectedStorageId || !isBrandStorageAuthError(error)) return;
  const reason = error instanceof Error ? error.message : String(error);
  try {
    await onAuthErrorFreeze(connectedStorageId, reason);
  } catch (freezeError) {
    console.error(`[owner-ingest] onAuthErrorFreeze failed for ${connectedStorageId}: ${String(freezeError)}`);
  }
}

type OwnerIngestWorkerInput = {
  repository: WorkflowRepository;
  /** 默认账号的 executor；给了 resolveAccountContext 时按 run 的账号覆盖。 */
  storage: StorageExecutor;
  now?: () => string;
  ttlMs?: number;
  resolveAccountContext?: ResolveAccountWorkerContext;
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  claim?: QueueClaimOptions;
};

function failureCopy(error: unknown): string {
  return `投放失败：${error instanceof Error ? error.message : String(error)}`;
}

/** 解析 run 所属账号的 worker 上下文。失败时 freeze 认证错误的盘并终态失败。 */
async function resolveContextOrFail(
  input: OwnerIngestWorkerInput,
  claimed: PersistedWorkflowRunSnapshot,
  now: () => string,
): Promise<{ ok: true; ctx: AccountWorkerContext } | { ok: false; result: OwnerIngestWorkerResult }> {
  try {
    const ctx =
      input.resolveAccountContext === undefined
        ? {}
        : await input.resolveAccountContext(claimed.accountId, claimed.connectedStorageId);
    return { ok: true, ctx };
  } catch (error) {
    await notifyFreezeIfBrandAuthError({
      connectedStorageId: claimed.connectedStorageId,
      error,
      onAuthErrorFreeze: input.onAuthErrorFreeze,
    });
    return { ok: false, result: await failRun(input, claimed, "transfer_error", failureCopy(error), now) };
  }
}

/** 执行转存并落库终态。返回 null 表示成功（已落盘）。 */
async function transferOrFail(
  input: OwnerIngestWorkerInput,
  claimed: PersistedWorkflowRunSnapshot,
  storage: StorageExecutor,
  candidate: ResourceCandidate,
  targetDirectoryId: string,
  now: () => string,
): Promise<{ ok: true; attempt: TransferAttempt } | { ok: false; result: OwnerIngestWorkerResult }> {
  // 用户显式选的目录就是本次投放的授权边界：站长可以投放到影视库之外
  // （例如待整理目录），但授权**只覆盖这一个 id**，执行器随后仍照常做自己的
  // 范围校验。不区分写入范围的品牌没有这只钩子，直接跳过。
  storage.authorizeWriteTarget?.(targetDirectoryId);
  let attempt: TransferAttempt;
  try {
    attempt = await storage.transfer({
      workflowRunId: claimed.workflowRun.id,
      directoryId: targetDirectoryId,
      candidate,
    });
  } catch (error) {
    await notifyFreezeIfBrandAuthError({
      connectedStorageId: claimed.connectedStorageId,
      error,
      onAuthErrorFreeze: input.onAuthErrorFreeze,
    });
    return { ok: false, result: await failRun(input, claimed, "transfer_error", failureCopy(error), now) };
  }
  if (attempt.status !== "succeeded") {
    // 磁力的 accepted_pending / unknown 同样是「尚未落盘」，不是入库成功。
    const copy = attempt.providerMessage.length > 0 ? attempt.providerMessage : "网盘未接受这次投放";
    return { ok: false, result: await failRun(input, claimed, "transfer_failed", copy, now) };
  }
  return { ok: true, attempt };
}

export async function runQueuedOwnerIngest(input: OwnerIngestWorkerInput): Promise<OwnerIngestWorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const claimed = await claimNextQueuedRun(input.repository, OWNER_INGEST_KIND, now(), input.claim);
  if (claimed === null) return { status: "idle" };

  const context = await resolveContextOrFail(input, claimed, now);
  if (!context.ok) return context.result;
  const storage = context.ctx.storage ?? input.storage;

  const validated = validateClaimedOwnerIngest({
    claimed,
    nowMs: Date.parse(now()),
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  });
  if (validated.kind !== "ok") {
    return await failRun(input, claimed, validated.kind, ownerIngestFailureCopy(validated.kind), now);
  }

  // 目标目录来自 run 记录：用户选定的意图，不是外部参数。
  const targetDirectoryId = targetDirectoryOf(claimed);
  if (targetDirectoryId === null) {
    return await failRun(input, claimed, "invalid_run", "投放记录缺少目标目录，请重新提交。", now);
  }

  const transfer = await transferOrFail(input, claimed, storage, validated.candidate, targetDirectoryId, now);
  if (!transfer.ok) return transfer.result;

  const finishedAt = now();
  await input.repository.saveWorkflowRunSnapshot({
    accountId: claimed.accountId,
    ...(claimed.connectedStorageId ? { connectedStorageId: claimed.connectedStorageId } : {}),
    title: claimed.title,
    season: claimed.season,
    workflowRun: {
      ...transitionRun(claimed.workflowRun, "succeeded", finishedAt),
      auditEvents: [
        ...claimed.workflowRun.auditEvents,
        {
          type: "owner_ingest_landed",
          message: "文件已落盘到指定目录",
          data: { targetDirectoryId, fileCount: transfer.attempt.materializedFileIds.length },
        },
      ],
    },
    episodes: claimed.episodes,
    resourceSnapshots: claimed.resourceSnapshots,
    decisions: claimed.decisions,
    transferAttempts: [transfer.attempt],
    notifications: [],
  });

  // 只有「真的绑定了作品」才触发 STRM/媒体服务器联动：合成标题（tmdbId=0）
  // 没有任何媒体服务器条目可对，强行触发只会写一份空 STRM。
  if (boundTitleOf(claimed) && claimed.title.tmdbId > 0) {
    await triggerPostIngestSyncIfSucceeded("succeeded", {
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      repository: input.repository,
      storage,
      title: claimed.title,
      categoryParentId: targetDirectoryId,
      baseUrl: context.ctx.baseUrl,
      mediaServerCoordinator: context.ctx.mediaServerCoordinator,
    });
  }

  return { status: "succeeded", workflowRunId: claimed.workflowRun.id };
}

/** 状态迁移守卫：只有 running 的 run 能进终态（与 manual-import-worker 同一规则）。 */
function transitionRun(
  run: PersistedWorkflowRunSnapshot["workflowRun"],
  nextStatus: "succeeded" | "failed",
  finishedAt: string,
): PersistedWorkflowRunSnapshot["workflowRun"] {
  if (run.status !== "running") {
    throw new Error(`Illegal workflow run state transition: run ${run.id} is '${run.status}', not 'running'`);
  }
  return { ...run, status: nextStatus, finishedAt };
}

async function failRun(
  input: { repository: WorkflowRepository },
  claimed: PersistedWorkflowRunSnapshot,
  reason: string,
  message: string,
  now: () => string,
): Promise<OwnerIngestWorkerResult> {
  // failRun 可能在任何阶段被调用（含 claimed 仍是 running 的正常路径）；若上游
  // 已经把它置成终态（不应发生），保持原状而不是抛错把它留在 running。
  const transitioned =
    claimed.workflowRun.status === "running"
      ? transitionRun(claimed.workflowRun, "failed", now())
      : claimed.workflowRun;
  const failedRun = {
    ...transitioned,
    auditEvents: [
      ...claimed.workflowRun.auditEvents,
      {
        type: "owner_ingest_failed",
        message,
        data: { reason, targetDirectoryId: targetDirectoryOf(claimed) },
      },
    ],
  };
  const base = {
    accountId: claimed.accountId,
    ...(claimed.connectedStorageId ? { connectedStorageId: claimed.connectedStorageId } : {}),
    title: claimed.title,
    season: claimed.season,
    workflowRun: failedRun,
    episodes: claimed.episodes,
    transferAttempts: [],
    notifications: [],
  };

  // 终态写入**绝不允许抛**：`running` 一旦残留就永久持有标题锁，它的后续重试
  // 又会走回这里，形成「每次都抛、永远不终态」的死循环（Dev 3020 实测过：
  // 修复前的 run 引用了一份被主键静默丢弃的快照，validateWorkflowRunSnapshot
  // 每次都拒，drain 每轮失败一次）。
  //
  // 首次按原样写（保住审计链路）；若校验拒绝，退化为「只写终态」——run 的
  // 终态比它的子表完整性更重要。
  try {
    await input.repository.saveWorkflowRunSnapshot({
      ...base,
      resourceSnapshots: claimed.resourceSnapshots,
      decisions: claimed.decisions,
    });
  } catch (error) {
    console.error(
      `[owner-ingest] terminal write rejected for ${claimed.workflowRun.id}, retrying without children: ${String(error)}`,
    );
    await input.repository.saveWorkflowRunSnapshot({
      ...base,
      resourceSnapshots: [],
      decisions: [],
    });
  }
  return {
    status: reason === "expired" ? "rejected" : "failed",
    workflowRunId: claimed.workflowRun.id,
    reason,
    error: message,
  };
}

function validateClaimedOwnerIngest(input: {
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
  if (snapshot === undefined || candidateId === undefined) return { kind: "invalid_run" };
  const resolution = resolveManualImportCandidate({
    snapshot,
    candidateId,
    now: input.nowMs,
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  });
  if (resolution.kind === "ok") return { kind: "ok", candidate: resolution.candidate };
  return { kind: resolution.kind };
}

function ownerIngestFailureCopy(reason: string): string {
  switch (reason) {
    case "not_found":
      return "这次检索里找不到该候选，请重新检索";
    case "expired":
      return "检索结果已超过 30 分钟，请重新检索后再投放";
    default:
      return "投放记录不完整，请重新检索后再投放";
  }
}

export { MANUAL_IMPORT_TTL_MS };

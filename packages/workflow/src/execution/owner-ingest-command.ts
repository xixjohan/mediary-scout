import type { MediaTitle, ResourceSnapshot, TrackedSeason } from "../domain/domain.js";
import type {
  PersistWorkflowRunSnapshotInput,
  WorkflowRepository,
  WorkflowRunReservationResult,
} from "../persistence/repository.js";
import { decisionFromSelection, HumanCandidateSelector, type CandidateSelection } from "./candidate-selector.js";
import { resolveManualImportCandidate } from "./manual-import-resolver.js";

/**
 * 站长「关键字投放」的排队命令。
 *
 * 与 `manual_import` 的差别只有两点，但两点都决定了它必须是一个独立的 kind：
 *
 *  1. **目标目录由用户显式指定**（可视化选目录），不是由 TMDB 身份推算。把
 *     「可选目录」塞进 `manual_import` 会让两种语义混在一个 kind 里，
 *     `blockIfTitleHasActiveRun` 也会让它们互相误伤。
 *  2. **作品身份可缺省**。用户只给关键字时没有 TMDB 作品；此时用一个合成
 *     `MediaTitle`（tmdbId = 0 不会被任何地方当作真实作品去刮削）承载 run 记录，
 *     不进入订阅语义（season status = completed，且 episodes 为空）。
 *
 * 候选 payload 依旧不从 HTTP 传入：它在检索时随快照落到 `resource_snapshots`，
 * 这里只收 candidateId，worker 侧再从库里取回并复核 TTL（与 manual_import 同一个
 * resolver，不复制一套规则）。
 */
export const OWNER_INGEST_KIND = "owner_ingest" as const;

/** 合成标题的 id 前缀。刻意不含 `tmdb_`——`parseTitleId` 只认 `tmdb_*` / `douban_*`，
 *  这样任何把这条记录当真实作品解析的代码都会得到「不认识」，而不是静默当成 tmdb。 */
export function ownerIngestTitleId(input: { storageId: string; keyword: string }): string {
  const clean = input.keyword.trim().toLowerCase().replace(/[\s/]{1,}/g, "_").slice(0, 48);
  return `owner_ingest_${input.storageId}_${clean || "untitled"}`;
}

export function ownerIngestSeasonId(titleId: string): string {
  return `${titleId}_s1`;
}

/** 无作品时用的合成标题。tmdbId=0 是**哨兵**：本仓所有 TMDB 调用都要求
 *  tmdbId > 0，因此它不会被误当作真实作品去刮削或补缺。 */
export function syntheticOwnerIngestTitle(input: { storageId: string; keyword: string }): MediaTitle {
  const keyword = input.keyword.trim();
  return {
    id: ownerIngestTitleId({ storageId: input.storageId, keyword }),
    tmdbId: 0,
    type: "movie",
    title: keyword || "未命名投放",
    originalTitle: keyword || "未命名投放",
    year: 0,
    aliases: [],
  };
}

export function syntheticOwnerIngestSeason(title: MediaTitle, storageDirectoryId: string): TrackedSeason {
  return {
    id: ownerIngestSeasonId(title.id),
    mediaTitleId: title.id,
    seasonNumber: 1,
    // completed 而不是 active：这是一次「已落盘」的记录，不该在订阅墙上以
    // 「追更中 / 缺 N 集」出现——它本来就没有订阅语义。
    status: "completed",
    qualityPreference: "4K",
    storageDirectoryId,
    totalEpisodes: 1,
    latestAiredEpisode: 1,
    latestAiredSource: "manual",
  };
}

/**
 * 把检索快照**按本次投放 run 重新定基**。
 *
 * 为什么必须做：`resource_snapshots.id` 是全局主键，且写入用
 * `ON CONFLICT (id) DO NOTHING`（同一内容可能合法复用）。检索记录已经把快照以
 * `owner_ingest_<searchRunId>` 落库；若投放 run 直接沿用同一个 id，第二条插入
 * 会被静默丢弃 —— 投放 run 的 `resourceSnapshots` 为空，而它的 decision 仍引用
 * 那个 id，`validateWorkflowRunSnapshot` 随后抛
 * 「Agent decision referenced unknown resource snapshot」把 drain 打死。
 *
 * 定基后 snapshot id 与候选 id 都带本次 run，决策引用同步改写；检索记录保持
 * 原样，其余候选仍可各自投放。
 */
export function rebaseOwnerIngestSnapshot(input: {
  snapshot: ResourceSnapshot;
  workflowRunId: string;
  candidateId: string;
}): { snapshot: ResourceSnapshot; candidateId: string } {
  const snapshotId = `${input.snapshot.id}_${input.workflowRunId}`;
  let rebasedCandidateId = input.candidateId;
  const candidates = input.snapshot.candidates.map((candidate, index) => {
    const id = `${snapshotId}_c${index + 1}`;
    if (candidate.id === input.candidateId) rebasedCandidateId = id;
    return { ...candidate, id, snapshotId };
  });
  return {
    snapshot: { ...input.snapshot, id: snapshotId, candidates },
    candidateId: rebasedCandidateId,
  };
}

export interface OwnerIngestRequest {
  accountId: string;
  connectedStorageId: string;
  snapshot: ResourceSnapshot;
  candidateId: string;
  /** 用户选定的落盘目录（显式，不再由身份推算）。 */
  targetDirectoryId: string;
  /** 该目录的可读路径，仅用于审计与 UI 展示。 */
  targetDisplayPath?: string | undefined;
  /** 绑定的真实作品（可选）。缺省 = 合成标题。 */
  title?: MediaTitle | undefined;
  season?: TrackedSeason | undefined;
  now?: () => string;
  ttlMs?: number | undefined;
}

export type OwnerIngestQueueResult =
  | { status: "queued"; workflowRunId: string }
  | { status: "already_running"; workflowRunId: string }
  | { status: "rejected"; reason: "not_found" | "expired" | "invalid_snapshot"; copy: string };

export async function queueOwnerIngest(input: {
  request: OwnerIngestRequest;
  repository: Pick<WorkflowRepository, "reserveWorkflowRun">;
}): Promise<OwnerIngestQueueResult> {
  const workflowRunId = crypto.randomUUID();
  // 先在检索快照上按本次 run 定基：snapshot id 必须与检索记录不同，否则
  // 全局主键会让投放 run 的快照行被静默丢弃（见 rebaseOwnerIngestSnapshot）。
  const rebased = rebaseOwnerIngestSnapshot({
    snapshot: input.request.snapshot,
    workflowRunId,
    candidateId: input.request.candidateId,
  });
  const request: OwnerIngestRequest = {
    ...input.request,
    snapshot: rebased.snapshot,
    candidateId: rebased.candidateId,
  };
  const resolution = resolveManualImportCandidate({
    snapshot: request.snapshot,
    candidateId: request.candidateId,
    now: Date.parse(request.now?.() ?? new Date().toISOString()),
    ...(request.ttlMs === undefined ? {} : { ttlMs: request.ttlMs }),
  });
  if (resolution.kind !== "ok") {
    return {
      status: "rejected",
      reason: resolution.kind,
      copy:
        resolution.kind === "expired"
          ? "这次检索已超过 30 分钟，候选已失效。请重新检索后再投放。"
          : "这个候选不属于本次检索，可能已失效。请重新检索。",
    };
  }

  const queuedAt = (request.now ?? (() => new Date().toISOString()))();
  const title = request.title ?? syntheticOwnerIngestTitle({ storageId: request.connectedStorageId, keyword: request.snapshot.keyword });
  const season =
    request.season ?? syntheticOwnerIngestSeason(title, request.targetDirectoryId);

  const selection = new HumanCandidateSelector(request.candidateId).select({ snapshot: request.snapshot });
  if (selection.selectedCandidateIds.length === 0) {
    return { status: "rejected", reason: "not_found", copy: "这个候选不属于本次检索，可能已失效。请重新检索。" };
  }

  const reservation = buildOwnerIngestReservation({
    request,
    title,
    season,
    snapshot: request.snapshot,
    selection,
    workflowRunId,
    queuedAt,
  });
  const result: WorkflowRunReservationResult = await input.repository.reserveWorkflowRun(reservation);
  if (result.status === "already_active") {
    return { status: "already_running", workflowRunId: result.snapshot.workflowRun.id };
  }
  if (result.status !== "reserved") {
    // not_tracked 是 owner_ingest 的正常路径（合成标题没有 tracked_seasons 记录）：
    // 它已被豁免（见 reservationRequiresTrackedSeason），走到这里说明是别的拒绝。
    return { status: "rejected", reason: "not_found", copy: "无法为本次投放建立任务记录，请重试。" };
  }
  return { status: "queued", workflowRunId };
}

export function buildOwnerIngestReservation(input: {
  request: OwnerIngestRequest;
  title: MediaTitle;
  season: TrackedSeason;
  snapshot: ResourceSnapshot;
  selection: CandidateSelection;
  workflowRunId: string;
  queuedAt: string;
}): PersistWorkflowRunSnapshotInput & { blockIfTitleHasActiveRun?: boolean } {
  const { request } = input;
  return {
    accountId: request.accountId,
    connectedStorageId: request.connectedStorageId,
    title: input.title,
    season: input.season,
    workflowRun: {
      id: input.workflowRunId,
      kind: OWNER_INGEST_KIND,
      status: "queued",
      trackedSeasonId: input.season.id,
      startedAt: input.queuedAt,
      finishedAt: null,
      auditEvents: [
        {
          type: "owner_ingest_queued",
          message: `Queued owner ingest ${input.workflowRunId}`,
          data: {
            candidateId: request.candidateId,
            targetDirectoryId: request.targetDirectoryId,
            ...(request.targetDisplayPath === undefined ? {} : { targetDisplayPath: request.targetDisplayPath }),
            boundTitle: request.title !== undefined,
          },
        },
      ],
    },
    episodes: [],
    resourceSnapshots: [input.snapshot],
    decisions: [
      decisionFromSelection({
        selection: input.selection,
        snapshot: input.snapshot,
        source: "human",
        node: "owner_ingest",
      }),
    ],
    transferAttempts: [],
    notifications: [],
    // 同 manual_import：两次并发投放会在同一目录上互相覆盖，标题级互斥必须成立。
    blockIfTitleHasActiveRun: true,
    keepCurrentEpisodes: true,
  };
}

import { createHash } from "node:crypto";
import {
  CooldownLimiter,
  ownerIngestSeasonId,
  ownerIngestTitleId,
  resourceSearchRunId,
  searchBackendsKey,
  syntheticOwnerIngestSeason,
  syntheticOwnerIngestTitle,
  toCandidateViews,
  type MediaTitle,
  type ResourceCandidateView,
  type ResourceProvider,
  type ResourceSnapshot,
  type SearchBackend,
  type WorkflowRepository,
} from "@media-track/workflow";
import { normalizeSearchKeyword } from "@media-track/workflow";
import { applyAcquisitionFilters } from "@media-track/workflow";

/**
 * 站长「关键字投放」的检索侧：纯关键字、无 TMDB 身份的条目。
 *
 * 与 `/api/titles/resources` 的关系：那一端点的关键词是**从作品身份推导**的
 * （`buildTitleSearchKeywords`），并要求 tmdbId。本需求正好相反——用户只给
 * 关键字。底层的 `ResourceProvider.search({keyword})` 本身不关心身份，所以这里
 * 直接复用它，只补三件它没做的事：
 *
 *  1. **冷却键**：现有 limiter 按 `(accountId, titleId)`；没有 titleId 就等于
 *     没有锁。这里改用 `(accountId, 后端组合, 归一化关键字)`，防止连点把 PanSou
 *     打爆（它每实例只有 2 个并发槽）。后端组合必须进键：不同源返回的候选集合
 *     不同，共用一把键会让「换个源再搜」直接命中原源的缓存。
 *  2. **快照落库**：候选 payload（分享链/磁力）从不过 HTTP；提交时 worker 要从
 *     库里取回。落库挂在 `resource_search` 记录上——该 kind 已被豁免
 *     requireTrackedSeason，且不会污染订阅墙。
 *  3. **snapshotId 唯一性**：PanSou 的快照 id 是内容哈希，两次相同检索会撞
 *     `resource_snapshots.id` 全局主键（`ON CONFLICT DO NOTHING` 静默丢第二份）。
 *     这里显式把本次检索的 runId 混进 id，两次相同检索各得一份。
 */

/** 30 分钟：与 manual_import 的候选窗口一致。 */
export const OWNER_INGEST_TTL_MS = 30 * 60 * 1000;
/** 60 秒：同一关键字的重复检索冷却。 */
export const OWNER_INGEST_COOLDOWN_MS = 60 * 1000;

export const ownerIngestLimiter = new CooldownLimiter({
  now: () => Date.now(),
  cooldownMs: OWNER_INGEST_COOLDOWN_MS,
});

export function ownerIngestCooldownKey(accountId: string, keyword: string, backends: readonly SearchBackend[] = []): string {
  return `owner_ingest|${accountId}|${searchBackendsKey(backends)}|${normalizeSearchKeyword(keyword)}`;
}

/** 检索记录的 run id。提交端点用同一个推导，两边不可能漂移。 */
export function ownerIngestSearchRunId(searchRunId: string): string {
  return `owner_ingest_search_${searchRunId}`;
}

export function ownerIngestSnapshotId(searchRunId: string): string {
  return `owner_ingest_${searchRunId}`;
}

export interface OwnerIngestSearchResult {
  searchRunId: string;
  keyword: string;
  candidates: ResourceCandidateView[];
  cached: boolean;
  /** 本次实际生效的后端（空数组 = 账号已配置的全部）。 */
  backends: SearchBackend[];
  sourceHealth?: unknown;
}

/** 一个「可以选的」检索后端：装配层根据账号配置 + 目标盘品牌给出。 */
export interface SearchBackendView {
  backend: SearchBackend;
  label: string;
  /** 已配置且该盘可用 → true；可用但未配置 → false（UI 置灰并给出提示）。 */
  configured: boolean;
}

export type OwnerIngestSearchOutcome =
  | { kind: "ok"; result: OwnerIngestSearchResult }
  | { kind: "throttled"; retryAfterMs: number }
  | { kind: "error"; message: string };

/** 进程内缓存：同 (account, keyword) 30 分钟内重复检索直接命中。与
 *  `/api/titles/resources` 的 TitleResourceCache 同构，但键是关键字。 */
const keywordCache = new Map<string, { at: number; searchRunId: string; candidates: ResourceCandidateView[] }>();

export function _resetOwnerIngestCacheForTests(): void {
  keywordCache.clear();
}

/**
 * 只按关键字检索。**不构造任何 TMDB 作品身份**。
 *
 * `filterPreferences` 与普通检索共用同一套排毒过滤（负面词、诱饵容器、大小下限），
 * 否则站长面板会看到用户面板看不到的垃圾条目。
 */
export async function searchOwnerIngestCandidates(input: {
  accountId: string;
  storageId: string;
  keyword: string;
  provider: ResourceProvider;
  repository: WorkflowRepository;
  /** 本次选择的检索后端（空 = 账号已配置的全部）。只进冷却/缓存键。 */
  backends?: readonly SearchBackend[] | undefined;
  filterPreferences?: Parameters<typeof applyAcquisitionFilters>[1] | undefined;
  now?: () => string;
}): Promise<OwnerIngestSearchOutcome> {
  const keyword = input.keyword.trim();
  if (keyword.length === 0) return { kind: "error", message: "请输入检索关键词" };
  if (keyword.length > 64) return { kind: "error", message: "关键词过长（最多 64 个字符）" };

  const backends = input.backends ?? [];
  const cooldownKey = ownerIngestCooldownKey(input.accountId, keyword, backends);
  const cacheKey = cooldownKey;
  const nowMs = Date.parse((input.now ?? (() => new Date().toISOString()))());

  const cached = keywordCache.get(cacheKey);
  if (cached !== undefined && nowMs - cached.at < OWNER_INGEST_TTL_MS) {
    return {
      kind: "ok",
      result: {
        searchRunId: cached.searchRunId,
        keyword,
        candidates: cached.candidates,
        cached: true,
        backends: [...backends],
      },
    };
  }

  // 缓存未命中才消耗冷却额度：刷新页面/回看上次结果不该被罚 60 秒。
  if (!ownerIngestLimiter.tryAcquire(cooldownKey)) {
    return { kind: "throttled", retryAfterMs: ownerIngestLimiter.remainingMs(cooldownKey) };
  }

  const searchRunId = `${input.accountId}_${createHash("sha1").update(`${keyword}|${nowMs}|${Math.random()}`).digest("hex").slice(0, 12)}`;
  const snapshotId = ownerIngestSnapshotId(searchRunId);

  let snapshot: ResourceSnapshot;
  try {
    const raw = await input.provider.search({ keyword, workflowRunId: searchRunId });
    snapshot = {
      ...raw,
      // 覆盖 provider 的内容哈希 id：两次相同检索必须是两份独立快照，
      // 否则第二份在 `resource_snapshots.id` 全局主键上被静默丢弃。
      id: snapshotId,
      keyword,
      candidates: raw.candidates.map((candidate, index) => ({
        ...candidate,
        snapshotId,
        id: `${snapshotId}_c${index + 1}`,
      })),
    };
  } catch (error) {
    // 源故障不该让站长被罚 60 秒冷却。
    ownerIngestLimiter.reset(cooldownKey);
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }

  const views = input.filterPreferences
    ? applyAcquisitionFilters(toCandidateViews(snapshot.candidates), input.filterPreferences).passed
    : toCandidateViews(snapshot.candidates);

  await persistOwnerIngestSearchRecord({
    repository: input.repository,
    accountId: input.accountId,
    storageId: input.storageId,
    snapshot,
    searchRunId,
    now: (input.now ?? (() => new Date().toISOString()))(),
  });

  if (views.length > 0) {
    keywordCache.set(cacheKey, { at: nowMs, searchRunId, candidates: views });
  }
  // 空结果也可能是源故障；上面已经区分了（只有抛错才 reset）。
  return {
    kind: "ok",
    result: {
      searchRunId,
      keyword,
      candidates: views,
      cached: false,
      backends: [...backends],
      ...(snapshot.sourceHealth ? { sourceHealth: snapshot.sourceHealth } : {}),
    },
  };
}

/**
 * 把检索快照落库，供提交时取回候选 payload。
 *
 * 挂在一个 `resource_search` run 上（该 kind 不污染订阅墙、被豁免
 * requireTrackedSeason），标题/季用合成的占位——它们只是 run 记录的外壳。
 */
async function persistOwnerIngestSearchRecord(input: {
  repository: WorkflowRepository;
  accountId: string;
  storageId: string;
  snapshot: ResourceSnapshot;
  searchRunId: string;
  now: string;
}): Promise<void> {
  const title: MediaTitle = syntheticOwnerIngestTitle({
    storageId: input.storageId,
    keyword: input.snapshot.keyword,
  });
  const season = syntheticOwnerIngestSeason(title, "");

  await input.repository.saveWorkflowRunSnapshot({
    accountId: input.accountId,
    connectedStorageId: input.storageId,
    title,
    season,
    workflowRun: {
      id: ownerIngestSearchRunId(input.searchRunId),
      kind: "resource_search",
      status: "succeeded",
      trackedSeasonId: season.id,
      startedAt: input.now,
      finishedAt: input.now,
      auditEvents: [
        {
          type: "owner_ingest_search",
          message: `Keyword search: ${input.snapshot.keyword}`,
          data: { keyword: input.snapshot.keyword, storageId: input.storageId },
        },
      ],
    },
    episodes: [],
    resourceSnapshots: [input.snapshot],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

/** 提交时用同一推导取回检索记录。 */
export async function loadOwnerIngestSnapshot(input: {
  repository: WorkflowRepository;
  accountId: string;
  connectedStorageId: string;
  searchRunId: string;
}): Promise<ResourceSnapshot | null> {
  const record = await input.repository.getWorkflowRunSnapshot(
    ownerIngestSearchRunId(input.searchRunId),
    input.accountId,
  );
  if (record === null) return null;
  if (record.connectedStorageId !== null && record.connectedStorageId !== input.connectedStorageId) return null;
  const snapshotId = ownerIngestSnapshotId(input.searchRunId);
  return record.resourceSnapshots.find((entry) => entry.id === snapshotId) ?? null;
}

export { resourceSearchRunId, ownerIngestTitleId, ownerIngestSeasonId };

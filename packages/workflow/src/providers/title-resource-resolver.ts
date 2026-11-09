import { CooldownLimiter } from "./cooldown-limiter.js";
import type { ResourceCandidate, ResourceSnapshot } from "../domain/domain.js";
import type { MergedSourceHealth } from "../domain/resource-source-health.js";
import { toCandidateViews, type ResourceCandidateView } from "./resource-candidate-view.js";
import { TitleResourceCache } from "./title-resource-cache.js";
import { buildMergedSearchSnapshot } from "./merged-search-snapshot.js";
import type { AcquisitionFilterPreferences } from "@media-track/contracts";
import { applyAcquisitionFilters } from "../execution/acquisition-filter-pipeline.js";

/**
 * Decision core for `POST /api/titles/resources` (W2).
 *
 * Kept free of Next.js/HTTP so the security-relevant decisions are unit-testable:
 * scope fail-closed, the 60s cooldown, the 30-minute TTL, and the payload boundary.
 * The route handler is a thin adapter over `resolveTitleResources`.
 *
 * Three independent gates, in this order — and the order matters:
 *
 *  1. SCOPE (fail-closed). No resolved account ⇒ unauthorized. This endpoint exposes
 *     resource-search capability, so it may not run unauthenticated (plan §3.2).
 *  2. COOLDOWN (60s). Per (account, title). A user-triggered search spends the same
 *     indexer/drive budget the background agent does.
 *  3. TTL CACHE (30 min). Per (account, title). A hit returns the SAME candidateIds,
 *     which is what makes the later manual-import path able to trust them.
 *
 * The keyword is built server-side from the title (plan §3.2: 「不让用户手打关键词」)
 * and passed in; this function never invents one.
 */

/** How the search is performed. Injected so tests never touch a real indexer. */
export type TitleSearchFn = (input: { keyword: string }) => Promise<ResourceSnapshot>;

export interface TitleResourceProgressEvent {
  newCandidates: ResourceCandidateView[];
  allCandidates: ResourceCandidateView[];
  progress: { done: number; total: number; currentKeyword: string };
}

export interface TitleResourceDeps {
  accountId: string | null;
  titleId: string;
  /** Server-built keyword(s) for this title. Never user-supplied. */
  keywords: readonly string[];
  search: TitleSearchFn;
  cache: TitleResourceCache<ResourceCandidateView>;
  limiter: CooldownLimiter;
  /** Resolves candidates for a cached hit (re-reads the stored snapshot). */
  loadCachedCandidates: (candidateIds: readonly string[]) => Promise<ResourceCandidate[]>;
  /** Optional suffix for cache key (e.g. hash of custom keyword) so custom queries don't collide. */
  cacheKeySuffix?: string | undefined;
  /** Optional streaming chunk callback for progressive candidate emission. */
  onChunk?: ((event: TitleResourceProgressEvent) => void) | undefined;
  /** 可选的资源排毒与过滤偏好配置 */
  filterPreferences?: AcquisitionFilterPreferences | undefined;
}

export type TitleResourceResult =
  | { kind: "unauthorized" }
  | { kind: "throttled"; retryAfterMs: number }
  | { kind: "error"; message: string }
  | {
      kind: "ok";
      candidates: ResourceCandidateView[];
      cached: boolean;
      snapshot: ResourceSnapshot | null;
      /** Authoritative snapshotId for manual import (present on both cache miss and cache hit). */
      snapshotId?: string | undefined;
      sourceHealth?: MergedSourceHealth | undefined;
    };

export async function resolveTitleResources(deps: TitleResourceDeps): Promise<TitleResourceResult> {
  // 1) Scope. Null/empty account ⇒ fail closed, before any budget is spent.
  if (deps.accountId === null || deps.accountId.length === 0) {
    return { kind: "unauthorized" };
  }

  const baseKey = TitleResourceCache.key(deps.accountId, deps.titleId);
  const scopeKey = deps.cacheKeySuffix ? `${baseKey}:${deps.cacheKeySuffix}` : baseKey;

  // 2) Cache (30 min TTL). Checked before cooldown so fresh cached hits never consume
  // rate-limiting budget and never reject legitimate page reloads or tab switches with 429.
  const cached = deps.cache.get(scopeKey);
  if (cached !== null) {
    // No snapshot on a cache hit: the merged snapshot was persisted on the miss that
    // filled this cache, and the DB copy is the one import reads. Re-deriving one here
    // would need the per-keyword snapshots, which this process no longer holds.
    // However, we preserve the snapshotId from the miss so manual import remains functional!
    const cachedSnapshotId = deps.cache.getSnapshotId(scopeKey);
    return {
      kind: "ok",
      candidates: [...cached],
      cached: true,
      snapshot: null,
      ...(cachedSnapshotId === undefined ? {} : { snapshotId: cachedSnapshotId }),
      sourceHealth: { status: "healthy", unhealthySources: [] },
    };
  }

  // 3) Cooldown (60s). Only enforced on cache misses that actually spend indexer / drive budget.
  if (!deps.limiter.tryAcquire(baseKey)) {
    return { kind: "throttled", retryAfterMs: deps.limiter.remainingMs(baseKey) };
  }

  try {
    // Deduped by candidateId across the ladder. Content-hashing providers (PanSou)
    // hand the SAME id to identical results, so a resource found via both the bare
    // title and the original title would otherwise appear twice.
    // Concurrent resolution yields fast progressive chunks without blocking.
    const byId = new Map<string, ResourceCandidateView>();
    const perKeyword: ResourceSnapshot[] = [];
    let done = 0;
    const total = deps.keywords.length;

    await Promise.all(
      deps.keywords.map(async (keyword) => {
        const snapshot = await deps.search({ keyword });
        perKeyword.push(snapshot);
        const newCandidates: ResourceCandidateView[] = [];
        for (const view of toCandidateViews(snapshot.candidates)) {
          if (!byId.has(view.candidateId)) {
            byId.set(view.candidateId, view);
            newCandidates.push(view);
          }
        }
        done += 1;
        if (deps.onChunk) {
          deps.onChunk({
            newCandidates,
            allCandidates: [...byId.values()],
            progress: { done, total, currentKeyword: keyword },
          });
        }
      }),
    );
    const rawViews = [...byId.values()];
    const views = deps.filterPreferences
      ? applyAcquisitionFilters(rawViews, deps.filterPreferences).passed
      : rawViews;
    // The ONE snapshot the user actually saw: the ladder produced several, but the
    // panel shows the deduped list, and the import path's "does this candidate belong
    // to this snapshot?" check needs exactly one snapshot to answer against.
    const snapshot = buildMergedSearchSnapshot({
      id: `search_${deps.accountId}_${deps.titleId}_${Date.now()}`,
      provider: "merged",
      keywords: deps.keywords,
      snapshots: perKeyword,
      createdAt: new Date().toISOString(),
    });
    // 只有查到有效候选时才存入 30 分钟缓存。空结果（尤其是源故障、网络断链或暂无资源）绝不缓存 30 分钟，
    // 避免产生「一次查空、半小时死锁」的缓存毒化事故。
    if (views.length > 0) {
      deps.cache.put(scopeKey, views, snapshot.id);
    }
    // 若因检索源故障（unreachable / protocol_error）导致结果为空，退还冷却额度，避免用户因后端故障被罚 60s 冷却
    if (
      views.length === 0 &&
      (snapshot.sourceHealth?.status === "unreachable" || snapshot.sourceHealth?.status === "protocol_error")
    ) {
      deps.limiter.reset(baseKey);
    }
    return {
      kind: "ok",
      candidates: views,
      cached: false,
      snapshot,
      snapshotId: snapshot.id,
      ...(snapshot.sourceHealth ? { sourceHealth: snapshot.sourceHealth } : {}),
    };
  } catch (error) {
    // A failed search must not leave the user throttled for the next 60s — they did
    // not get a result, so charging them the cooldown would punish them for our error.
    deps.limiter.reset(baseKey);
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolve candidates for a cache hit. Separate from the resolver because the cache
 * stores VIEWS (the response body) while the stored snapshot is where the real
 * candidates live — a cache hit must re-read them rather than trust the map.
 */
export async function loadCachedCandidatesByIds(
  candidates: readonly ResourceCandidate[],
  candidateIds: readonly string[],
): Promise<ResourceCandidate[]> {
  const wanted = new Set(candidateIds);
  return candidates.filter((candidate) => wanted.has(candidate.id));
}

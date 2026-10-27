import { CooldownLimiter } from "./cooldown-limiter.js";
import type { ResourceCandidate, ResourceSnapshot } from "./domain.js";
import { toCandidateViews, type ResourceCandidateView } from "./resource-candidate-view.js";
import { TitleResourceCache } from "./title-resource-cache.js";

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
}

export type TitleResourceResult =
  | { kind: "unauthorized" }
  | { kind: "throttled"; retryAfterMs: number }
  | { kind: "error"; message: string }
  | { kind: "ok"; candidates: ResourceCandidateView[]; cached: boolean };

export async function resolveTitleResources(deps: TitleResourceDeps): Promise<TitleResourceResult> {
  // 1) Scope. Null/empty account ⇒ fail closed, before any budget is spent.
  if (deps.accountId === null || deps.accountId.length === 0) {
    return { kind: "unauthorized" };
  }

  const scopeKey = TitleResourceCache.key(deps.accountId, deps.titleId);

  // 2) Cooldown. Checked before the cache so a throttled user cannot probe the
  // cache for free — and so a throttled response still reports a useful delay.
  if (!deps.limiter.tryAcquire(scopeKey)) {
    return { kind: "throttled", retryAfterMs: deps.limiter.remainingMs(scopeKey) };
  }

  // 3) Cache.
  const cached = deps.cache.get(scopeKey);
  if (cached !== null) {
    return { kind: "ok", candidates: [...cached], cached: true };
  }

  try {
    // Deduped by candidateId across the ladder. Content-hashing providers (PanSou)
    // hand the SAME id to identical results, so a resource found via both the bare
    // title and the original title would otherwise appear twice — the panel would
    // show the user the same link three times, which reads as three distinct options.
    const byId = new Map<string, ResourceCandidateView>();
    for (const keyword of deps.keywords) {
      const snapshot = await deps.search({ keyword });
      for (const view of toCandidateViews(snapshot.candidates)) {
        if (!byId.has(view.candidateId)) byId.set(view.candidateId, view);
      }
    }
    const views = [...byId.values()];
    deps.cache.put(scopeKey, views);
    return { kind: "ok", candidates: views, cached: false };
  } catch (error) {
    // A failed search must not leave the user throttled for the next 60s — they did
    // not get a result, so charging them the cooldown would punish them for our error.
    deps.limiter.reset(scopeKey);
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

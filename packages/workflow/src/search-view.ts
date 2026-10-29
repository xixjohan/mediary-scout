import { normalizePageSize } from "./pagination-window.js";
import { isMovieUnreleased } from "./domain.js";
import type { EpisodeState, MediaType, TrackedSeason, WorkflowKind } from "./domain.js";
import type { MediaSource } from "./media-identity.js";
import type { WorkflowRepository } from "./repository.js";
import { normalizeScope, type ScopeArg } from "./workflow-scope.js";

export type SearchPageState = "empty" | "ready" | "provider_error";
export type SearchCacheStatus = "none" | "hit" | "miss";
export type SearchActionState =
  | "can_request"
  | "already_tracked"
  | "active_workflow"
  /** An unreleased movie: offer 预定 (reserve) instead of 获取 (acquire). */
  | "can_reserve"
  /** A reserved unreleased movie already tracked, waiting for its release. */
  | "reserved";

export interface MediaSearchSeason {
  seasonNumber: number;
  episodeCount: number;
  latestAiredEpisode: number;
}

export interface MediaSearchCandidate {
  tmdbId: number;
  mediaType: Extract<MediaType, "movie" | "tv">;
  title: string;
  originalTitle: string;
  year: number;
  /** Movie release date (YYYY-MM-DD) — gates 预定 (reserve) vs 获取 (acquire). */
  releaseDate?: string | null;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  seasons: MediaSearchSeason[];
  genreIds?: number[];
  voteAverage?: number;
  source?: MediaSource | undefined;
}

export interface MediaSearchProvider {
  searchMedia(input: {
    query: string;
    page?: number | undefined;
    pageSize?: number | undefined;
  }): Promise<MediaSearchCandidate[]>;
  searchMediaPage?(input: {
    query: string;
    page?: number | undefined;
    pageSize?: number | undefined;
  }): Promise<{
    candidates: MediaSearchCandidate[];
    page: number;
    totalPages: number;
    totalResults: number;
    source: MediaSource;
  }>;
}

export interface MediaSearchCache {
  get(query: string): Promise<MediaSearchCandidate[] | null>;
  set(query: string, candidates: MediaSearchCandidate[]): Promise<void>;
}

/**
 * 通用持久化 JSON 缓存端口：命名空间键 + 每条目 TTL。
 * 由 SqliteJsonCache（纯 SQLite 实现，sqlite-json-cache.ts）承载；
 * 语义契约：过期即未命中（懒删）、读写返回克隆。
 */
export interface DurableJsonCache {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlMs?: number): Promise<void>;
}

/**
 * Remembers which real title a DESCRIBED query resolved to, so a re-render does
 * not pay for the resolution again. This matters concretely: the search page
 * mounts the acquisition poller, which re-renders the results server-side every
 * five seconds — without this, one typed description would bill a web search and
 * a model call every five seconds for the whole run.
 *
 * A cached EMPTY result is meaningful too ("this description resolves to
 * nothing"), so it records a miss instead of re-asking.
 */
export interface SearchQueryInterpretation {
  /** The title that was eventually searched, or null when nothing resolved. */
  title: string | null;
}

export interface SearchInterpretationCache {
  get(query: string): Promise<SearchQueryInterpretation | null>;
  set(query: string, value: SearchQueryInterpretation): Promise<void>;
}

export interface SearchCandidateAction {
  state: SearchActionState;
  label: string;
  disabled: boolean;
  workflowRunId: string | null;
}

export interface SearchCandidateCard {
  id: string;
  tmdbId: number;
  mediaType: MediaSearchCandidate["mediaType"];
  title: string;
  originalTitle: string;
  year: number;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  selectedSeasonNumber: number | null;
  totalEpisodes: number | null;
  latestAiredEpisode: number | null;
  /** All known seasons of the title (tv), for per-season request entries. */
  seasonNumbers: number[];
  genreIds?: number[];
  voteAverage?: number;
  source?: MediaSource | undefined;
  action: SearchCandidateAction;
}

export interface SearchPageView {
  query: string;
  state: SearchPageState;
  cacheStatus: SearchCacheStatus;
  candidates: SearchCandidateCard[];
  page?: number | undefined;
  pageSize?: number | undefined;
  totalPages?: number | undefined;
  totalResults?: number | undefined;
  source?: MediaSource | undefined;
  /** Set when the typed query was a description (or carried an unofficial
   *  season/arc name) and a real title was found instead — the UI says which. */
  interpretedQuery?: string;
  /** Only when state === "provider_error": the underlying provider failure, for
   *  a diagnostic line in the UI and the reporter's issue. */
  providerError?: string;
}

export class InMemoryMediaSearchCache implements MediaSearchCache {
  private readonly values = new Map<string, MediaSearchCandidate[]>();

  async get(query: string): Promise<MediaSearchCandidate[] | null> {
    const value = this.values.get(normalizeSearchQuery(query));
    return value ? structuredClone(value) : null;
  }

  async set(query: string, candidates: MediaSearchCandidate[]): Promise<void> {
    this.values.set(normalizeSearchQuery(query), structuredClone(candidates));
  }
}

/** In-memory twin of SearchInterpretationCache (demo / tests). */
export class InMemorySearchInterpretationCache implements SearchInterpretationCache {
  private readonly values = new Map<string, SearchQueryInterpretation>();

  async get(query: string): Promise<SearchQueryInterpretation | null> {
    return this.values.get(normalizeSearchQuery(query)) ?? null;
  }

  async set(query: string, value: SearchQueryInterpretation): Promise<void> {
    this.values.set(normalizeSearchQuery(query), value);
  }
}

/**
 * Serialise resolution per query inside one process. Two renders racing on the
 * same description must not each pay for a web search + model call; the second
 * one waits for the first and reuses its answer.
 */
const inflightInterpretations = new Map<string, Promise<SearchQueryInterpretation>>();

async function resolveOnce(
  query: string,
  input: Parameters<typeof getSearchPageView>[0],
): Promise<SearchQueryInterpretation> {
  const key = normalizeSearchQuery(query);
  const pending = inflightInterpretations.get(key);
  if (pending) return pending;

  const run = (async (): Promise<SearchQueryInterpretation> => {
    const cached = await input.interpretations?.get(key).catch(() => null);
    if (cached) return cached;
    let resolverFailed = false;
    const titles = await input.resolveTitles!(key).catch(() => {
      resolverFailed = true;
      return [];
    });
    let hadLookupError = false;
    for (const candidateTitle of titles) {
      const normalized = normalizeSearchQuery(candidateTitle);
      if (!normalized || normalized === key) continue;
      const found = await safeSearch(input, normalized);
      if (found === null) {
        hadLookupError = true;
        continue;
      }
      if (found.length > 0) {
        const hit: SearchQueryInterpretation = { title: candidateTitle };
        await input.interpretations?.set(key, hit).catch(() => {});
        return hit;
      }
    }
    const miss: SearchQueryInterpretation = { title: null };
    if (!resolverFailed && !hadLookupError) {
      await input.interpretations?.set(key, miss).catch(() => {});
    }
    return miss;
  })();

  inflightInterpretations.set(key, run);
  try {
    return await run;
  } finally {
    inflightInterpretations.delete(key);
  }
}

interface CandidatePoolResult {
  candidates: MediaSearchCandidate[];
  cached: boolean;
  totalPages?: number | undefined;
  totalResults?: number | undefined;
  source?: MediaSource | undefined;
  providerError?: string | undefined;
}

async function loadCandidatePool(
  input: Parameters<typeof getSearchPageView>[0],
  query: string,
  page: number,
  pageSize: number,
  cacheKey: string,
): Promise<CandidatePoolResult> {
  let cached = await input.cache.get(cacheKey);
  if (!cached && page === 1) {
    cached = await input.cache.get(query);
  }
  if (cached) return { candidates: cached, cached: true };

  try {
    if (input.provider.searchMediaPage) {
      const res = await input.provider.searchMediaPage({ query, page, pageSize });
      await input.cache.set(cacheKey, res.candidates);
      return {
        candidates: res.candidates,
        cached: false,
        totalPages: res.totalPages,
        totalResults: res.totalResults,
        source: res.source,
      };
    }
    const fresh = await input.provider.searchMedia({ query, page, pageSize });
    await input.cache.set(cacheKey, fresh);
    return { candidates: fresh, cached: false };
  } catch (error) {
    if (input.fallbackProvider) {
      try {
        if (input.fallbackProvider.searchMediaPage) {
          const fbRes = await input.fallbackProvider.searchMediaPage({ query, page, pageSize });
          await input.cache.set(cacheKey, fbRes.candidates);
          return {
            candidates: fbRes.candidates,
            cached: false,
            totalPages: fbRes.totalPages,
            totalResults: fbRes.totalResults,
            source: fbRes.source,
          };
        }
        const fallbackRes = await input.fallbackProvider.searchMedia({ query, page, pageSize });
        await input.cache.set(cacheKey, fallbackRes);
        return { candidates: fallbackRes, cached: false };
      } catch {
        // ignore
      }
    }
    return { candidates: [], cached: false, providerError: describeError(error) };
  }
}

async function resolveEmptyCandidates(
  query: string,
  page: number,
  pageSize: number,
  input: Parameters<typeof getSearchPageView>[0],
): Promise<{
  candidates: MediaSearchCandidate[];
  interpretedQuery?: string | undefined;
  totalPages?: number | undefined;
  totalResults?: number | undefined;
  source?: MediaSource | undefined;
}> {
  const interpreted = await interpretUnfoundQuery(query, input);
  if (interpreted) {
    const found = await safeSearch(input, interpreted);
    if (found && found.length > 0) {
      return { candidates: found, interpretedQuery: interpreted };
    }
  }

  if (input.fallbackProvider) {
    try {
      if (input.fallbackProvider.searchMediaPage) {
        const fbRes = await input.fallbackProvider.searchMediaPage({ query, page, pageSize });
        return {
          candidates: fbRes.candidates,
          totalPages: fbRes.totalPages,
          totalResults: fbRes.totalResults,
          source: fbRes.source,
        };
      }
      const fb = await input.fallbackProvider.searchMedia({ query, page, pageSize });
      return { candidates: fb };
    } catch {
      // ignore
    }
  }

  return { candidates: [] };
}

async function resolveSearchResults(
  pool: CandidatePoolResult,
  query: string,
  page: number,
  pageSize: number,
  input: Parameters<typeof getSearchPageView>[0],
) {
  if (pool.candidates.length > 0) {
    return {
      candidates: pool.candidates,
      interpretedQuery: undefined as string | undefined,
      fallbackMeta: undefined as
        | { totalPages?: number | undefined; totalResults?: number | undefined; source?: MediaSource | undefined }
        | undefined,
    };
  }
  const resolved = await resolveEmptyCandidates(query, page, pageSize, input);
  return {
    candidates: resolved.candidates,
    interpretedQuery: resolved.interpretedQuery,
    fallbackMeta: {
      totalPages: resolved.totalPages,
      totalResults: resolved.totalResults,
      source: resolved.source,
    },
  };
}

function calculateSearchPageMeta(
  candidates: MediaSearchCandidate[],
  page: number,
  pageSize: number,
  pool: CandidatePoolResult,
  fallbackMeta?: {
    totalPages?: number | undefined;
    totalResults?: number | undefined;
    source?: MediaSource | undefined;
  } | undefined,
): { source: MediaSource; totalPages: number; totalResults: number } {
  let source: MediaSource = "tmdb";
  if (fallbackMeta?.source) {
    source = fallbackMeta.source;
  } else if (pool.source) {
    source = pool.source;
  } else {
    for (const c of candidates) {
      if (c.source === "douban") {
        source = "douban";
        break;
      }
    }
  }

  let totalResults = (page - 1) * pageSize + candidates.length;
  if (fallbackMeta?.totalResults !== undefined) {
    totalResults = fallbackMeta.totalResults;
  } else if (pool.totalResults !== undefined) {
    totalResults = pool.totalResults;
  } else if (candidates.length >= pageSize) {
    totalResults = page * pageSize + 1;
  }

  let totalPages = Math.max(1, Math.ceil(totalResults / pageSize));
  if (fallbackMeta?.totalPages && totalResults === 0) {
    totalPages = fallbackMeta.totalPages;
  } else if (pool.totalPages && totalResults === 0) {
    totalPages = pool.totalPages;
  }

  return { source, totalPages, totalResults };
}

export async function getSearchPageView(input: {
  query: string;
  page?: number | undefined;
  pageSize?: number | undefined;
  provider: MediaSearchProvider;
  fallbackProvider?: MediaSearchProvider | undefined;
  cache: MediaSearchCache;
  repository: WorkflowRepository;
  /** Clock for the movie reserve air-time gate (预定 vs 获取). */
  now?: () => string;
  /** Tree model: the active workspace (account, drive). A movie's 已获取/获取
   *  state is per-drive — obtained on drive A must still be 获取-able on drive B.
   *  Undefined = account-wide (legacy / single-drive). */
  scope?: ScopeArg;
  /** "I don't remember the name" fallback: when the keyword search finds nothing,
   *  turn the description into real titles and search again. Best-effort — an
   *  absent resolver or a failure simply leaves the empty result. */
  resolveTitles?: (query: string) => Promise<string[]>;
  /** Remembers description → title (including "resolved to nothing") so a
   *  re-render does not pay for the resolution again. */
  interpretations?: SearchInterpretationCache;
}): Promise<SearchPageView> {
  const now = input.now ?? (() => new Date().toISOString());
  const query = normalizeSearchQuery(input.query);
  const page = Math.max(1, input.page ?? 1);
  const pageSize = normalizePageSize(input.pageSize);
  if (!query) {
    return {
      query,
      state: "empty",
      cacheStatus: "none",
      candidates: [],
      page,
      pageSize,
      totalPages: 1,
      totalResults: 0,
    };
  }

  const cacheKey = `${query}:p${page}:s${pageSize}`;
  const pool = await loadCandidatePool(input, query, page, pageSize, cacheKey);
  if (pool.providerError && pool.candidates.length === 0) {
    return {
      query,
      state: "provider_error",
      cacheStatus: "miss",
      candidates: [],
      page,
      pageSize,
      totalPages: 1,
      totalResults: 0,
      providerError: pool.providerError,
    };
  }

  const { candidates, interpretedQuery, fallbackMeta } = await resolveSearchResults(
    pool,
    query,
    page,
    pageSize,
    input,
  );
  const { source, totalPages, totalResults } = calculateSearchPageMeta(
    candidates,
    page,
    pageSize,
    pool,
    fallbackMeta,
  );

  return {
    query,
    state: "ready",
    cacheStatus: pool.cached ? "hit" : "miss",
    page,
    pageSize,
    totalPages,
    totalResults,
    source,
    ...(interpretedQuery === undefined ? {} : { interpretedQuery }),
    candidates: await Promise.all(
      candidates.map((candidate) => toCandidateCard(candidate, input.repository, now(), input.scope)),
    ),
  };
}

/** Keyword search through the provider + cache; null when the provider throws. */
async function safeSearch(
  input: Parameters<typeof getSearchPageView>[0],
  query: string,
): Promise<MediaSearchCandidate[] | null> {
  const normalized = normalizeSearchQuery(query);
  try {
    const cached = await input.cache.get(normalized);
    if (cached) return cached;
    const found = await input.provider.searchMedia({ query: normalized });
    await input.cache.set(normalized, found);
    return found;
  } catch {
    return null;
  }
}

/**
 * Turn an unfound query into a real, searchable title — or null.
 *
 * Order: the free deterministic suffix strip first (covers most cases), then the
 * paid description resolution. Either way the conclusion is remembered, so a
 * repeated render re-uses it instead of paying again.
 */
async function interpretUnfoundQuery(
  query: string,
  input: Parameters<typeof getSearchPageView>[0],
): Promise<string | null> {
  const cached = await input.interpretations?.get(query).catch(() => null);
  if (cached) return cached.title;

  const stripped = stripSeasonMarkers(query);
  if (stripped) {
    const found = await safeSearch(input, stripped);
    if (found && found.length > 0) {
      await input.interpretations?.set(query, { title: stripped }).catch(() => {});
      return stripped;
    }
  }

  if (!input.resolveTitles) {
    // Do not write { title: null } when no model was configured: if the user
    // later configures a BYO model in Settings, the query must be allowed to
    // resolve instead of being stuck on a cached false negative.
    return null;
  }

  const interpretation = await resolveOnce(query, input);
  return interpretation.title;
}

function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

/**
 * Drop a trailing season / part marker so "咒术回战 第三季" and "庆余年 第二季"
 * still reach their series. Deterministic and free — it runs before any model
 * call, because these suffixes are the single most common way a title search
 * returns nothing. Returns null when there is nothing to strip.
 */
export function stripSeasonMarkers(query: string): string | null {
  const stripped = query
    .replace(/\s*(?:第\s*[0-9一二三四五六七八九十百]+\s*[季部篇]|season\s*\d+|s\d{1,2})\s*$/iu, "")
    .replace(/\s*(?:上|下|中)\s*篇\s*$/u, "")
    .replace(/\s*(?:final\s*season|完结篇|剧场版)\s*$/iu, "")
    .trim();
  return stripped.length > 0 && stripped !== query.trim() ? stripped : null;
}

/** The diagnostic line must stay readable for ANY throw shape: bare String()
 *  renders non-Error objects as "[object Object]". */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

async function toCandidateCard(
  candidate: MediaSearchCandidate,
  repository: WorkflowRepository,
  now: string,
  scope?: ScopeArg,
): Promise<SearchCandidateCard> {
  // The search card is SEASON-AGNOSTIC for a TV show: it never pre-picks a
  // season. The user chooses one (or all remaining) via SeasonRequestMenu, and
  // that choice — not a card default — flows to the agent and the canonical
  // `Season N` landing dir. Per-season tracked state is surfaced by the UI from
  // listTrackedSeasonStates, so the card carries no season-specific identity,
  // counts, or action (those were vestigial and misleading for multi-season
  // shows). A movie is the only single-anchor case whose card-level action
  // gates its one button.
  const source = candidate.source ?? "tmdb";
  return {
    id: mediaTitleId(candidate.mediaType, candidate.tmdbId, source),
    tmdbId: candidate.tmdbId,
    source,
    mediaType: candidate.mediaType,
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    overview: candidate.overview,
    posterPath: candidate.posterPath,
    backdropPath: candidate.backdropPath,
    selectedSeasonNumber: null,
    totalEpisodes: null,
    latestAiredEpisode: null,
    seasonNumbers:
      candidate.mediaType === "tv"
        ? candidate.seasons.map((season) => season.seasonNumber).sort((a, b) => a - b)
        : [],
    ...(candidate.genreIds && candidate.genreIds.length > 0 ? { genreIds: candidate.genreIds } : {}),
    ...(candidate.voteAverage !== undefined ? { voteAverage: candidate.voteAverage } : {}),
    action:
      candidate.mediaType === "movie"
        ? // A movie tracks as a degenerate one-"episode" anchor season; once it
          // is acquired (or acquiring) it must NOT be re-requestable in search.
          // An UNRELEASED film offers 预定 (reserve) instead of 获取 (acquire).
          await actionForTrackedSeason(
            repository,
            movieTrackedSeasonId(candidate.tmdbId, source),
            "movie_init",
            { releaseDate: candidate.releaseDate, now },
            scope,
          )
        : canRequestAction(),
  };
}

async function actionForTrackedSeason(
  repository: WorkflowRepository,
  trackedSeasonIdValue: string,
  kind: WorkflowKind,
  // Movie reserve air-time gate: an unreleased film offers 预定 instead of 获取.
  reserveGate?: { releaseDate: string | null | undefined; now: string },
  // Tree model: scope the obtained/active-run check to the active drive so a
  // movie obtained on another drive stays 获取-able here.
  scope?: ScopeArg,
): Promise<SearchCandidateAction> {
  const scoped = scope === undefined ? undefined : normalizeScope(scope);
  const activeRun = await repository.findActiveWorkflowRun({
    trackedSeasonId: trackedSeasonIdValue,
    kind,
    ...(scoped ? { accountId: scoped.accountId, connectedStorageId: scoped.connectedStorageId } : {}),
  });
  if (activeRun) {
    return {
      state: "active_workflow",
      label: "获取中",
      disabled: true,
      workflowRunId: activeRun.workflowRun.id,
    };
  }

  const unreleased = reserveGate ? isMovieUnreleased(reserveGate.releaseDate, reserveGate.now) : false;
  const state = await repository.getTrackedSeasonState(trackedSeasonIdValue, scope);
  if (!state || state.episodes.length === 0) {
    // Not tracked yet: an unreleased film is reservable (预定), not acquirable.
    return unreleased ? reserveAction() : canRequestAction();
  }
  // Tracked. A reserved-but-not-yet-acquired film whose release is still in the
  // future reads as 已预定 (the daily patrol collects it the moment it releases) —
  // keyed on the real acquisition signal (the anchor obtained flag), NOT on
  // isFullyAcquired, which a finished-season/unaired-anchor reserve trips falsely.
  // Otherwise, situation-aware wording: a one-off film / finished season fully in
  // hand is DONE → "已获取"; a still-airing season or real gaps is "已追踪".
  const obtained = state.episodes.some((episode) => episode.obtained);
  if (unreleased && !obtained) {
    return reservedAction();
  }
  return {
    state: "already_tracked",
    label: isFullyAcquired(state) ? "已获取" : "已追踪",
    disabled: true,
    workflowRunId: null,
  };
}

function isFullyAcquired(state: { season: TrackedSeason; episodes: EpisodeState[] }): boolean {
  const finished = state.season.latestAiredEpisode >= state.season.totalEpisodes;
  const airedMissing = state.episodes.some(
    (episode) => episode.airStatus === "aired" && !episode.obtained,
  );
  return finished && !airedMissing;
}

function canRequestAction(): SearchCandidateAction {
  return {
    state: "can_request",
    label: "获取",
    disabled: false,
    workflowRunId: null,
  };
}

/** Untracked unreleased movie → a 预定 (reserve) button. */
function reserveAction(): SearchCandidateAction {
  return {
    state: "can_reserve",
    label: "预定",
    disabled: false,
    workflowRunId: null,
  };
}

/** Reserved unreleased movie (tracked, awaiting release) → 已预定. */
function reservedAction(): SearchCandidateAction {
  return {
    state: "reserved",
    label: "已预定",
    disabled: true,
    workflowRunId: null,
  };
}

function mediaTitleId(
  mediaType: MediaSearchCandidate["mediaType"],
  tmdbId: number,
  source: MediaSource = "tmdb",
): string {
  return `${source}_${mediaType}_${tmdbId}`;
}

function trackedSeasonId(tmdbId: number, seasonNumber: number, source: MediaSource = "tmdb"): string {
  return `${mediaTitleId("tv", tmdbId, source)}_s${seasonNumber}`;
}

function movieTrackedSeasonId(tmdbId: number, source: MediaSource = "tmdb"): string {
  return `${mediaTitleId("movie", tmdbId, source)}_movie`;
}

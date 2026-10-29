import { fetchTmdbList, calculatePageWindow, normalizePageSize } from "@media-track/workflow";
import { getTmdbAccesses, getAccountScopedSettings, getCurrentAccountId } from "./workflow-runtime";
import {
  TMDB_GENRE_MAP,
  matchesItemGenre,
  matchesItemType,
  matchesItemYear,
  sortItems,
} from "./media-filters";

export type TrendingKind = "movie" | "tv" | "anime";

export interface TrendingCard {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  mediaType: "movie" | "tv";
  genreIds?: number[];
  overview?: string;
  voteAverage?: number;
}

export interface DiscoverFilterParams {
  type?: string | undefined;
  genre?: string | undefined;
  year?: string | undefined;
  sort?: string | undefined;
  trending?: TrendingKind | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

/** The three discovery feeds, aligned to the app's 电影/剧集/动漫 library types.
 *  path + query MUST match workers/tmdb-proxy TRENDING_FEEDS so the proxy serves
 *  the Cron-warmed KV entry (cacheKey = path + sorted query). */
export const TRENDING_KINDS: Record<
  TrendingKind,
  { label: string; path: string; query: Record<string, string>; mediaType: "movie" | "tv" }
> = {
  movie: { label: "热门电影", path: "trending/movie/week", query: { language: "zh-CN" }, mediaType: "movie" },
  tv: { label: "热门剧集", path: "trending/tv/week", query: { language: "zh-CN" }, mediaType: "tv" },
  anime: {
    label: "热门动漫",
    path: "discover/tv",
    query: {
      include_adult: "false",
      language: "zh-CN",
      sort_by: "popularity.desc",
      "vote_count.gte": "50",
      with_genres: "16",
      with_original_language: "ja",
    },
    mediaType: "tv",
  },
};

export const TRENDING_KIND_ORDER: TrendingKind[] = ["movie", "tv", "anime"];

/** Last-calendar-year floor (rolls yearly): the anime feed shows RECENT seasons,
 *  not TMDB's all-time-popularity classics (全职猎人1999/死神2004…). MUST match
 *  workers/tmdb-proxy handler.ts animeFirstAirDateFloor. */
export function animeFirstAirDateFloor(now: Date = new Date()): string {
  return `${now.getUTCFullYear() - 1}-01-01`;
}

/** The query for a feed, with the rolling first_air_date.gte injected for anime.
 *  MUST match workers/tmdb-proxy getTrendingFeeds for the same `now` — cacheKeyFor
 *  sorts params, so the param SET (not order) is the contract. */
export function trendingFeedQuery(kind: TrendingKind, now: Date = new Date()): Record<string, string> {
  const query = { ...TRENDING_KINDS[kind].query };
  if (kind === "anime") {
    query["first_air_date.gte"] = animeFirstAirDateFloor(now);
  }
  return query;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function yearOf(value: unknown): number | null {
  if (typeof value !== "string" || value.length < 4) return null;
  const year = Number(value.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

function extractCard(item: unknown, mediaType: "movie" | "tv"): TrendingCard | null {
  if (!isRecord(item)) return null;
  const tmdbId = typeof item.id === "number" ? item.id : null;
  const title =
    typeof item.title === "string" ? item.title : typeof item.name === "string" ? item.name : null;
  if (tmdbId === null || !title) return null;

  const poster = typeof item.poster_path === "string" ? item.poster_path : null;
  const card: TrendingCard = {
    tmdbId,
    title,
    year: yearOf(item.release_date) ?? yearOf(item.first_air_date),
    posterPath: poster,
    mediaType,
  };
  if (Array.isArray(item.genre_ids)) {
    const gids = item.genre_ids.filter((id): id is number => typeof id === "number" && Number.isFinite(id));
    if (gids.length > 0) card.genreIds = gids;
  }
  if (typeof item.overview === "string" && item.overview.trim()) {
    card.overview = item.overview.trim();
  }
  if (typeof item.vote_average === "number" && Number.isFinite(item.vote_average)) {
    card.voteAverage = item.vote_average;
  }
  return card;
}

/** Pure: TMDB list body → cards. Tolerates movie(title/release_date) and
 *  tv(name/first_air_date); drops idless/titleless rows; [] on any bad shape. */
export function mapTrendingResults(raw: unknown, kind: TrendingKind): TrendingCard[] {
  const results = isRecord(raw) && Array.isArray(raw.results) ? raw.results : [];
  const mediaType = TRENDING_KINDS[kind].mediaType;
  const cards: TrendingCard[] = [];
  for (const item of results) {
    const card = extractCard(item, mediaType);
    if (card) cards.push(card);
  }
  return cards;
}

export async function fetchFeedCards(
  accesses: unknown,
  kind: TrendingKind,
  page = 1,
): Promise<TrendingCard[]> {
  try {
    const query = trendingFeedQuery(kind);
    if (page > 1) {
      query.page = String(page);
    }
    const raw = await fetchTmdbList(
      accesses as Parameters<typeof fetchTmdbList>[0],
      TRENDING_KINDS[kind].path,
      query,
    );
    return mapTrendingResults(raw, kind);
  } catch {
    return [];
  }
}

/** Fetch + map one feed. Any failure → [] (silent degrade; the row hides and the
 *  search page falls back to its original empty state). Never throws. */
export async function getTrending(kind: TrendingKind): Promise<TrendingCard[]> {
  try {
    const accesses = await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId()));
    const cards = await fetchFeedCards(accesses, kind);
    return cards.slice(0, 12);
  } catch {
    return [];
  }
}

function interleaveFeeds(feeds: TrendingCard[][]): TrendingCard[] {
  const seen = new Set<string>();
  const merged: TrendingCard[] = [];
  const maxLen = Math.max(...feeds.map((f) => f.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const list of feeds) {
      const item = list[i];
      if (item) {
        const key = `${item.mediaType}_${item.tmdbId}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(item);
        }
      }
    }
  }
  return merged;
}

function applyYearRange(query: Record<string, string>, mediaType: "movie" | "tv", year: string): void {
  const gteKey = mediaType === "movie" ? "primary_release_date.gte" : "first_air_date.gte";
  const lteKey = mediaType === "movie" ? "primary_release_date.lte" : "first_air_date.lte";
  const yearKey = mediaType === "movie" ? "primary_release_year" : "first_air_date_year";

  if (year === "2020s") {
    query[gteKey] = "2020-01-01";
    query[lteKey] = "2029-12-31";
  } else if (year === "2010s") {
    query[gteKey] = "2010-01-01";
    query[lteKey] = "2019-12-31";
  } else {
    query[yearKey] = year;
  }
}

function applySortOption(
  query: Record<string, string>,
  mediaType: "movie" | "tv",
  sort?: string,
): void {
  if (sort === "rating") {
    query["sort_by"] = "vote_average.desc";
    query["vote_count.gte"] = mediaType === "movie" ? "100" : "50";
  } else if (sort === "release") {
    query["sort_by"] = mediaType === "movie" ? "primary_release_date.desc" : "first_air_date.desc";
  } else {
    query["sort_by"] = "popularity.desc";
  }
}

function resolveGenreQuery(
  mediaType: "movie" | "tv",
  params?: DiscoverFilterParams,
): string | undefined {
  const ids: number[] = [];
  if (params?.type === "documentary") {
    ids.push(99);
  } else if (params?.type === "variety" && mediaType === "tv") {
    ids.push(10764, 10767);
  } else if (params?.type === "anime" && mediaType === "tv") {
    ids.push(16);
  }
  if (params?.genre && params.genre !== "all") {
    const genreIds = TMDB_GENRE_MAP[params.genre];
    if (genreIds) {
      ids.push(...genreIds);
    }
  }
  return ids.length > 0 ? Array.from(new Set(ids)).join("|") : undefined;
}

export function buildDiscoverQuery(
  mediaType: "movie" | "tv",
  params?: DiscoverFilterParams,
): Record<string, string> {
  const query: Record<string, string> = {
    language: "zh-CN",
    include_adult: "false",
  };

  applySortOption(query, mediaType, params?.sort);

  if (params?.page && params.page > 1) {
    query["page"] = String(params.page);
  }

  const withGenres = resolveGenreQuery(mediaType, params);
  if (withGenres) {
    query["with_genres"] = withGenres;
  }

  if (params?.type === "anime" && mediaType === "tv") {
    query["with_original_language"] = "ja";
  }

  if (params?.year && params.year !== "all") {
    applyYearRange(query, mediaType, params.year);
  }

  return query;
}

export async function fetchDiscoverCards(
  accesses: unknown,
  mediaType: "movie" | "tv",
  params?: DiscoverFilterParams,
): Promise<TrendingCard[]> {
  try {
    const path = mediaType === "movie" ? "discover/movie" : "discover/tv";
    const page = params?.page ?? 1;
    const pageSize = normalizePageSize(params?.pageSize);
    const { startPage, endPage, sliceStart, sliceEnd } = calculatePageWindow(page, pageSize, 20);

    const pageNumbers: number[] = [];
    for (let p = startPage; p <= endPage; p++) {
      pageNumbers.push(p);
    }

    const responses = await Promise.all(
      pageNumbers.map((p) => {
        const query = buildDiscoverQuery(mediaType, { ...params, page: p });
        return fetchTmdbList(accesses as Parameters<typeof fetchTmdbList>[0], path, query);
      }),
    );

    const allCards = responses.flatMap((raw) =>
      mapTrendingResults(raw, mediaType === "movie" ? "movie" : "tv"),
    );

    return allCards.slice(sliceStart, sliceEnd);
  } catch {
    return [];
  }
}

function hasDynamicFilter(params?: DiscoverFilterParams): boolean {
  if (!params) return false;
  return (
    (Boolean(params.year) && params.year !== "all") ||
    (Boolean(params.genre) && params.genre !== "all") ||
    (Boolean(params.sort) && params.sort !== "popularity")
  );
}

function shouldServeTrendingOnly(params?: DiscoverFilterParams): boolean {
  if (!params) return false;
  if (params.type && params.type !== "all") return false;
  if (params.genre && params.genre !== "all") return false;
  if (params.year && params.year !== "all") return false;
  if (params.sort && params.sort !== "popularity") return false;
  return params.trending === "tv" || params.trending === "anime";
}

function shouldUseDiscoverFeed(filterParams?: DiscoverFilterParams): boolean {
  if (hasDynamicFilter(filterParams)) return true;
  const page = filterParams?.page ?? 1;
  const pageSize = normalizePageSize(filterParams?.pageSize);
  return page > 1 || pageSize > 20;
}

async function fetchMediaFeed(
  accesses: unknown,
  mediaType: "movie" | "tv",
  filterParams?: DiscoverFilterParams,
): Promise<TrendingCard[]> {
  if (shouldUseDiscoverFeed(filterParams)) {
    return fetchDiscoverCards(accesses, mediaType, filterParams);
  }
  return fetchFeedCards(accesses, mediaType, filterParams?.page ?? 1);
}

async function fetchTypedFeedCards(
  accesses: unknown,
  filterParams?: DiscoverFilterParams,
): Promise<TrendingCard[] | null> {
  const type = filterParams?.type;
  if (!type || type === "all") return null;

  if (type === "documentary") {
    const [movieCards, tvCards] = await Promise.all([
      fetchDiscoverCards(accesses, "movie", filterParams),
      fetchDiscoverCards(accesses, "tv", filterParams),
    ]);
    return interleaveFeeds([movieCards, tvCards]);
  }
  if (type === "variety" || type === "anime") {
    return fetchDiscoverCards(accesses, "tv", filterParams);
  }
  if (type === "movie" || type === "tv") {
    return fetchMediaFeed(accesses, type, filterParams);
  }
  return null;
}

async function fetchRawFeedPool(
  accesses: unknown,
  filterParams?: DiscoverFilterParams,
): Promise<TrendingCard[]> {
  const typedCards = await fetchTypedFeedCards(accesses, filterParams);
  if (typedCards !== null) {
    return typedCards;
  }

  const page = filterParams?.page ?? 1;

  if (hasDynamicFilter(filterParams)) {
    const [movieCards, tvCards] = await Promise.all([
      fetchDiscoverCards(accesses, "movie", filterParams),
      fetchDiscoverCards(accesses, "tv", filterParams),
    ]);
    return interleaveFeeds([movieCards, tvCards]);
  }

  if (shouldServeTrendingOnly(filterParams) && filterParams?.trending) {
    return fetchFeedCards(accesses, filterParams.trending, page);
  }

  const [movieCards, tvCards, animeCards] = await Promise.all([
    fetchFeedCards(accesses, "movie", page),
    fetchFeedCards(accesses, "tv", page),
    fetchFeedCards(accesses, "anime", page),
  ]);
  return interleaveFeeds([movieCards, tvCards, animeCards]);
}

/**
 * 复合发现流（Discover Feed）：当搜索词为空时，根据用户在 MediaFilterBar 中选中的
 * 类型（电影/剧集/动漫/纪录片/综艺）、题材（科幻/悬疑/动作等）、年代与排序维度，
 * 从 TMDB 预热推荐流中多路召回、精准过滤与高分重排。
 */
export async function getDiscoverFeed(
  filterParams?: DiscoverFilterParams,
  doubanMap?: Map<string, { score: number }>,
): Promise<TrendingCard[]> {
  try {
    const accesses = await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId()));
    const rawCards = await fetchRawFeedPool(accesses, filterParams);
    const filtered = rawCards.filter((card) => {
      if (filterParams?.type && !matchesItemType(card, filterParams.type)) return false;
      if (filterParams?.genre && !matchesItemGenre(card, filterParams.genre)) return false;
      if (filterParams?.year && !matchesItemYear(card, filterParams.year)) return false;
      return true;
    });

    const pageSize = normalizePageSize(filterParams?.pageSize);
    return sortItems(filtered, filterParams?.sort, doubanMap).slice(0, pageSize);
  } catch {
    return [];
  }
}

import type { SearchCandidateCard } from "@media-track/workflow";

/**
 * 影视多类型多标签复合筛选标准字典与纯函数逻辑
 */

export const MEDIA_TYPES = [
  { id: "all", label: "全部" },
  { id: "movie", label: "电影" },
  { id: "tv", label: "剧集" },
  { id: "anime", label: "动漫" },
  { id: "documentary", label: "纪录片" },
  { id: "variety", label: "综艺" },
] as const;

export const GENRE_TAGS = [
  { id: "all", label: "全部题材" },
  { id: "scifi", label: "科幻" },
  { id: "mystery", label: "悬疑" },
  { id: "action", label: "动作" },
  { id: "comedy", label: "喜剧" },
  { id: "romance", label: "爱情" },
  { id: "crime", label: "犯罪" },
  { id: "animation", label: "动画" },
  { id: "fantasy", label: "奇幻" },
  { id: "adventure", label: "冒险" },
  { id: "thriller", label: "惊悚" },
] as const;

export const YEAR_TAGS = [
  { id: "all", label: "全部年份" },
  { id: "2026", label: "2026" },
  { id: "2025", label: "2025" },
  { id: "2024", label: "2024" },
  { id: "2023", label: "2023" },
  { id: "2020s", label: "2020年代" },
  { id: "2010s", label: "2010年代" },
] as const;

export const SORT_OPTIONS = [
  { id: "popularity", label: "热门流行" },
  { id: "rating", label: "高分优先" },
  { id: "release", label: "最新上映" },
] as const;

export interface MediaFilterValues {
  type: string;
  genre: string;
  year: string;
  sort: string;
}

export const TMDB_GENRE_MAP: Record<string, number[]> = {
  scifi: [878, 10765],
  mystery: [9648],
  action: [28, 10759],
  comedy: [35],
  romance: [10749],
  crime: [80],
  animation: [16],
  fantasy: [14, 10765],
  adventure: [12, 10759],
  thriller: [53, 27],
};

export const GENRE_KEYWORDS: Record<string, string[]> = {
  scifi: ["科幻", "sci-fi", "science fiction", "太空", "未来", "星际", "外星"],
  mystery: ["悬疑", "mystery", "推理", "解谜", "侦探"],
  action: ["动作", "action", "打斗", "热血", "武侠", "功夫"],
  comedy: ["喜剧", "comedy", "搞笑", "幽默", "爆笑"],
  romance: ["爱情", "romance", "恋爱", "言情", "偶像"],
  crime: ["犯罪", "crime", "刑侦", "警匪", "黑帮", "卧底"],
  animation: ["动画", "animation", "动漫", "二次元"],
  fantasy: ["奇幻", "fantasy", "魔幻", "仙侠", "修仙", "玄幻"],
  adventure: ["冒险", "adventure", "探险"],
  thriller: ["惊悚", "恐怖", "thriller", "horror"],
};

export interface FilterableMediaItem {
  title: string;
  year: number | null;
  mediaType: "movie" | "tv";
  overview?: string;
  genreIds?: number[];
  voteAverage?: number;
}

export function isAnimeItem(item: FilterableMediaItem): boolean {
  if (item.genreIds?.includes(16)) return true;
  const text = `${item.title} ${item.overview ?? ""}`.toLowerCase();
  if (/动画|动漫|anime|二次元/.test(text)) return true;
  return /[\u3040-\u309F\u30A0-\u30FF]/.test(item.title);
}

export function isDocumentaryItem(item: FilterableMediaItem): boolean {
  if (item.genreIds?.includes(99)) return true;
  const text = `${item.title} ${item.overview ?? ""}`.toLowerCase();
  return /纪录片|纪录|documentary/.test(text);
}

export function isVarietyItem(item: FilterableMediaItem): boolean {
  if (item.genreIds?.some((id) => id === 10764 || id === 10767)) return true;
  const text = `${item.title} ${item.overview ?? ""}`.toLowerCase();
  return /综艺|真人秀|脱口秀|晚会|选秀/.test(text);
}

export function matchesItemType(item: FilterableMediaItem, type: string): boolean {
  if (!type || type === "all") return true;
  if (type === "anime") return isAnimeItem(item);
  if (type === "documentary") return isDocumentaryItem(item);
  if (type === "variety") return isVarietyItem(item);
  if (type === "movie") return item.mediaType === "movie";
  if (type === "tv") return item.mediaType === "tv";
  return true;
}

export function matchesItemGenre(item: FilterableMediaItem, genreKey: string): boolean {
  if (!genreKey || genreKey === "all") return true;
  const targetIds = TMDB_GENRE_MAP[genreKey];
  if (targetIds && item.genreIds && item.genreIds.length > 0) {
    if (item.genreIds.some((id) => targetIds.includes(id))) {
      return true;
    }
  }
  const keywords = GENRE_KEYWORDS[genreKey];
  if (!keywords || keywords.length === 0) return true;
  const text = `${item.title} ${item.overview ?? ""}`.toLowerCase();
  return keywords.some((kw) => text.includes(kw));
}

export function matchesItemYear(item: { year: number | null }, yearParam: string): boolean {
  if (!yearParam || yearParam === "all") return true;
  if (item.year === null) return false;
  if (yearParam === "2020s") return item.year >= 2020 && item.year < 2030;
  if (yearParam === "2010s") return item.year >= 2010 && item.year < 2020;
  const num = Number(yearParam);
  return Number.isFinite(num) ? item.year === num : true;
}

function getItemScore(item: FilterableMediaItem, doubanMap?: Map<string, { score: number }>): number {
  if (doubanMap) {
    const douban = doubanMap.get(`${item.title}_${item.year ?? ""}`);
    if (douban && douban.score > 0) return douban.score;
  }
  return item.voteAverage ?? 0;
}

export function sortItems<T extends FilterableMediaItem>(
  items: T[],
  sortOption?: string,
  doubanMap?: Map<string, { score: number }>,
): T[] {
  if (!sortOption || sortOption === "popularity") {
    return items;
  }
  const copy = [...items];
  if (sortOption === "release") {
    copy.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    return copy;
  }
  if (sortOption === "rating") {
    copy.sort((a, b) => {
      const scoreA = getItemScore(a, doubanMap);
      const scoreB = getItemScore(b, doubanMap);
      return scoreB - scoreA;
    });
    return copy;
  }
  return copy;
}

export function applyCandidateFilters(
  candidates: readonly SearchCandidateCard[],
  filterParams?: { type?: string; genre?: string; year?: string; sort?: string },
  doubanMap?: Map<string, { score: number }>,
): SearchCandidateCard[] {
  if (!filterParams) return [...candidates];
  const list = candidates.filter((c) => {
    if (filterParams.type && !matchesItemType(c, filterParams.type)) return false;
    if (filterParams.genre && !matchesItemGenre(c, filterParams.genre)) return false;
    if (filterParams.year && !matchesItemYear(c, filterParams.year)) return false;
    return true;
  });
  return sortItems(list, filterParams.sort, doubanMap);
}

function appendQueryParam(sp: URLSearchParams, key: string, value?: string, defaultValue = "all"): void {
  if (value && value !== defaultValue) {
    sp.set(key, value);
  }
}

function resolveTrendingParam(q?: string, updateType?: string, currentTrending?: string): string | undefined {
  if (q?.trim()) return undefined;
  if (updateType === "movie" || updateType === "tv" || updateType === "anime") {
    return updateType;
  }
  if (updateType === "all" || updateType === "documentary" || updateType === "variety") {
    return undefined;
  }
  return currentTrending;
}

export function buildFilterHref(
  basePath: string,
  current: {
    q?: string | undefined;
    type?: string | undefined;
    genre?: string | undefined;
    year?: string | undefined;
    sort?: string | undefined;
    trending?: string | undefined;
  },
  updates: Partial<{ type: string; genre: string; year: string; sort: string }>,
): string {
  const merged = { ...current, ...updates };
  const sp = new URLSearchParams();

  if (merged.q?.trim()) {
    sp.set("q", merged.q.trim());
  }

  appendQueryParam(sp, "type", merged.type);
  appendQueryParam(sp, "genre", merged.genre);
  appendQueryParam(sp, "year", merged.year);
  appendQueryParam(sp, "sort", merged.sort, "popularity");

  const trending = resolveTrendingParam(merged.q, updates.type, merged.trending);
  if (trending) {
    sp.set("trending", trending);
  }

  const queryStr = sp.toString();
  return queryStr ? `${basePath}?${queryStr}` : basePath;
}

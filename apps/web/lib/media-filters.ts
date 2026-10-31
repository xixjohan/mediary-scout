import type { SearchCandidateCard } from "@media-track/workflow";

/**
 * 影视多类型多标签复合筛选标准字典与纯函数逻辑
 *
 * 采用设计模式：
 *  - 策略模式 (Strategy Pattern)：解耦各维度（类型、题材、地区、年代、排序）的上游构建与本地过滤逻辑
 *  - 适配器模式 (Adapter Pattern)：统一适配 Movie/TV 差异与 TMDB 协议参数
 *  - 状态机模式 (State Machine Pattern)：保障维度参数平滑归一化与 URL 序列化
 */

export const MEDIA_TYPES = [
  { id: "all", label: "全部" },
  { id: "movie", label: "电影" },
  { id: "tv", label: "剧集" },
  { id: "anime", label: "动漫" },
  { id: "documentary", label: "纪录片" },
  { id: "variety", label: "综艺" },
] as const;

export const COUNTRY_TAGS = [
  { id: "all", label: "全部地区" },
  { id: "cn", label: "华语/大陆" },
  { id: "hk", label: "中国香港" },
  { id: "tw", label: "中国台湾" },
  { id: "jp", label: "日本" },
  { id: "kr", label: "韩国" },
  { id: "us", label: "美国" },
  { id: "eu", label: "欧洲/英国" },
  { id: "other", label: "其它" },
] as const;

export const GENRE_TAGS = [
  { id: "all", label: "全部题材" },
  { id: "drama", label: "剧情" },
  { id: "scifi", label: "科幻" },
  { id: "mystery", label: "悬疑" },
  { id: "action", label: "动作" },
  { id: "comedy", label: "喜剧" },
  { id: "romance", label: "爱情" },
  { id: "crime", label: "犯罪" },
  { id: "horror", label: "恐怖" },
  { id: "war", label: "战争" },
  { id: "history", label: "历史" },
  { id: "wuxia", label: "武侠修仙" },
  { id: "animation", label: "动画" },
  { id: "fantasy", label: "奇幻" },
  { id: "adventure", label: "冒险" },
  { id: "thriller", label: "惊悚" },
  { id: "music", label: "音乐" },
] as const;

export const YEAR_TAGS = [
  { id: "all", label: "全部年份" },
  { id: "2026", label: "2026" },
  { id: "2025", label: "2025" },
  { id: "2024", label: "2024" },
  { id: "2023", label: "2023" },
  { id: "2022", label: "2022" },
  { id: "2021", label: "2021" },
  { id: "2020s", label: "2020年代" },
  { id: "2010s", label: "2010年代" },
  { id: "2000s", label: "2000年代" },
  { id: "90s", label: "90年代" },
  { id: "80s", label: "80年代及更早" },
] as const;

export const SORT_OPTIONS = [
  { id: "popularity", label: "热门流行" },
  { id: "rating", label: "高分优先" },
  { id: "release", label: "最新上映" },
] as const;

export interface MediaFilterValues {
  type: string;
  country?: string | undefined;
  genre: string;
  year: string;
  sort: string;
}

export const TMDB_GENRE_MAP: Record<string, number[]> = {
  drama: [18],
  scifi: [878, 10765],
  mystery: [9648],
  action: [28, 10759],
  comedy: [35],
  romance: [10749],
  crime: [80],
  horror: [27, 9648],
  war: [10752, 10768],
  history: [36, 10768],
  wuxia: [28, 14, 10759, 10765],
  animation: [16],
  fantasy: [14, 10765],
  adventure: [12, 10759],
  thriller: [53, 27],
  music: [10402],
};

export const GENRE_KEYWORDS: Record<string, string[]> = {
  drama: ["剧情", "drama", "生活", "人生", "家庭", "成长"],
  scifi: ["科幻", "sci-fi", "science fiction", "太空", "未来", "星际", "外星"],
  mystery: ["悬疑", "mystery", "推理", "解谜", "侦探"],
  action: ["动作", "action", "打斗", "热血", "武侠", "功夫"],
  comedy: ["喜剧", "comedy", "搞笑", "幽默", "爆笑"],
  romance: ["爱情", "romance", "恋爱", "言情", "偶像"],
  crime: ["犯罪", "crime", "刑侦", "警匪", "黑帮", "卧底"],
  horror: ["恐怖", "horror", "中邪", "幽灵", "鬼怪", "丧尸", "惊吓"],
  war: ["战争", "war", "战役", "抗战", "军旅", "二战", "特种兵"],
  history: ["历史", "history", "史诗", "古装", "王朝", "传记"],
  wuxia: ["武侠", "修仙", "仙侠", "玄幻", "江湖", "剑仙", "修真", "金庸"],
  animation: ["动画", "animation", "动漫", "二次元"],
  fantasy: ["奇幻", "fantasy", "魔幻", "仙侠", "修仙", "玄幻", "魔法"],
  adventure: ["冒险", "adventure", "探险", "宝藏"],
  thriller: ["惊悚", "恐怖", "thriller", "psychological"],
  music: ["音乐", "music", "歌舞", "摇滚", "演唱会", "乐团"],
};

export interface CountryStrategyConfig {
  code: string;
  lang?: string | undefined;
  keywords: string[];
}

export const TMDB_COUNTRY_CONFIG: Record<string, CountryStrategyConfig> = {
  cn: { code: "CN", lang: "zh", keywords: ["中国", "内地", "大陆", "华语", "国产", "国漫", "普通话"] },
  hk: { code: "HK", lang: "zh", keywords: ["香港", "tvb", "港片", "粤语", "中国香港"] },
  tw: { code: "TW", lang: "zh", keywords: ["台湾", "台剧", "中国台湾", "公视"] },
  jp: { code: "JP", lang: "ja", keywords: ["日本", "日漫", "日剧", "东京", "日语"] },
  kr: { code: "KR", lang: "ko", keywords: ["韩国", "韩剧", "首尔", "韩语"] },
  us: { code: "US", lang: "en", keywords: ["美国", "好莱坞", "美剧", "英语"] },
  eu: { code: "GB|FR|DE|IT|ES", lang: "en|fr|de|it|es", keywords: ["英国", "法国", "德国", "意大利", "西班牙", "欧洲", "英剧"] },
  other: { code: "", keywords: ["泰国", "印度", "俄罗斯", "加拿大", "澳大利亚", "巴西"] },
};

export interface FilterableMediaItem {
  title: string;
  year: number | null;
  mediaType: "movie" | "tv";
  overview?: string;
  genreIds?: number[];
  voteAverage?: number;
  originCountry?: string[];
  originalLanguage?: string;
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

export function matchesItemCountry(item: FilterableMediaItem, countryKey: string): boolean {
  if (!countryKey || countryKey === "all") return true;
  const cfg = TMDB_COUNTRY_CONFIG[countryKey];
  if (!cfg) return true;

  if (countryKey === "other") {
    // 排除主流国家
    const mainstreamCodes = ["CN", "HK", "TW", "JP", "KR", "US", "GB", "FR", "DE", "IT", "ES"];
    if (item.originCountry && item.originCountry.length > 0) {
      return !item.originCountry.some((c) => mainstreamCodes.includes(c.toUpperCase()));
    }
    return true;
  }

  // 1. 优先校验国家代码列表
  if (item.originCountry && item.originCountry.length > 0) {
    const allowedCodes = cfg.code.split("|");
    if (item.originCountry.some((c) => allowedCodes.includes(c.toUpperCase()))) {
      return true;
    }
  }

  // 2. 校验原创语言代码
  if (item.originalLanguage && cfg.lang) {
    const allowedLangs = cfg.lang.split("|");
    if (allowedLangs.includes(item.originalLanguage.toLowerCase())) {
      return true;
    }
  }

  // 3. 关键词文本模糊匹配兜底
  const text = `${item.title} ${item.overview ?? ""}`.toLowerCase();
  return cfg.keywords.some((kw) => text.includes(kw));
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
  if (yearParam === "2000s") return item.year >= 2000 && item.year < 2010;
  if (yearParam === "90s") return item.year >= 1990 && item.year < 2000;
  if (yearParam === "80s") return item.year < 1990;
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
  filterParams?: { type?: string; country?: string; genre?: string; year?: string; sort?: string },
  doubanMap?: Map<string, { score: number }>,
): SearchCandidateCard[] {
  if (!filterParams) return [...candidates];
  const list = candidates.filter((c) => {
    if (filterParams.type && !matchesItemType(c, filterParams.type)) return false;
    if (filterParams.country && !matchesItemCountry(c, filterParams.country)) return false;
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
    country?: string | undefined;
    genre?: string | undefined;
    year?: string | undefined;
    sort?: string | undefined;
    trending?: string | undefined;
  },
  updates: Partial<{ type: string; country: string; genre: string; year: string; sort: string }>,
): string {
  const merged = { ...current, ...updates };
  const sp = new URLSearchParams();

  if (merged.q?.trim()) {
    sp.set("q", merged.q.trim());
  }

  appendQueryParam(sp, "type", merged.type);
  appendQueryParam(sp, "country", merged.country);
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

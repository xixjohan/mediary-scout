import type { EpisodeDisplayState } from "@media-track/workflow";
import type { TitleHubSeason } from "../../../lib/title-hub";
import type { PaginatedResult } from "./resource-filter-model";

export interface MissingEpisodeItem {
  id: string; // `${seasonNumber}_${episodeNumber}`
  episodeCode: string; // "S01E05"
  seasonNumber: number;
  episodeNumber: number;
  displayCode: string; // "第 5 集"
  displayState: EpisodeDisplayState;
}

export const SEASON_CHUNK_SIZE = 100;

export interface SeasonChunkInfo {
  chunkIndex: number;
  startEp: number;
  endEp: number;
}

export interface SlicedSeasonResult<T> {
  chunks: SeasonChunkInfo[];
  currentChunk: number;
  totalChunks: number;
  sliced: readonly T[];
}

/**
 * 将超长季剧集按指定步长进行分段切片（默认每段 100 集）
 * 超长季 (len > chunkSize) 输出切片数据，常规季无缝输出全量
 */
export function sliceSeasonEpisodes<T>(
  episodes: readonly T[],
  chunkIndex: number,
  chunkSize: number = SEASON_CHUNK_SIZE,
): SlicedSeasonResult<T> {
  const total = episodes.length;
  if (total === 0) {
    return {
      chunks: [],
      currentChunk: 0,
      totalChunks: 0,
      sliced: episodes,
    };
  }

  const totalChunks = Math.ceil(total / chunkSize);
  const safeIndex = Math.min(Math.max(0, chunkIndex), Math.max(0, totalChunks - 1));
  const start = safeIndex * chunkSize;
  const sliced = total > chunkSize ? episodes.slice(start, start + chunkSize) : episodes;

  const chunks: SeasonChunkInfo[] = Array.from({ length: totalChunks }, (_, i) => ({
    chunkIndex: i,
    startEp: i * chunkSize + 1,
    endEp: Math.min((i + 1) * chunkSize, total),
  }));

  return {
    chunks,
    currentChunk: safeIndex,
    totalChunks,
    sliced,
  };
}

export function isSeasonEpisodeStateIncomplete(season: TitleHubSeason): boolean {
  if (!season.tracked) return false;
  if (season.totalEpisodes <= 0) return true;
  if (season.episodes.some((episode) => !episode.obtained && episode.airStatus === "unknown")) return true;
  const codes = new Set(season.episodes.map((episode) => episode.episodeCode));
  const prefix = `S${String(season.seasonNumber).padStart(2, "0")}E`;
  for (let number = 1; number <= season.totalEpisodes; number++) {
    if (!codes.has(`${prefix}${String(number).padStart(2, "0")}`)) return true;
  }
  return false;
}

/**
 * 从 episodeCode (如 "S01E05" 或 "E12") 中解析出数字集号
 */
export function parseEpisodeNumber(code: string): number {
  const match = /[Ee](\d+)/.exec(code);
  if (match?.[1]) {
    const num = parseInt(match[1], 10);
    if (Number.isInteger(num) && num > 0) return num;
  }
  const chineseMatch = /第\s*(\d+)\s*集/.exec(code);
  if (chineseMatch?.[1]) {
    const num = parseInt(chineseMatch[1], 10);
    if (Number.isInteger(num) && num > 0) return num;
  }
  return 1;
}

/**
 * 跨季提取所有已开播但缺失的集数
 * 严格遵循 subscription-missing 的单一事实来源 (displayState === "missing_aired" 或 (!obtained && airStatus === "aired"))
 */
export function extractMissingEpisodes(seasons: readonly TitleHubSeason[]): MissingEpisodeItem[] {
  const missing: MissingEpisodeItem[] = [];

  for (const season of seasons) {
    if (!season.tracked) continue;

    if (season.episodes.length > 0) {
      for (const ep of season.episodes) {
        const isMissing =
          ep.displayState === "missing_aired" || (!ep.obtained && ep.airStatus === "aired");
        if (!isMissing) continue;

        const episodeNumber = parseEpisodeNumber(ep.episodeCode);
        missing.push({
          id: `${season.seasonNumber}_${episodeNumber}`,
          episodeCode: ep.episodeCode,
          seasonNumber: season.seasonNumber,
          episodeNumber,
          displayCode: `第 ${episodeNumber} 集`,
          displayState: ep.displayState,
        });
      }
    }
  }

  // 默认按季号、集号升序排序
  return missing.sort((a, b) => {
    if (a.seasonNumber !== b.seasonNumber) {
      return a.seasonNumber - b.seasonNumber;
    }
    return a.episodeNumber - b.episodeNumber;
  });
}

/**
 * 按季号过滤缺失集（支持 "all"）
 */
export function filterMissingBySeason(
  items: readonly MissingEpisodeItem[],
  seasonFilter: number | "all",
): MissingEpisodeItem[] {
  if (seasonFilter === "all") {
    return [...items];
  }
  return items.filter((item) => item.seasonNumber === seasonFilter);
}

/**
 * 纯内存安全分页切片
 */
export function paginateMissingEpisodes(
  items: readonly MissingEpisodeItem[],
  page: number,
  pageSize: number,
): PaginatedResult<MissingEpisodeItem> {
  const totalItems = items.length;
  const validPageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalItems / validPageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);

  const startIndex = (currentPage - 1) * validPageSize;
  const endIndex = Math.min(startIndex + validPageSize, totalItems);
  const pagedItems = totalItems === 0 ? [] : items.slice(startIndex, endIndex);

  return {
    items: pagedItems,
    totalItems,
    currentPage,
    totalPages,
    pageSize: validPageSize,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
    startIndex,
    endIndex,
  };
}

/** 订阅策略里的「季集范围」：结束集为 null 表示不限。 */
export interface EpisodeRange {
  seasonNumber: number;
  startEpisode: number;
  endEpisode: number | null;
}

/**
 * 按订阅的集范围过滤缺集。
 *
 * 背景：用户把「第 1 季起始集」设成 190 后，缺集看板仍把 E001–E199 全量列出，
 * 于是出现「199 集缺失」这种与实际追更目标无关的数字。这里只保留落在
 * 已配置范围内的缺集；**未配置范围的季保持原样**（不误伤）。
 */
export function filterMissingByEpisodeRanges(
  items: readonly MissingEpisodeItem[],
  ranges: readonly EpisodeRange[] | null | undefined,
): MissingEpisodeItem[] {
  if (!ranges || ranges.length === 0) return [...items];
  const bySeason = new Map<number, EpisodeRange>();
  for (const range of ranges) bySeason.set(range.seasonNumber, range);

  return items.filter((item) => {
    const range = bySeason.get(item.seasonNumber);
    if (!range) return true;
    if (item.episodeNumber < range.startEpisode) return false;
    if (range.endEpisode !== null && item.episodeNumber > range.endEpisode) return false;
    return true;
  });
}

/** 把范围渲染成简短文案，如 `第 1 季 E190–不限`。 */
export function describeEpisodeRanges(ranges: readonly EpisodeRange[]): string {
  if (ranges.length === 0) return "";
  return ranges
    .slice()
    .sort((a, b) => a.seasonNumber - b.seasonNumber)
    .map((range) => {
      const end = range.endEpisode === null ? "不限" : `E${range.endEpisode}`;
      return `第 ${range.seasonNumber} 季 E${range.startEpisode}–${end}`;
    })
    .join(" · ");
}

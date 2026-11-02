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
    } else {
      // 容错降级：当集状态表尚未被 worker 写入（冷启动/初始化中），
      // 根据 latestAiredEpisode 与 obtainedCount 生成已播缺失集
      const aired = Math.min(season.latestAiredEpisode, season.totalEpisodes);
      const startEp = Math.max(1, season.obtainedCount + 1);
      for (let epNum = startEp; epNum <= aired; epNum++) {
        const sPadded = String(season.seasonNumber).padStart(2, "0");
        const ePadded = String(epNum).padStart(2, "0");
        const code = `S${sPadded}E${ePadded}`;
        missing.push({
          id: `${season.seasonNumber}_${epNum}`,
          episodeCode: code,
          seasonNumber: season.seasonNumber,
          episodeNumber: epNum,
          displayCode: `第 ${epNum} 集`,
          displayState: "missing_aired",
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

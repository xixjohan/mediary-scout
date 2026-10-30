import type { EpisodeState } from "@media-track/workflow";

/**
 * 「还缺哪些集」的**单一事实来源**。
 *
 * 为什么抽出来：这个数字原先有两套互不一致的算法——
 *   - `GET /api/agent/library` 逐集过滤 `airStatus === "aired" && !obtained`
 *   - `getLibraryWall` 用 `Math.min(latestAiredEpisode, totalEpisodes)` 减已获取数
 * 两者在 `latestAiredEpisode` 与集表不同步（provider_ahead 的集、manual 补集、
 * storage_only 的集）时会给出不同答案。订阅页待办区要展示这个数字，就必须与
 * agent 看到的是同一个——否则用户会问「为什么 API 说缺 3 集、页面说缺 2 集」。
 *
 * 判定只用 `airStatus`，不用 `season.latestAiredEpisode`：后者是**汇总值**，
 * 与逐集状态可以不一致（provider 提前给出的集、手动补录的集、只在网盘里
 * 发现过的集）。逐集状态才是权威。
 *
 * `unknown` 不算缺：那是尚未播出或状态未定的集（含 provider_ahead），报成
 * 「缺」会让用户以为该去补，其实还没到播的日子。
 */
export function missingAiredEpisodeCodes(episodes: EpisodeState[]): string[] {
  return episodes
    .filter((episode) => episode.airStatus === "aired" && !episode.obtained)
    .map((episode) => episode.episodeCode);
}

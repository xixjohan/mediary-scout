import { fetchTmdbList } from "@media-track/workflow";
import { isLiveSearch } from "../../../lib/search-provider";
import { demoCandidates } from "../../../lib/demo-candidates";
import {
  getTmdbAccesses,
  getAccountScopedSettings,
  getCurrentAccountId,
} from "../../../lib/workflow-runtime";
import type { ActionCardPayload, ActionCardMediaItem } from "../../../lib/chat-types";

/**
 * 电影分类 TMDB ID 映射
 */
export const MOVIE_GENRES: Record<string, string> = {
  科幻: "878",
  动作: "28",
  动画: "16",
  喜剧: "35",
  犯罪: "80",
  纪录: "99",
  纪录片: "99",
  剧情: "18",
  家庭: "10751",
  奇幻: "14",
  历史: "36",
  恐怖: "27",
  音乐: "10402",
  悬疑: "9648",
  爱情: "10749",
  惊悚: "53",
  战争: "10752",
  西部: "37",
  冒险: "12",
};

/**
 * 剧集分类 TMDB ID 映射
 */
export const TV_GENRES: Record<string, string> = {
  科幻: "10765",
  奇幻: "10765",
  动作: "10759",
  冒险: "10759",
  动画: "16",
  喜剧: "35",
  犯罪: "80",
  纪录: "99",
  纪录片: "99",
  剧情: "18",
  家庭: "10751",
  儿童: "10762",
  悬疑: "9648",
  战争: "10768",
  西部: "37",
};

export interface DiscoverMediaInput {
  genre?: string | undefined;
  year?: number | undefined;
  type?: "movie" | "tv" | undefined;
  sortBy?: "popularity" | "rating" | "release_date" | undefined;
}

export interface DiscoverMediaItem extends ActionCardMediaItem {
  voteAverage?: number | undefined;
  voteCount?: number | undefined;
  isUnreleased?: boolean | undefined;
}

export function resolveGenreId(genre: string | undefined, mediaType: "movie" | "tv"): string | undefined {
  if (!genre) return undefined;
  const clean = genre.trim();
  const map = mediaType === "movie" ? MOVIE_GENRES : TV_GENRES;
  for (const [key, val] of Object.entries(map)) {
    if (clean.includes(key) || key.includes(clean)) {
      return val;
    }
  }
  return undefined;
}

function buildDiscoverQueryParams(
  input: DiscoverMediaInput,
  genreId: string | undefined,
): Record<string, string> {
  const query: Record<string, string> = {
    language: "zh-CN",
    include_adult: "false",
    page: "1",
  };

  if (genreId) {
    query["with_genres"] = genreId;
  }

  const mediaType = input.type ?? "movie";
  if (mediaType === "movie") {
    if (input.year) query["primary_release_year"] = String(input.year);
    query["sort_by"] =
      input.sortBy === "rating"
        ? "vote_average.desc"
        : input.sortBy === "release_date"
          ? "primary_release_date.desc"
          : "popularity.desc";
  } else {
    if (input.year) query["first_air_date_year"] = String(input.year);
    query["sort_by"] = input.sortBy === "rating" ? "vote_average.desc" : "popularity.desc";
  }

  return query;
}

function determineItemStatus(
  dateStr: string,
  today: string,
  voteAverage: number,
  voteCount: number,
): { isUnreleased: boolean; statusText: string } {
  const isUnreleased = Boolean(dateStr && dateStr > today) || voteCount === 0;
  if (isUnreleased) {
    return {
      isUnreleased: true,
      statusText: dateStr ? `未公映（定档 ${dateStr}）` : "待定档 / 制作中",
    };
  }
  return {
    isUnreleased: false,
    statusText: voteAverage > 0 ? `TMDB ${voteAverage.toFixed(1)} 分` : "已公映",
  };
}

function mapRawItem(
  item: Record<string, unknown>,
  mediaType: "movie" | "tv",
  today: string,
): DiscoverMediaItem | null {
  const tmdbId = typeof item["id"] === "number" ? item["id"] : null;
  const rawTitle = typeof item["title"] === "string" ? item["title"] : item["name"];
  const title = typeof rawTitle === "string" ? rawTitle : null;
  if (!tmdbId || !title) return null;

  const rawDate = typeof item["release_date"] === "string" ? item["release_date"] : item["first_air_date"];
  const dateStr = typeof rawDate === "string" ? rawDate : "";
  const year = dateStr.length >= 4 ? Number(dateStr.slice(0, 4)) : undefined;
  const voteAverage = typeof item["vote_average"] === "number" ? item["vote_average"] : 0;
  const voteCount = typeof item["vote_count"] === "number" ? item["vote_count"] : 0;

  const { isUnreleased, statusText } = determineItemStatus(dateStr, today, voteAverage, voteCount);

  return {
    tmdbId,
    title,
    year: Number.isFinite(year) ? year : undefined,
    mediaType,
    posterPath: typeof item["poster_path"] === "string" ? item["poster_path"] : undefined,
    overview: typeof item["overview"] === "string" ? item["overview"] : undefined,
    statusText,
    releaseDate: dateStr || undefined,
    voteAverage,
    voteCount,
    isUnreleased,
  };
}

function mapDiscoverResults(
  raw: unknown,
  mediaType: "movie" | "tv",
  today: string,
): DiscoverMediaItem[] {
  if (typeof raw !== "object" || raw === null || !("results" in raw)) return [];
  const results = (raw as { results: unknown[] }).results;
  if (!Array.isArray(results)) return [];

  const items: DiscoverMediaItem[] = [];
  for (const item of results) {
    if (typeof item !== "object" || item === null) continue;
    const mapped = mapRawItem(item as Record<string, unknown>, mediaType, today);
    if (mapped) items.push(mapped);
    if (items.length >= 6) break;
  }
  return items;
}

function formatSingleDiscoverItemLine(item: DiscoverMediaItem, index: number): string {
  const ratingDesc = item.isUnreleased
    ? "暂无公映评分（未上映）"
    : `TMDB ${item.voteAverage?.toFixed(1) ?? "0.0"} 分 (${item.voteCount ?? 0} 人评)`;
  const overviewSnippet = item.overview ? item.overview.slice(0, 60) + "..." : "暂无简介";
  return (
    `${index + 1}. 《${item.title}》${item.year ? ` (${item.year})` : ""}\n` +
    `   - 状态与评分：${item.statusText ?? "未知"} · ${ratingDesc}\n` +
    `   - 简介：${overviewSnippet}`
  );
}

function formatTruthGuardedReply(
  input: DiscoverMediaInput,
  items: DiscoverMediaItem[],
): string {
  const mediaType = input.type ?? "movie";
  const typeLabel = mediaType === "tv" ? "剧集" : "电影";
  const categoryLabel = [input.year ? `${input.year} 年` : "", input.genre ?? "", typeLabel]
    .filter(Boolean)
    .join(" ");

  if (items.length === 0) {
    let msg = `在 TMDB 实时数据库中未发现符合「${categoryLabel}」已公开建档的作品。\n\n提示：受影视行业制作周期与排期变动影响，部分未来项目可能尚未正式建档，或已被制作方推迟上映。`;
    if (input.year && input.year >= 2026) {
      msg += `\n\n⚠️ 现实数据门禁提醒：${input.year} 年的影片目前大多尚未公映，不存在真实“高分”口碑或公映评分（切勿相信捏造评分）。此外受全球影视工业制作与预算调整影响，很多原定 ${input.year} 年上映的大型科幻/特效项目已推迟至 2027 年及以后。`;
    }
    return msg;
  }

  const lines: string[] = [
    `为你检索到 TMDB 数据库中收录的 ${items.length} 部「${categoryLabel}」相关作品：\n`,
  ];

  for (let i = 0; i < items.length; i++) {
    lines.push(formatSingleDiscoverItemLine(items[i]!, i));
  }

  if (input.year && input.year >= 2026) {
    lines.push(
      `\n⚠️ 现实数据门禁提醒：${input.year} 年的影片目前大多尚未公映，不存在真实“高分”口碑或公映评分（切勿相信捏造评分）。此外受全球影视工业制作与预算调整影响，很多原定 ${input.year} 年上映的大型科幻/特效项目已推迟至 2027 年及以后。以上均为 TMDB 官方目前在档的最新信息。`,
    );
  }

  return lines.join("\n");
}

export async function executeDiscoverMedia(
  input: DiscoverMediaInput,
): Promise<{ reply: string; actionCard?: ActionCardPayload | undefined; suggestedPrompts: string[] }> {
  try {
    const mediaType = input.type ?? "movie";
    const genreId = resolveGenreId(input.genre, mediaType);
    const today = new Date().toISOString().slice(0, 10);

    let items: DiscoverMediaItem[] = [];

    if (isLiveSearch()) {
      const accesses = await getTmdbAccesses(
        getAccountScopedSettings(await getCurrentAccountId()),
      );
      const path = mediaType === "tv" ? "discover/tv" : "discover/movie";
      const query = buildDiscoverQueryParams(input, genreId);
      const raw = await fetchTmdbList(accesses, path, query);
      items = mapDiscoverResults(raw, mediaType, today);
    } else {
      // 离线/Demo 回退
      items = demoCandidates
        .filter((c) => {
          if (c.mediaType !== mediaType) return false;
          if (input.year && c.year !== input.year) return false;
          if (input.genre && !c.title.includes(input.genre) && !c.overview.includes(input.genre)) {
            return false;
          }
          return true;
        })
        .slice(0, 6)
        .map((c) => ({
          tmdbId: c.tmdbId,
          title: c.title,
          year: c.year,
          mediaType: c.mediaType,
          posterPath: c.posterPath ?? undefined,
          overview: c.overview ?? undefined,
          statusText: (c.year ?? 0) >= 2026 ? "待上映" : "已公映",
          isUnreleased: (c.year ?? 0) >= 2026,
          voteAverage: 0,
        }));
    }

    const reply = formatTruthGuardedReply(input, items);
    const cardItems: ActionCardMediaItem[] = items.map((it) => ({
      tmdbId: it.tmdbId,
      title: it.title,
      year: it.year,
      mediaType: it.mediaType,
      posterPath: it.posterPath,
      overview: it.overview,
      statusText: it.statusText,
      releaseDate: it.releaseDate,
    }));

    const categoryLabel = [input.year ? `${input.year}年` : "", input.genre ?? "", mediaType === "tv" ? "剧集" : "电影"]
      .filter(Boolean)
      .join(" ");

    const topItem = items[0];
    return {
      reply,
      actionCard:
        cardItems.length > 0
          ? {
              kind: "media_list",
              query: categoryLabel || "影视发现",
              items: cardItems,
            }
          : undefined,
      suggestedPrompts: topItem
        ? [`查看《${topItem.title}》详情`, `搜《${topItem.title}》的资源`, "查看当前任务进度"]
        : ["查看当前任务进度", "我追了哪些剧"],
    };
  } catch (error) {
    return {
      reply: `发现推荐时查询出错：${error instanceof Error ? error.message : String(error)}`,
      suggestedPrompts: ["查看当前任务进度", "搜 孤独摇滚"],
    };
  }
}

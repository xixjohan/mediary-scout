/**
 * 逐季集数范围的共享校验。
 *
 * 保存路径（PUT /api/titles/subscription-policy）与预览路径都会解析同一份
 * `seasonEpisodeRanges`；两处各写一份曾经导致「预览不算逐季、保存才算」的承诺
 * 不一致。提取到这里之后，两端只有一份语法。
 */

export interface ParsedSeasonEpisodeRange {
  seasonNumber: number;
  startEpisode: number;
  endEpisode: number | null;
}

export type SeasonRangesParseResult =
  | { ok: true; ranges: ParsedSeasonEpisodeRange[] }
  | { ok: false; error: string };

function parseSeasonEpisodeRange(value: unknown): ParsedSeasonEpisodeRange | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const range = value as Record<string, unknown>;
  const seasonNumber = range["seasonNumber"];
  const startEpisode = range["startEpisode"];
  const endEpisode = range["endEpisode"];
  const validSeason = Number.isInteger(seasonNumber) && (seasonNumber as number) >= 0 && (seasonNumber as number) <= 99;
  const validStart = Number.isInteger(startEpisode) && (startEpisode as number) >= 1;
  const validEnd = endEpisode === null || (Number.isInteger(endEpisode) && (endEpisode as number) >= (startEpisode as number));
  if (!validSeason || !validStart || !validEnd) return null;
  return { seasonNumber: seasonNumber as number, startEpisode: startEpisode as number, endEpisode: endEpisode as number | null };
}

export function parseSeasonEpisodeRangesBody(value: unknown): SeasonRangesParseResult {
  const rawRanges = value ?? [];
  if (!Array.isArray(rawRanges) || rawRanges.length > 100) {
    return { ok: false, error: "seasonEpisodeRanges 必须是最多 100 项的数组" };
  }
  const ranges: ParsedSeasonEpisodeRange[] = [];
  const seenSeasons = new Set<number>();
  for (const item of rawRanges) {
    const range = parseSeasonEpisodeRange(item);
    if (!range) return { ok: false, error: "季数或集数范围无效；起始集至少为 1，结束集须大于等于起始集" };
    if (seenSeasons.has(range.seasonNumber)) return { ok: false, error: "同一季不能配置多个范围" };
    seenSeasons.add(range.seasonNumber);
    ranges.push(range);
  }
  return { ok: true, ranges };
}

/** 保存路由使用的别名（两端语法只有一个来源）。 */
export const parseSubscriptionPolicyRangeParts = parseSeasonEpisodeRangesBody;

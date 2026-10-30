/**
 * Batch 5: the cost-model guard for the subscription layer (plan §4.1).
 *
 * The plan is blunt about why this exists: 国内网盘搜索（PanSou/磁力聚合）大多没有可靠
 * 增量游标, so the only honest strategy is **周期全量重搜 + 指纹去重 + 冷却**, borrowing
 * the watermark structure but NOT the cost model. Actual cost is roughly
 *
 *     监控季数 × 每日搜索次数 × 单次搜索延迟
 *
 * and every search goes through the rate limiter. So the number of monitored seasons is
 * not a detail — it is the multiplier on the whole thing.
 *
 * The plan's instruction is explicit: **监控季数上限应做成配置项并默认保守（如 50），
 * 超限明确告知而非默默拖垮巡检.** Two halves, both implemented here:
 *
 *   · A conservative default (50), configurable.
 *   · Over the limit is *stated*, not swallowed. Silently patrolling 400 seasons would
 *     look like success for an hour and then quietly stop finishing — the worst failure
 *     mode this system has, because nothing reports it.
 *
 * Nothing here reads a clock or a database: the caller passes `now` and the count. That
 * is what makes the "what do I do about it" message testable.
 */

/** The plan's suggested default. Kept as a named constant so the rationale is visible. */
export const DEFAULT_MAX_MONITORED_SEASONS = 50;

/** A hard ceiling, so a mis-typed setting cannot disable the guard entirely. */
export const MAX_MONITORED_SEASONS_CEILING = 500;

export interface MonitoredSeasonBudget {
  /** The configured cap (after clamping). */
  limit: number;
  /** Whether `count` is within it. */
  withinBudget: boolean;
  /** How many seasons over the cap, or 0 when within. */
  overBy: number;
  /** What to tell the operator. Empty when within budget — silence is the success case. */
  message: string;
}

/**
 * Resolve a configured cap. A value that is not a positive integer, or above the
 * ceiling, falls back to the default rather than to 0 or to infinity: an unset or
 * mis-typed setting must not turn the guard off.
 */
export function resolveMaxMonitoredSeasons(configured: number | string | null | undefined): number {
  const value = typeof configured === "string" ? Number(configured.trim()) : configured;
  if (value === undefined || value === null || !Number.isInteger(value)) {
    return DEFAULT_MAX_MONITORED_SEASONS;
  }
  if (value < 1) return DEFAULT_MAX_MONITORED_SEASONS;
  return Math.min(value, MAX_MONITORED_SEASONS_CEILING);
}

/**
 * Check a monitored-season count against the cap, and say what to do about it.
 *
 * The message is part of the contract, not decoration: the plan asks for 明确告知, and a
 * number alone ("402") does not tell an operator whether to raise the cap or stop
 * tracking titles. It names both options and says which is cheaper to undo.
 */
export function checkMonitoredSeasonBudget(input: {
  count: number;
  configured?: number | string | null;
  /** How many patrols per day, for the cost estimate in the message. */
  searchesPerDay?: number;
}): MonitoredSeasonBudget {
  const limit = resolveMaxMonitoredSeasons(input.configured);
  const overBy = Math.max(0, input.count - limit);
  const withinBudget = overBy === 0;

  if (withinBudget) {
    return { limit, withinBudget, overBy, message: "" };
  }

  const perDay = input.searchesPerDay;
  const estimate =
    perDay === undefined
      ? ""
      : ` 约 ${overBy * perDay} 次/日 的额外搜索，全部要过限速桶。`;
  return {
    limit,
    withinBudget,
    overBy,
    message:
      `监控季数 ${input.count} 超出上限 ${limit}（多 ${overBy}）。${estimate}` +
      `全量重搜的成本是「季数 × 每日搜索次数 × 单次延迟」，超限会拖垮巡检而非报错。` +
      `请上调上限，或先停订一部分季。`,
  };
}

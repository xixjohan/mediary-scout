/**
 * 预览结果的纯映射与运行状态。
 *
 * 这里只回答两个问题：
 *   ① 一份预览响应/流事件，在面板上应该长什么样；
 *   ② 这次预览处在生命周期的哪一步（含「已经作废」这一档）。
 *
 * 为什么强调 ②：用户改一个字段就会让旧预览作废，但请求还在飞。没有 requestId 的
 * 话，迟到的响应会把「旧规则的命中数」贴到「新规则的表单」下面——画面上规则与
 * 数字不一致，比没有数字更糟。
 */

export type PreviewExcludeReason =
  | "excluded"
  | "missing_term"
  | "episode_filtered"
  | "subtitle_missing"
  | "wrong_title"
  | "priority_unmatched";

export const PREVIEW_EXCLUDE_REASONS: readonly PreviewExcludeReason[] = [
  "excluded", "missing_term", "episode_filtered", "subtitle_missing", "wrong_title", "priority_unmatched",
];

export interface PreviewExcludedEntry {
  name: string;
  reason: PreviewExcludeReason;
}

export interface PreviewOutcome {
  searchedKeywords: number;
  total: number;
  matchedCount: number;
  excludedCount: number;
  matched: string[];
  excluded: PreviewExcludedEntry[];
  /** 命中且带中文字幕标记的条数（软偏好不拒，只用于展示）。 */
  matchedWithSubtitleCount: number;
  /** 命中里整季包的条数：与单集候选不是同一单位，headline 要分开说。 */
  matchedPackCount: number;
  /** 按原因分组的排除计数（含 wrong_title），驱动诊断优先级。 */
  excludedByReason: Partial<Record<PreviewExcludeReason, number>>;
  /** 这次结果是否来自 30 分钟缓存（缓存命中不花上游预算）。 */
  cached: boolean;
  sourceHealth?: { status: string; unhealthySources: string[] } | undefined;
  releaseDate?: string | null | undefined;
}

export interface PreviewProgress {
  done: number;
  total: number;
  currentKeyword?: string;
}

export type PreviewState =
  | { kind: "idle" }
  | { kind: "previewing"; requestId: string; progress: PreviewProgress }
  | { kind: "previewed"; requestId: string; outcome: PreviewOutcome }
  | { kind: "throttled"; requestId: string; retryAfterMs: number }
  | { kind: "failed"; requestId: string; copy: string };

export type PreviewEvent =
  | { type: "start"; requestId: string }
  | { type: "progress"; requestId: string; progress: PreviewProgress }
  | { type: "done"; requestId: string; outcome: PreviewOutcome }
  | { type: "throttled"; requestId: string; retryAfterMs: number }
  | { type: "failed"; requestId: string; copy: string }
  | { type: "invalidated" };

/** 预览生命周期 reducer：迟到的旧 requestId 事件一律忽略（即「作废」）。 */
export function reducePreviewState(state: PreviewState, event: PreviewEvent): PreviewState {
  if (event.type === "invalidated") return { kind: "idle" };
  if (event.type === "start") {
    return { kind: "previewing", requestId: event.requestId, progress: { done: 0, total: 0 } };
  }
  if (state.kind === "idle" || state.requestId !== event.requestId) return state;
  switch (event.type) {
    case "progress":
      return state.kind === "previewing" ? { ...state, progress: event.progress } : state;
    case "done":
      return { kind: "previewed", requestId: event.requestId, outcome: event.outcome };
    case "throttled":
      return { kind: "throttled", requestId: event.requestId, retryAfterMs: event.retryAfterMs };
    case "failed":
      return { kind: "failed", requestId: event.requestId, copy: event.copy };
    default:
      return state;
  }
}

/**
 * 限流文案：说清楚「多久之后」。
 *
 * 裸的「稍后再试」会让用户反复点、每次都被拒——服务端已经算出了 retryAfterMs，
 * 不把它说出来等于把可用信息扔掉。
 */
export function formatPreviewThrottleCopy(retryAfterMs: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `预览太频繁，${seconds} 秒后可再试（预览与手动检索共用 60 秒限速）`;
}

/**
 * 一份 JSON 预览响应 → 结果。
 *
 * 502 是最要紧的一种：搜索失败时没有诚实的数字可展示。「命中 0 个」若被读成
 * 「你的规则不匹配」，用户会去放宽一条本来没问题的规则。
 */
export function mapPreviewResponse(status: number, body: unknown): { ok: true; outcome: PreviewOutcome } | { ok: false; copy: string; retryAfterMs?: number } {
  const parsed = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (status === 200) {
    return {
      ok: true,
      outcome: {
        searchedKeywords: num(parsed["searchedKeywords"]),
        total: num(parsed["total"]),
        matchedCount: num(parsed["matchedCount"]),
        excludedCount: num(parsed["excludedCount"]),
        matched: strings(parsed["matched"]),
        excluded: excludedEntries(parsed["excluded"]),
        matchedWithSubtitleCount: num(parsed["matchedWithSubtitleCount"]),
        matchedPackCount: num(parsed["matchedPackCount"]),
        excludedByReason: countsByReason(parsed["excludedByReason"]),
        cached: parsed["cached"] === true,
        sourceHealth: sourceHealth(parsed["sourceHealth"]),
        releaseDate: typeof parsed["releaseDate"] === "string" ? (parsed["releaseDate"] as string) : null,
      },
    };
  }
  const copy = typeof parsed["error"] === "string" ? (parsed["error"] as string) : "预览失败";
  if (status === 429) {
    const retryAfterMs = typeof parsed["retryAfterMs"] === "number" ? (parsed["retryAfterMs"] as number) : 60_000;
    return { ok: false, copy: formatPreviewThrottleCopy(retryAfterMs), retryAfterMs };
  }
  return { ok: false, copy };
}

/** 主标题：这条规则会做什么。 */
export function previewHeadlineCopy(outcome: PreviewOutcome): string {
  const cached = outcome.cached ? "（缓存结果）" : "";
  if (outcome.total === 0) {
    return `没搜到候选（用了 ${outcome.searchedKeywords} 个关键词）${cached}`;
  }
  const subtitle = outcome.matchedWithSubtitleCount > 0
    ? `，其中 ${outcome.matchedWithSubtitleCount} 个带中文字幕`
    : "";
  // 「137 条」到底意味着多少内容，取决于其中有多少是整季包 —— 不说清单位，
  // 用户没法判断这 137 是「137 集」还是「137 个版本」。
  const packs = outcome.matchedCount > 0 && outcome.matchedPackCount > 0
    ? `（其中 ${outcome.matchedPackCount} 条为整季包，其余为单集/单片）`
    : "";
  return `命中 ${outcome.matchedCount} 条${packs}，排除 ${outcome.excludedCount} 条（共 ${outcome.total} 个候选）${subtitle}${cached}`;
}

export function previewReasonCopy(reason: PreviewExcludeReason): string {
  switch (reason) {
    case "excluded":
      return "命中排除词";
    case "missing_term":
      return "缺必须包含的词";
    case "episode_filtered":
      return "不在集数范围内";
    case "subtitle_missing":
      return "没有中文字幕标记";
    case "priority_unmatched":
      return "未命中任何优先级组";
    case "wrong_title":
      return "不是同一部作品";
  }
}

/** 规则把一切排掉——用户的错，不是搜索的错。 */
export function ruleExcludesEverything(outcome: PreviewOutcome): boolean {
  return outcome.total > 0 && outcome.matchedCount === 0;
}

/**
 * 0 命中时的诊断优先级（与资源面板同一套话术）。
 *
 * 顺序是有讲究的：源异常 / 未上映 这类「不是你的规则的问题」必须先于
 * 「规则太严」说出来，否则用户会去改一条本来没问题的规则。
 */
export type EmptyDiagnosis =
  | "source_error"
  | "unreleased"
  | "no_candidates"
  | "priority_unmatched"
  | "wrong_title"
  | "rule_excludes_all";

export function diagnoseEmptyPreview(input: {
  outcome: PreviewOutcome;
  hasPriorityGroups: boolean;
  now?: string;
}): EmptyDiagnosis | null {
  if (input.outcome.matchedCount > 0) return null;
  const health = input.outcome.sourceHealth;
  if (health && (health.status === "unreachable" || health.status === "protocol_error")) return "source_error";
  const releaseDate = input.outcome.releaseDate;
  if (releaseDate && releaseDate > (input.now ?? new Date().toISOString().slice(0, 10))) return "unreleased";
  if (input.outcome.total === 0) return "no_candidates";
  const counts = input.outcome.excludedByReason;
  const wrongTitle = counts.wrong_title ?? input.outcome.excluded.filter((entry) => entry.reason === "wrong_title").length;
  const onlyPriority = input.outcome.excluded.length > 0 && input.outcome.excluded.every((entry) => entry.reason === "priority_unmatched");
  if (onlyPriority && input.hasPriorityGroups) return "priority_unmatched";
  // 「排除的原因是别的作品」占多数时，问题在**搜索召回**，不是规则太严 ——
  // 让用户去改规则只会越改越糟（2026-11-17 事故的正确解释）。
  if (wrongTitle > 0 && wrongTitle * 2 >= input.outcome.excluded.length) return "wrong_title";
  return "rule_excludes_all";
}

/** 按 reason 的计数表：只收已知原因、正整数；坏数据一律丢弃（不让它污染诊断）。 */
function countsByReason(value: unknown): Partial<Record<PreviewExcludeReason, number>> {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const counts: Partial<Record<PreviewExcludeReason, number>> = {};
  for (const reason of PREVIEW_EXCLUDE_REASONS) {
    const n = raw[reason];
    if (typeof n === "number" && Number.isFinite(n) && n > 0) counts[reason] = n;
  }
  return counts;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function excludedEntries(value: unknown): PreviewExcludedEntry[] {
  if (!Array.isArray(value)) return [];
  const reasons = PREVIEW_EXCLUDE_REASONS;
  const entries: PreviewExcludedEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const name = entry["name"];
    const reason = entry["reason"];
    if (typeof name !== "string" || typeof reason !== "string") continue;
    if (!reasons.includes(reason as PreviewExcludeReason)) continue;
    entries.push({ name, reason: reason as PreviewExcludeReason });
  }
  return entries;
}

function sourceHealth(value: unknown): PreviewOutcome["sourceHealth"] {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const status = raw["status"];
  if (typeof status !== "string") return undefined;
  return { status, unhealthySources: strings(raw["unhealthySources"]) };
}

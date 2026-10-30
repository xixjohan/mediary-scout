/**
 * 订阅策略面板的纯映射层 (batch 5, plan §4.1).
 *
 * 与 organize 面板同一形状：响应 → 面板状态是纯函数，所以四种终局能在没有 fetch 的情况下
 * 测。内联在事件处理器里，能测的只剩文案——而文案恰恰是告诉用户「你的规则有没有用」的那部分。
 *
 * ## 为什么单独一个文件
 *
 * 这个模块被 .tsx 和 .test.ts 同时引用，而 .test.ts 不该为了断言一个映射函数把整个
 * React 组件拖进依赖图（拖进来就要 mock next/navigation，那些 mock 对映射本身一无所知）。
 */

export interface PolicyDraft {
  mustContain: string;
  mustNotContain: string;
  episodeFilter: string;
  useRegex: boolean;
  cooldownDays: number;
  customKeywords?: string;
}

/** One excluded candidate, with WHY it was excluded — 「排了 N 个」会让人回去猜是哪条规则干的。 */
export interface PreviewExcludedEntry {
  name: string;
  reason: "excluded" | "missing_term" | "episode_filtered";
}

export interface PreviewOutcome {
  searchedKeywords: number;
  total: number;
  matchedCount: number;
  excludedCount: number;
  matched: string[];
  excluded: PreviewExcludedEntry[];
}

export type PolicyPanelState =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "previewed"; outcome: PreviewOutcome }
  | { kind: "saving" }
  | { kind: "saved"; copy: string }
  | { kind: "rejected"; copy: string; status: number }
  | { kind: "failed"; copy: string };

/**
 * Map a preview response onto the panel's state.
 *
 * 502 is the important one: the search failed, so there is no honest number to show.
 * "0 matched" read as "your rule matches nothing" would send the user off to loosen a
 * rule that was fine — so a failed search must never look like an empty result.
 */
export function mapPreviewResponse(status: number, body: unknown): PolicyPanelState {
  const parsed = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (status === 200) {
    const outcome: PreviewOutcome = {
      searchedKeywords: num(parsed["searchedKeywords"]),
      total: num(parsed["total"]),
      matchedCount: num(parsed["matchedCount"]),
      excludedCount: num(parsed["excludedCount"]),
      matched: strings(parsed["matched"]),
      excluded: excludedEntries(parsed["excluded"]),
    };
    return { kind: "previewed", outcome };
  }
  const copy = typeof parsed["error"] === "string" ? (parsed["error"] as string) : "预览失败";
  return { kind: "failed", copy };
}

/** The headline the user reads first: what the rule WOULD do. */
export function previewHeadlineCopy(outcome: PreviewOutcome): string {
  if (outcome.total === 0) {
    return `没搜到候选（用了 ${outcome.searchedKeywords} 个关键词）`;
  }
  return `命中 ${outcome.matchedCount} 个，排除 ${outcome.excludedCount} 个（共 ${outcome.total} 个候选）`;
}

/** Why a candidate was excluded, in the user's words. */
export function previewReasonCopy(reason: PreviewExcludedEntry["reason"]): string {
  switch (reason) {
    case "excluded":
      return "命中排除词";
    case "missing_term":
      return "缺必须包含的词";
    case "episode_filtered":
      return "不在集数范围内";
  }
}

/**
 * Read a saved policy back into a draft. `null` ⇒ null (no rule configured), never an
 * empty draft — the panel shows "还没配规则" for null and a filled form otherwise, and
 * conflating the two would make an unconfigured work look like a configured one.
 *
 * The stored term lists are joined with ", " because the draft edits them in a text
 * input. That is a display choice, not a round-trip guarantee: the SAVE path re-splits
 * on commas (see the panel's draft → policy conversion), so a user who typed
 * "2160p, 简中" gets exactly those two terms back.
 */
export function mapSavedPolicy(policy: unknown): PolicyDraft | null {
  if (typeof policy !== "object" || policy === null) return null;
  const parsed = policy as Record<string, unknown>;
  const custom = joined(parsed["customKeywords"]);
  return {
    mustContain: joined(parsed["mustContain"]),
    mustNotContain: joined(parsed["mustNotContain"]),
    episodeFilter: str(parsed["episodeFilter"]),
    useRegex: parsed["useRegex"] === true,
    cooldownDays: num(parsed["cooldownDays"]),
    ...(custom ? { customKeywords: custom } : {}),
  };
}

/**
 * GET /api/titles/subscription-policy ⇒ the draft to fill the form with, or null.
 *
 * This mapping is what keeps a saved rule VISIBLE: the panel loads it on mount, so a
 * user who comes back to the page sees the rule they saved instead of an empty form
 * that claims 「还没配规则」. Without it the save endpoint and the read endpoint both
 * exist and are both tested, and the rule still vanishes from the user's eyes on every
 * reload.
 *
 * Every non-honest answer degrades to null rather than throwing: 404 (the work is not
 * tracked on this drive), 5xx, a broken body shape. null renders as the honest
 * 「还没配规则」 empty form — which is exactly what an unconfigured work should look
 * like. A thrown fetch or a half-parsed policy would take the whole panel down, and
 * the panel's job (configure a rule) does not depend on the read succeeding.
 */
export function mapPolicyLoadResponse(status: number, body: unknown): PolicyDraft | null {
  if (status !== 200) return null;
  const parsed = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  return mapSavedPolicy(parsed["policy"]);
}

/**
 * Draft → the wire shape the API expects.
 *
 * The draft holds the term lists as strings (one text input each), the API wants arrays.
 * Splitting on commas is what makes the round-trip honest: a user who types "2160p, 简中"
 * and saves must get those exact two terms back, not one term containing a comma.
 *
 * Empty and whitespace-only entries are dropped: "2160p, , 简中" is two terms, not three
 * (an empty term would match everything, silently disabling the filter).
 */
export function draftToPolicy(draft: PolicyDraft): {
  mustContain: string[];
  mustNotContain: string[];
  episodeFilter: string;
  useRegex: boolean;
  cooldownDays: number;
  customKeywords?: string[];
} {
  const custom = draft.customKeywords ? splitTerms(draft.customKeywords) : [];
  return {
    mustContain: splitTerms(draft.mustContain),
    mustNotContain: splitTerms(draft.mustNotContain),
    episodeFilter: draft.episodeFilter.trim(),
    useRegex: draft.useRegex,
    cooldownDays: draft.cooldownDays,
    ...(custom.length > 0 ? { customKeywords: custom } : {}),
  };
}

function splitTerms(value: string): string[] {
  return value
    .split(",")
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

/** A policy that excludes everything while candidates exist — the user's mistake, not the search's. */
export function ruleExcludesEverything(outcome: PreviewOutcome): boolean {
  return outcome.total > 0 && outcome.matchedCount === 0;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A stored term list as one editable string. Non-arrays and non-strings degrade to "". */
function joined(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter((entry): entry is string => typeof entry === "string").join(", ");
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function excludedEntries(value: unknown): PreviewExcludedEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: PreviewExcludedEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const name = str(entry["name"]);
    const reason = entry["reason"];
    if (reason !== "excluded" && reason !== "missing_term" && reason !== "episode_filtered") continue;
    entries.push({ name, reason });
  }
  return entries;
}

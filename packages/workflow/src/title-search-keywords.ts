import { normalizeSearchKeyword } from "./planning-search-gate.js";
import type { MediaTitle } from "./domain.js";

/**
 * Server-side keyword ladder for the user-triggered resource search (W2).
 *
 * The plan is explicit that the user must NOT type a keyword
 * (「关键词构造复用 agent 的既有分工（裸标题预热 + 繁体/英文/原名升级），不让用户
 * 手打关键词」). Reasons that are not just convenience: a hand-typed keyword is a
 * free-form string the user can fill with anything, and the ladder's whole point is
 * that it escalates deterministically — bare title first, then the other identities
 * the title is known by.
 *
 * The ladder mirrors the agent's escalation order, cheapest and most specific
 * first: the localized title, then the original (usually romanized) title, then
 * aliases. `year` is appended to the bare title when present — it is the single
 * most effective disambiguator between a remake/sequel sharing a name.
 *
 * Deduplicated via the SAME normalizer the agent's search gate uses, so "孤独摇滚"
 * and "孤独摇滚 " cannot both consume a search slot.
 */
export interface TitleSearchKeyword {
  keyword: string;
  /** Which identity produced it — for the response's provenance and for debugging. */
  origin: "title" | "title+year" | "originalTitle" | "alias";
}

/** Cap the ladder: every extra keyword is a real search against the indexer. */
const MAX_KEYWORDS = 4;

export function buildTitleSearchKeywords(title: MediaTitle): TitleSearchKeyword[] {
  const out: TitleSearchKeyword[] = [];
  const seen = new Set<string>();

  const push = (raw: string, origin: TitleSearchKeyword["origin"]): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    const normalized = normalizeSearchKeyword(trimmed);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ keyword: trimmed, origin });
  };

  push(title.title, "title");
  if (title.year > 0) push(`${title.title} ${title.year}`, "title+year");
  push(title.originalTitle, "originalTitle");
  for (const alias of title.aliases) push(alias, "alias");

  return out.slice(0, MAX_KEYWORDS);
}

/** Just the keyword strings, in ladder order. */
export function titleSearchKeywordStrings(title: MediaTitle): string[] {
  return buildTitleSearchKeywords(title).map((entry) => entry.keyword);
}

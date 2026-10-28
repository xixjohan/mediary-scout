import { normalizeSearchKeyword } from "./planning-search-gate.js";
import type { MediaTitle } from "./domain.js";

/**
 * Keyword ladder for resource search.
 *
 * Implements the Strategy Pattern across three layers:
 *  1. CustomKeywordStrategy — user-supplied custom query terms (highest priority).
 *  2. EpisodeTargetedStrategy — specific season/episode precision queries.
 *  3. DefaultLadderStrategy — automated escalation ladder: bare title first, then
 *     title+year, original romanized title, and aliases.
 *
 * Deduplicated via the SAME normalizer the agent's search gate uses, so "孤独摇滚"
 * and "孤独摇滚 " cannot both consume a search slot.
 */
export interface TitleSearchKeyword {
  keyword: string;
  /** Which strategy or identity produced it — for response provenance and debugging. */
  origin: "title" | "title+year" | "originalTitle" | "alias" | "custom" | "episode";
}

/** Cap the ladder: every extra keyword is a real search against the indexer. */
const MAX_KEYWORDS = 4;

export interface SearchKeywordOptions {
  /** User-provided custom search keyword. Takes top priority. */
  customKeyword?: string | null | undefined;
  /** User-provided list of custom search keywords (e.g. from subscription policy). */
  customKeywords?: readonly string[] | null | undefined;
  /** Targeted season number (e.g. 2 for S02 / 第二季). */
  seasonNumber?: number | null | undefined;
  /** Targeted episode number (e.g. 5 for E05 / 第05集). */
  episodeNumber?: number | null | undefined;
  /** Maximum number of keywords returned (defaults to 4). */
  maxKeywords?: number | undefined;
}

/** Sanitize user-typed keyword: strip newlines/control chars, limit length. */
function sanitizeCustomKeyword(raw: string): string {
  return raw
    .replace(/[\r\n\t\0]/g, " ")
    .trim()
    .slice(0, 64);
}

type PushKeyword = (raw: string, origin: TitleSearchKeyword["origin"]) => void;

function collectCustomKeywords(options: SearchKeywordOptions | undefined, push: PushKeyword): void {
  if (options?.customKeyword) {
    const sanitized = sanitizeCustomKeyword(options.customKeyword);
    if (sanitized.length > 0) push(sanitized, "custom");
  }
  if (!options?.customKeywords) return;
  for (const kw of options.customKeywords) {
    if (typeof kw === "string") {
      const sanitized = sanitizeCustomKeyword(kw);
      if (sanitized.length > 0) push(sanitized, "custom");
    }
  }
}

function collectEpisodeKeywords(title: MediaTitle, options: SearchKeywordOptions | undefined, push: PushKeyword): void {
  if (title.type === "movie") return;
  const s = options?.seasonNumber;
  const e = options?.episodeNumber;
  const hasSeason = typeof s === "number" && s > 0;
  const hasEpisode = typeof e === "number" && e > 0;

  if (hasSeason && hasEpisode) {
    const sCode = String(s).padStart(2, "0");
    const eCode = String(e).padStart(2, "0");
    push(`${title.title} S${sCode}E${eCode}`, "episode");
    push(`${title.title} 第${e}集`, "episode");
  } else if (hasSeason) {
    const sCode = String(s).padStart(2, "0");
    push(`${title.title} S${sCode}`, "episode");
  } else if (hasEpisode) {
    const eCode = String(e).padStart(2, "0");
    push(`${title.title} EP${eCode}`, "episode");
  }
}

function collectDefaultLadderKeywords(title: MediaTitle, push: PushKeyword): void {
  push(title.title, "title");
  if (title.year > 0) push(`${title.title} ${title.year}`, "title+year");
  push(title.originalTitle, "originalTitle");
  for (const alias of title.aliases) push(alias, "alias");
}

export function buildTitleSearchKeywords(
  title: MediaTitle,
  options?: SearchKeywordOptions,
): TitleSearchKeyword[] {
  const out: TitleSearchKeyword[] = [];
  const seen = new Set<string>();

  const push: PushKeyword = (raw, origin) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    const normalized = normalizeSearchKeyword(trimmed);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ keyword: trimmed, origin });
  };

  collectCustomKeywords(options, push);
  collectEpisodeKeywords(title, options, push);
  collectDefaultLadderKeywords(title, push);

  const cap = options?.maxKeywords ?? MAX_KEYWORDS;
  return out.slice(0, cap);
}

/** Just the keyword strings, in ladder order. */
export function titleSearchKeywordStrings(
  title: MediaTitle,
  options?: SearchKeywordOptions,
): string[] {
  return buildTitleSearchKeywords(title, options).map((entry) => entry.keyword);
}

/**
 * The episode-identity contract between storage listings and workflow state:
 * a file is "visible" as an episode exactly when its FILE NAME alone exposes
 * an episode code. Path context (season folders) does not survive moves, so
 * anything the workflow lands in a canonical season directory must carry its
 * code in the name.
 */

const NON_EPISODE_NUMBERS = new Set([480, 576, 720, 1080, 2160, 4320]);

function isLikelyYear(num: number): boolean {
  return num >= 1900 && num <= 2099;
}

function isValidEpisodeNumber(num: number): boolean {
  return num > 0 && !NON_EPISODE_NUMBERS.has(num) && !isLikelyYear(num);
}

function matchStandardSeasonEpisode(name: string): string | null {
  const match = /[Ss](\d{1,2})[Ee](\d{1,4})/i.exec(name);
  if (match?.[1] && match[2]) {
    return `S${match[1].padStart(2, "0")}E${match[2].padStart(2, "0")}`;
  }
  return null;
}

function matchChineseEpisode(name: string, seasonPrefix: string): string | null {
  const match = /第\s*(\d{1,4})\s*[集话話]/.exec(name);
  return match?.[1] ? `${seasonPrefix}E${match[1].padStart(2, "0")}` : null;
}

function matchAnimeDashEpisode(name: string, seasonPrefix: string): string | null {
  const match = /(?:^|\s+)-\s+(\d{1,4})(?:v\d+)?(?:\s+|\[|\.|$)/i.exec(name);
  if (match?.[1]) {
    const epNum = Number(match[1]);
    if (isValidEpisodeNumber(epNum)) {
      return `${seasonPrefix}E${String(epNum).padStart(2, "0")}`;
    }
  }
  return null;
}

function matchBracketEpisode(name: string, seasonPrefix: string): string | null {
  const bracketMatches = name.matchAll(/\[(\d{1,4})(?:v\d+)?\]/gi);
  for (const match of bracketMatches) {
    if (match?.[1]) {
      const epNum = Number(match[1]);
      if (isValidEpisodeNumber(epNum)) {
        return `${seasonPrefix}E${String(epNum).padStart(2, "0")}`;
      }
    }
  }
  return null;
}

function matchEpToken(name: string, seasonPrefix: string): string | null {
  const match = /(?:^|\b|\s|\[)EP?(\d{1,4})(?:v\d+)?(?:\b|\s|\]|\.|$)/i.exec(name);
  if (match?.[1]) {
    const epNum = Number(match[1]);
    if (isValidEpisodeNumber(epNum)) {
      return `${seasonPrefix}E${String(epNum).padStart(2, "0")}`;
    }
  }
  return null;
}

/**
 * Parse an episode code (e.g. S01E02) from a file name.
 * Supports standard SxxExx, Chinese 第N集, Anime dash ` - 02 `, bracketed `[02]`, and EP tokens.
 *
 * @param name File name to parse
 * @param fallbackSeason Fallback season number if not stated in the name (defaults to 1)
 */
export function episodeCodeFromFileName(name: string, fallbackSeason = 1): string | null {
  const standard = matchStandardSeasonEpisode(name);
  if (standard) return standard;

  const seasonPrefix = `S${String(fallbackSeason).padStart(2, "0")}`;
  return (
    matchChineseEpisode(name, seasonPrefix) ??
    matchAnimeDashEpisode(name, seasonPrefix) ??
    matchBracketEpisode(name, seasonPrefix) ??
    matchEpToken(name, seasonPrefix)
  );
}

/**
 * Whether the file name itself names a season (an `SxxEyy` token).
 */
export function episodeCodeNamesSeason(name: string): boolean {
  return /[Ss]\d{1,2}[Ee]\d{1,4}/.test(name);
}

/**
 * Extract technical / release metadata tags from source name in brackets.
 * Excludes pure numeric episode brackets like [02] or [02v2].
 */
export function extractReleaseTags(sourceName: string): string[] {
  const tags: string[] = [];
  const bracketMatches = sourceName.matchAll(/\[([^\]]+)\]/g);
  for (const match of bracketMatches) {
    const content = match[1]?.trim();
    if (content && !/^\d{1,4}(?:v\d+)?$/i.test(content)) {
      tags.push(`[${content}]`);
    }
  }
  return tags;
}

/**
 * Clean a series title by removing year and tmdb-id suffixes if present.
 * e.g. "桃源暗鬼 (2025) {tmdb-253811}" -> "桃源暗鬼"
 */
export function cleanMediaTitle(rawTitle: string): string {
  return rawTitle
    .replace(/\{tmdb-\d+\}/gi, "")
    .replace(/\(\d{4}\)/g, "")
    .trim();
}

/**
 * Canonical episode file name generator.
 *
 * Supports:
 * - Clean standard naming: `Title - S01E02.ext`
 * - Metadata-preserved standard naming: `Title - S01E02 [ReleaseGroup] [1080p].ext`
 */
export function canonicalEpisodeFileName(input: {
  title: string;
  episodeCode: string;
  sourceName: string;
  preserveMetadata?: boolean;
}): string {
  const extensionMatch = /\.[A-Za-z0-9]+$/.exec(input.sourceName);
  const extension = extensionMatch?.[0] ?? "";
  const cleanTitle = cleanMediaTitle(input.title);

  if (!input.preserveMetadata) {
    return `${cleanTitle} - ${input.episodeCode}${extension}`;
  }

  const tags = extractReleaseTags(input.sourceName);
  const tagsSuffix = tags.length > 0 ? ` ${tags.join(" ")}` : "";
  return `${cleanTitle} - ${input.episodeCode}${tagsSuffix}${extension}`;
}

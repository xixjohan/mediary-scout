import { episodeCodeFromFileName } from "../domain/episode-code.js";

/**
 * Common media candidate info discovered in cloud drive or staging directories.
 */
export interface MediaCandidateItem {
  id: string;
  name: string;
  sizeBytes?: number | undefined;
  isFolder?: boolean | undefined;
  /** If the file resides inside a wrapper directory, the wrapper's name & id */
  wrapperFolderId?: string | undefined;
  wrapperFolderName?: string | undefined;
}

export interface RankedMovieResult {
  primary: MediaCandidateItem | null;
  redundant: MediaCandidateItem[];
  extras: MediaCandidateItem[];
}

export interface RankedTvResult {
  /** Map of episodeCode (e.g. "S01E01") to the chosen primary candidate */
  primary: Map<string, MediaCandidateItem>;
  /** Duplicate / lower-quality / alternative versions to archive */
  redundant: MediaCandidateItem[];
  /** Non-episode extras / trailers / junk to purge or archive */
  extras: MediaCandidateItem[];
  /** Files that could not be parsed into an episode code */
  unresolved: MediaCandidateItem[];
}

const VIDEO_EXTENSIONS = new Set([
  "mp4", "mkv", "ts", "m2ts", "avi", "mov", "wmv", "flv", "webm", "iso"
]);

const EXTRA_KEYWORDS = [
  "trailer", "sample", "preview", "featurette", "behind the scenes",
  "花絮", "预告", "片花", "采访", "cm", "pv", "op", "ed", "menu"
];

const JUNK_EXTENSIONS = new Set([
  "nfo", "txt", "url", "html", "htm", "torrent", "exe", "bat", "lnk"
]);

export function isVideoFile(fileName: string): boolean {
  const ext = fileName.split(".").pop()?.toLowerCase();
  return ext !== undefined && VIDEO_EXTENSIONS.has(ext);
}

export function isJunkFile(fileName: string): boolean {
  const ext = fileName.split(".").pop()?.toLowerCase();
  return ext !== undefined && JUNK_EXTENSIONS.has(ext);
}

export function isExtraOrSample(fileName: string, sizeBytes?: number): boolean {
  const lower = fileName.toLowerCase();
  if (EXTRA_KEYWORDS.some((kw) => lower.includes(kw))) return true;
  // If explicitly labelled sample or very short test file under 50MB
  if (lower.includes("sample") || (sizeBytes !== undefined && sizeBytes > 0 && sizeBytes < 40 * 1024 * 1024)) {
    return true;
  }
  return false;
}

function scoreResolution(lower: string, qualityPreference?: string): number {
  if (/2160p|4k|uhd/i.test(lower)) {
    return (qualityPreference === "4K" || qualityPreference === "high") ? 50 : 35;
  }
  if (/1080p|1080i|fhd/i.test(lower)) {
    return (qualityPreference === "1080p" || qualityPreference === "medium") ? 45 : 30;
  }
  if (/720p|hd/i.test(lower)) {
    return 10;
  }
  return 0;
}

function scoreSourceAndCodec(lower: string): number {
  let score = 0;
  if (/remux/i.test(lower)) score += 35;
  else if (/web-?dl|web-?rip/i.test(lower)) score += 25;
  else if (/bluray|blu-ray|bdrip/i.test(lower)) score += 20;
  else if (/hdtv/i.test(lower)) score += 10;

  if (/hevc|h\.?265|x265/i.test(lower)) score += 10;
  if (/dv|dolby\s*vision|杜比视界/i.test(lower)) score += 10;
  if (/hdr10\+|hdr10|hdr/i.test(lower)) score += 8;
  return score;
}

function scoreAudioAndSubtitle(lower: string): number {
  let score = 0;
  if (/atmos|杜比全景声/i.test(lower)) score += 8;
  if (/truehd|dts-hd|dts/i.test(lower)) score += 6;
  else if (/ddp|eac3|dd5\.1|ac3/i.test(lower)) score += 4;

  if (/中字|简日|繁日|chs|cht|gb|big5|baha|bilibili/i.test(lower)) score += 6;
  return score;
}

function scoreSizeSanity(fileName: string, sizeBytes?: number): number {
  if (sizeBytes === undefined || sizeBytes <= 0) return 0;
  if (/\.(iso|bdmv)$/i.test(fileName)) return -60;
  if (sizeBytes > 1024 * 1024 * 1024) return 10;
  if (sizeBytes < 200 * 1024 * 1024) return -50;
  return 0;
}

/**
 * Score a media candidate based on resolution, release source, codecs, audio, subtitles and size sanity.
 */
export function scoreMediaFile(
  fileName: string,
  sizeBytes?: number,
  qualityPreference?: string,
): number {
  const lower = fileName.toLowerCase();
  return (
    100 +
    scoreResolution(lower, qualityPreference) +
    scoreSourceAndCodec(lower) +
    scoreAudioAndSubtitle(lower) +
    scoreSizeSanity(fileName, sizeBytes)
  );
}

export interface IVersionRankerStrategy {
  rankMovieCandidates(candidates: MediaCandidateItem[], qualityPreference?: string): RankedMovieResult;
  rankTvCandidates(candidates: MediaCandidateItem[], fallbackSeason?: number, qualityPreference?: string): RankedTvResult;
}

export class DefaultVersionRanker implements IVersionRankerStrategy {
  /**
   * For movies: selects the single highest-scoring video as primary,
   * categorizes all other movie versions as redundant (to archive),
   * and separates samples/trailers as extras.
   */
  rankMovieCandidates(
    candidates: MediaCandidateItem[],
    qualityPreference?: string,
  ): RankedMovieResult {
    const validVideos: Array<{ item: MediaCandidateItem; score: number }> = [];
    const extras: MediaCandidateItem[] = [];

    for (const item of candidates) {
      if (item.isFolder) continue;
      if (!isVideoFile(item.name)) continue;

      if (isExtraOrSample(item.name, item.sizeBytes)) {
        extras.push(item);
        continue;
      }

      const score = scoreMediaFile(item.name, item.sizeBytes, qualityPreference);
      validVideos.push({ item, score });
    }

    if (validVideos.length === 0) {
      return { primary: null, redundant: [], extras };
    }

    // Sort descending by score, and break ties by sizeBytes
    validVideos.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.item.sizeBytes ?? 0) - (a.item.sizeBytes ?? 0);
    });

    const primary = validVideos[0]!.item;
    const redundant = validVideos.slice(1).map((v) => v.item);

    return { primary, redundant, extras };
  }

  /**
   * For TV/Anime: groups files by episodeCode,
   * picks the highest-scoring candidate for each episode as primary,
   * categorizes duplicates/competing versions as redundant (to archive).
   */
  rankTvCandidates(
    candidates: MediaCandidateItem[],
    fallbackSeason = 1,
    qualityPreference?: string,
  ): RankedTvResult {
    const primary = new Map<string, MediaCandidateItem>();
    const redundant: MediaCandidateItem[] = [];
    const extras: MediaCandidateItem[] = [];
    const unresolved: MediaCandidateItem[] = [];

    // Group candidates by episodeCode
    const groupedByEpisode = new Map<string, Array<{ item: MediaCandidateItem; score: number }>>();

    for (const item of candidates) {
      if (item.isFolder) continue;
      if (!isVideoFile(item.name)) continue;

      if (isExtraOrSample(item.name, item.sizeBytes)) {
        extras.push(item);
        continue;
      }

      const code = episodeCodeFromFileName(item.name, fallbackSeason);
      if (!code) {
        unresolved.push(item);
        continue;
      }

      const score = scoreMediaFile(item.name, item.sizeBytes, qualityPreference);
      const list = groupedByEpisode.get(code) ?? [];
      list.push({ item, score });
      groupedByEpisode.set(code, list);
    }

    for (const [code, list] of groupedByEpisode.entries()) {
      // Sort candidates for this episode descending by score
      list.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.item.sizeBytes ?? 0) - (a.item.sizeBytes ?? 0);
      });

      primary.set(code, list[0]!.item);
      for (let i = 1; i < list.length; i++) {
        redundant.push(list[i]!.item);
      }
    }

    return { primary, redundant, extras, unresolved };
  }
}

export const defaultVersionRanker = new DefaultVersionRanker();

export function rankMovieCandidates(
  candidates: MediaCandidateItem[],
  qualityPreference?: string,
): RankedMovieResult {
  return defaultVersionRanker.rankMovieCandidates(candidates, qualityPreference);
}

export function rankTvCandidates(
  candidates: MediaCandidateItem[],
  fallbackSeason = 1,
  qualityPreference?: string,
): RankedTvResult {
  return defaultVersionRanker.rankTvCandidates(candidates, fallbackSeason, qualityPreference);
}


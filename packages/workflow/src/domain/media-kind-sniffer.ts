export interface StoragePartitionCids {
  moviesCid?: string | null | undefined;
  tvCid?: string | null | undefined;
  animeCid?: string | null | undefined;
}

export interface SniffMediaKindInput {
  folderName: string;
  relativePath?: string | undefined;
  parentCid?: string | undefined;
  storageCids?: StoragePartitionCids | undefined;
  parsedSeason?: number | undefined;
  items?: Array<{ name: string; isFolder: boolean; type?: string }> | undefined;
  preferredCategory?: "movie" | "tv" | "anime" | "auto" | undefined;
  tmdbMediaType?: "movie" | "tv" | undefined;
}

const TV_PATH_REGEX = /(?:^|\/)(?:tv|series|剧集|电视剧|美剧|日韩剧|国产剧|华语剧|欧美剧)(?:$|\/)/i;
const ANIME_PATH_REGEX = /(?:^|\/)(?:anime|bangumi|动漫|动画|新番|日本动画)(?:$|\/)/i;
const MOVIE_PATH_REGEX = /(?:^|\/)(?:movie|movies|电影|影院|院线)(?:$|\/)/i;
const SEASON_SUBDIR_REGEX = /^(?:season\s*\d+|s\d+|specials?|sp|staff|第\s*\d+\s*季)/i;
const EPISODE_FILE_REGEX =
  /(?:[sS]\d+[eE]\d+|\b[eE][pP]?\d{1,3}\b|第\s*\d+\s*[集话期]|\[\d{2,3}(?:v\d)?\]|[-\s_]\d{2,3}(?:[-_\s\.]|$))/i;

function checkStorageCids(
  parentCid?: string,
  storageCids?: StoragePartitionCids,
): "movie" | "tv" | null {
  if (!parentCid || !storageCids) return null;
  if (storageCids.tvCid && parentCid === storageCids.tvCid) return "tv";
  if (storageCids.animeCid && parentCid === storageCids.animeCid) return "tv";
  if (storageCids.moviesCid && parentCid === storageCids.moviesCid) return "movie";
  return null;
}

function checkPathKeywords(relativePath?: string): "movie" | "tv" | null {
  if (!relativePath) return null;
  if (TV_PATH_REGEX.test(relativePath)) return "tv";
  if (ANIME_PATH_REGEX.test(relativePath)) return "tv";
  if (MOVIE_PATH_REGEX.test(relativePath)) return "movie";
  return null;
}

function checkDirectoryStructure(
  items?: Array<{ name: string; isFolder: boolean; type?: string }>,
): "movie" | "tv" | null {
  if (!items || items.length === 0) return null;

  const hasSeasonFolder = items.some((item) => item.isFolder && SEASON_SUBDIR_REGEX.test(item.name));
  if (hasSeasonFolder) return "tv";

  const videoFiles = items.filter(
    (item) => !item.isFolder && (item.type === "video" || /\.(mp4|mkv|avi|mov|iso|ts)$/i.test(item.name)),
  );

  if (videoFiles.length === 0) return null;

  const episodeMatchingFiles = videoFiles.filter((f) => EPISODE_FILE_REGEX.test(f.name));
  if (episodeMatchingFiles.length >= 2 || videoFiles.length >= 3) {
    return "tv";
  }

  if (videoFiles.length === 1 && !EPISODE_FILE_REGEX.test(videoFiles[0]!.name)) {
    return "movie";
  }

  return null;
}

function checkContextualHints(input: SniffMediaKindInput): "movie" | "tv" | null {
  const cidKind = checkStorageCids(input.parentCid, input.storageCids);
  if (cidKind) return cidKind;

  return checkPathKeywords(input.relativePath);
}

function resolveTmdbOrFallback(
  input: SniffMediaKindInput,
  structureKind: "movie" | "tv" | null,
): "movie" | "tv" {
  if (input.tmdbMediaType) {
    if (input.tmdbMediaType === "tv") return "tv";
    if (input.tmdbMediaType === "movie" && structureKind === "movie") return "movie";
    return input.tmdbMediaType;
  }

  if (structureKind === "movie") return "movie";

  const videoCount = (input.items ?? []).filter(
    (item) => !item.isFolder && (item.type === "video" || /\.(mp4|mkv|avi|mov|iso|ts)$/i.test(item.name)),
  ).length;

  return videoCount > 1 ? "tv" : "movie";
}

export function sniffMediaKind(input: SniffMediaKindInput): "movie" | "tv" {
  if (input.preferredCategory === "movie") return "movie";
  if (input.preferredCategory === "tv" || input.preferredCategory === "anime") return "tv";
  if (input.parsedSeason && input.parsedSeason > 0) return "tv";

  const structureKind = checkDirectoryStructure(input.items);
  if (structureKind === "tv") return "tv";

  const hintKind = checkContextualHints(input);
  if (hintKind) return hintKind;

  return resolveTmdbOrFallback(input, structureKind);
}

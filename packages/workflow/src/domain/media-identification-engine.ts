import {
  parseTitleWithChain,
  type TitleParseResult,
} from "./title-parse-chain.js";
import { episodeCodeFromFileName } from "./episode-code.js";

export interface MediaIdentificationResult {
  title: string;
  year?: number | null;
  tmdbId?: number | null;
  mediaType: "movie" | "tv";
  seasonNumber: number; // 电影固定为 1
  episodeNumber?: number | null; // 电影可为 null 或 1
  resolution?: string | null;
  videoCodec?: string | null;
  confidence: number; // 0-100
  suggestedCanonicalName: string;
}

const RESOLUTION_REGEX = /(?:^|[\s._\-\[])(4k|2160p|1080p|720p|480p)(?:$|[\s._\-\]])/i;
const CODEC_REGEX = /(?:^|[\s._\-\[])(hevc|h\.?265|x265|avc|h\.?264|x264|av1|vc-?1)(?:$|[\s._\-\]])/i;
const SEASON_DIR_REGEX = /^(?:season|s)\s*(\d{1,2})|第\s*(\d{1,2}|[一二三四五六七八九十]+)\s*季/i;

const CHINESE_NUM_MAP: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

export function parseSeasonFromDirName(dirName: string): number | null {
  const match = SEASON_DIR_REGEX.exec(dirName.trim());
  if (!match) return null;
  if (match[1]) return Number(match[1]);
  if (match[2]) {
    const raw = match[2];
    const n = Number(raw);
    if (!Number.isNaN(n)) return n;
    return CHINESE_NUM_MAP[raw] ?? null;
  }
  return null;
}

export function extractResolutionAndCodec(name: string): {
  resolution: string | null;
  videoCodec: string | null;
} {
  const resMatch = RESOLUTION_REGEX.exec(name);
  const codecMatch = CODEC_REGEX.exec(name);
  return {
    resolution: resMatch ? resMatch[1]!.toLowerCase() : null,
    videoCodec: codecMatch ? codecMatch[1]!.toLowerCase() : null,
  };
}

export function identifyMediaFile(params: {
  fileName: string;
  parentDirName?: string;
  grandParentDirName?: string;
  libraryType?: "movie" | "tv" | "anime" | "other";
}): MediaIdentificationResult {
  const { fileName, parentDirName, grandParentDirName, libraryType } = params;
  const { resolution, videoCodec } = extractResolutionAndCodec(fileName);

  // 1. 判断 Season 季号
  let seasonNumber = 1;
  if (parentDirName) {
    const parsedParentSeason = parseSeasonFromDirName(parentDirName);
    if (parsedParentSeason) seasonNumber = parsedParentSeason;
  }

  // 2. 解析集数 (SxxExx)
  const epCode = episodeCodeFromFileName(fileName, seasonNumber);
  let episodeNumber: number | null = null;
  if (epCode) {
    const epMatch = /[Ss](\d+)[Ee](\d+)/.exec(epCode);
    if (epMatch && epMatch[2]) {
      seasonNumber = Number(epMatch[1]);
      episodeNumber = Number(epMatch[2]);
    }
  }

  // 3. 判断媒体类型 (Movie vs TV)
  let mediaType: "movie" | "tv" = "movie";
  if (libraryType === "tv" || libraryType === "anime") {
    mediaType = "tv";
  } else if (libraryType === "movie") {
    mediaType = "movie";
  } else {
    // 根据是否提取到了集数自动判定
    mediaType = episodeNumber !== null ? "tv" : "movie";
  }

  // 4. 解析片名与年份
  // 优先从剧集/电影目录名提取，如果目录名是 Season 01，则向上取 grandParentDirName
  let targetTitleInput = fileName;
  if (parentDirName && !SEASON_DIR_REGEX.test(parentDirName)) {
    targetTitleInput = parentDirName;
  } else if (grandParentDirName) {
    targetTitleInput = grandParentDirName;
  }

  const parsedTitle: TitleParseResult | null = parseTitleWithChain({
    folderName: targetTitleInput,
    parentCategory: mediaType === "tv" ? "tv" : "movie",
    sampleFileNames: [fileName],
  });

  const title = parsedTitle?.title || cleanRawFileName(fileName);
  const year = parsedTitle?.year ?? null;
  const tmdbId = parsedTitle?.tmdbId ?? null;
  const confidence = parsedTitle ? parsedTitle.confidence : (episodeNumber ? 70 : 50);

  // 5. 生成建议的规范文件命名
  const extMatch = fileName.match(/\.[a-zA-Z0-9]+$/);
  const ext = extMatch ? extMatch[0].toLowerCase() : ".mkv";
  let suggestedCanonicalName = "";
  if (mediaType === "movie") {
    suggestedCanonicalName = year ? `${title} (${year})${ext}` : `${title}${ext}`;
  } else {
    const sStr = `S${String(seasonNumber).padStart(2, "0")}`;
    const eStr = `E${String(episodeNumber ?? 1).padStart(2, "0")}`;
    suggestedCanonicalName = `${title} - ${sStr}${eStr}${ext}`;
  }

  return {
    title,
    year,
    tmdbId,
    mediaType,
    seasonNumber,
    episodeNumber,
    resolution,
    videoCodec,
    confidence,
    suggestedCanonicalName,
  };
}

function cleanRawFileName(name: string): string {
  return name
    .replace(/\.[a-zA-Z0-9]+$/, "")
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/[._]/g, " ")
    .trim();
}

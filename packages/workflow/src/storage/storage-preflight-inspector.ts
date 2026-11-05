import type { StorageExecutor } from "../domain/ports.js";
import type { DriveFileManager, DriveFileItem } from "./drive-file-manager.js";
import { inferFileType } from "./drive-file-manager.js";
import {
  mediaLibraryFolderName,
  legacyMediaLibraryFolderName,
  tmdbIdFromMediaLibraryFolderName,
} from "../domain/media-library-folder.js";
import { episodeCodeFromFileName } from "../domain/episode-code.js";
import { parseTitleWithChain } from "../domain/title-parse-chain.js";

export interface StoragePreflightMovieResult {
  mediaKind: "movie";
  matched: boolean;
  folderId?: string | undefined;
  folderName?: string | undefined;
  completeness: "full" | "none";
  videoFiles: Array<{ id: string; name: string; sizeBytes: number }>;
}

export interface ExistingEpisodeItem {
  episodeCode: string;
  seasonNumber: number;
  episodeNumber: number;
  fileId: string;
  fileName: string;
  sizeBytes: number;
}

export interface StoragePreflightSeasonResult {
  seasonNumber: number;
  seasonDirectoryId?: string | undefined;
  completeness: "full" | "partial" | "none";
  totalEpisodes: number;
  latestAiredEpisode: number;
  existingEpisodes: ExistingEpisodeItem[];
  missingEpisodeNumbers: number[];
}

export interface StoragePreflightTvResult {
  mediaKind: "tv" | "anime";
  matched: boolean;
  showDirectoryId?: string | undefined;
  showDirectoryName?: string | undefined;
  seasons: StoragePreflightSeasonResult[];
  overallCompleteness: "full" | "partial" | "none";
}

export type StoragePreflightResult = StoragePreflightMovieResult | StoragePreflightTvResult;

export interface SeasonInspectionRequest {
  seasonNumber: number;
  totalEpisodes: number;
  latestAiredEpisode: number;
}

export interface StoragePreflightInput {
  storage: StorageExecutor | DriveFileManager;
  mediaKind: "movie" | "tv" | "anime";
  title: string;
  year?: number | string | null | undefined;
  tmdbId: number;
  categoryParentId: string;
  seasons?: SeasonInspectionRequest[] | undefined;
}

interface DirectoryListingResult {
  folders: Array<{ id: string; name: string }>;
  files: Array<{ id: string; name: string; sizeBytes: number }>;
}

/**
 * 跨驱动层统一目录读取适配器
 */
async function listDirectoryItems(
  storage: StorageExecutor | DriveFileManager,
  dirId: string,
): Promise<DirectoryListingResult> {
  if (typeof (storage as DriveFileManager).listDirectory === "function") {
    const listing = await (storage as DriveFileManager).listDirectory(dirId);
    const folders: Array<{ id: string; name: string }> = [];
    const files: Array<{ id: string; name: string; sizeBytes: number }> = [];
    for (const item of listing.items) {
      if (item.isFolder) {
        folders.push({ id: item.id, name: item.name });
      } else {
        files.push({ id: item.id, name: item.name, sizeBytes: item.sizeBytes });
      }
    }
    return { folders, files };
  }

  const executor = storage as StorageExecutor;
  const [folders, videoFiles] = await Promise.all([
    executor.listChildDirectories(dirId).catch(() => []),
    executor.listVideoFiles(dirId).catch(() => []),
  ]);

  return {
    folders: folders.map((f) => ({ id: f.id, name: f.name })),
    files: videoFiles.map((f) => ({ id: f.id, name: f.name, sizeBytes: f.sizeBytes })),
  };
}

/**
 * 匹配网盘中已存在的影视根目录
 */
export async function findExistingMediaFolder(
  storage: StorageExecutor | DriveFileManager,
  categoryParentId: string,
  target: { title: string; year?: number | string | null | undefined; tmdbId: number },
): Promise<{ id: string; name: string } | null> {
  const { folders } = await listDirectoryItems(storage, categoryParentId);
  if (folders.length === 0) return null;

  const preferredName = mediaLibraryFolderName({
    title: target.title,
    year: target.year,
    tmdbId: target.tmdbId,
  });
  const legacyName = legacyMediaLibraryFolderName({
    title: target.title,
    year: target.year,
  });

  // 1. 严格名称匹配
  const exactPreferred = folders.find((f) => f.name === preferredName);
  if (exactPreferred) return exactPreferred;

  const exactLegacy = folders.find((f) => f.name === legacyName);
  if (exactLegacy) return exactLegacy;

  // 2. {tmdb-ID} 标签提取匹配
  const tmdbTagged = folders.find((f) => tmdbIdFromMediaLibraryFolderName(f.name) === target.tmdbId);
  if (tmdbTagged) return tmdbTagged;

  // 3. 多策略标题链模糊匹配
  for (const folder of folders) {
    const parsed = parseTitleWithChain({ folderName: folder.name });
    if (!parsed) continue;

    // 若解析出 tmdbId 且吻合
    if (parsed.tmdbId && parsed.tmdbId === target.tmdbId) {
      return folder;
    }

    // 若标题一致且年份一致
    const cleanTargetTitle = target.title.toLowerCase().replace(/[\s._\-:：]+/g, "");
    const cleanFolderTitle = parsed.title.toLowerCase().replace(/[\s._\-:：]+/g, "");
    if (cleanTargetTitle === cleanFolderTitle) {
      if (!target.year || !parsed.year || Number(target.year) === parsed.year) {
        return folder;
      }
    }
  }

  return null;
}

function matchSeasonFolder(folders: Array<{ id: string; name: string }>, sNum: number) {
  const pad2 = String(sNum).padStart(2, "0");
  return folders.find((f) => {
    const name = f.name.trim();
    return (
      name.toLowerCase() === `season ${pad2}` ||
      name.toLowerCase() === `season ${sNum}` ||
      name.toLowerCase() === `season${sNum}` ||
      name.toLowerCase() === `season${pad2}` ||
      name === `第${sNum}季` ||
      name === `第${pad2}季` ||
      name.toLowerCase() === `s${pad2}` ||
      name.toLowerCase() === `s${sNum}`
    );
  });
}

async function collectMovieVideos(
  storage: StorageExecutor | DriveFileManager,
  mediaFolder: { id: string; name: string },
): Promise<Array<{ id: string; name: string; sizeBytes: number }>> {
  const { files, folders } = await listDirectoryItems(storage, mediaFolder.id);
  let videoFiles = files.filter((f) => inferFileType(f.name, false) === "video");
  if (videoFiles.length === 0 && folders.length > 0) {
    for (const sub of folders) {
      const subListing = await listDirectoryItems(storage, sub.id);
      const subVideos = subListing.files.filter((f) => inferFileType(f.name, false) === "video");
      if (subVideos.length > 0) {
        videoFiles = [...videoFiles, ...subVideos];
      }
    }
  }
  return videoFiles;
}

async function inspectMoviePreflight(
  storage: StorageExecutor | DriveFileManager,
  mediaFolder: { id: string; name: string },
): Promise<StoragePreflightMovieResult> {
  const videoFiles = await collectMovieVideos(storage, mediaFolder);
  const hasValidVideo = videoFiles.some((f) => f.sizeBytes > 50 * 1024 * 1024);
  return {
    mediaKind: "movie",
    matched: true,
    folderId: mediaFolder.id,
    folderName: mediaFolder.name,
    completeness: hasValidVideo || videoFiles.length > 0 ? "full" : "none",
    videoFiles,
  };
}

function extractSeasonEpisodes(
  candidateFiles: Array<{ id: string; name: string; sizeBytes: number }>,
  sNum: number,
): Map<number, ExistingEpisodeItem> {
  const uniqueEpisodesMap = new Map<number, ExistingEpisodeItem>();
  for (const f of candidateFiles) {
    const code = episodeCodeFromFileName(f.name);
    if (!code) continue;
    const sMatch = /[Ss](\d{1,2})[Ee](\d{1,4})/i.exec(code);
    if (sMatch?.[1] && sMatch[2]) {
      const fileSeason = Number(sMatch[1]);
      const fileEpisode = Number(sMatch[2]);
      if (fileSeason === sNum && !uniqueEpisodesMap.has(fileEpisode)) {
        uniqueEpisodesMap.set(fileEpisode, {
          episodeCode: code,
          seasonNumber: fileSeason,
          episodeNumber: fileEpisode,
          fileId: f.id,
          fileName: f.name,
          sizeBytes: f.sizeBytes,
        });
      }
    }
  }
  return uniqueEpisodesMap;
}

async function inspectSingleSeason(
  storage: StorageExecutor | DriveFileManager,
  mediaFolder: { id: string; name: string },
  showSubfolders: Array<{ id: string; name: string }>,
  showRootFiles: Array<{ id: string; name: string; sizeBytes: number }>,
  sReq: SeasonInspectionRequest,
): Promise<StoragePreflightSeasonResult> {
  const sNum = sReq.seasonNumber;
  const seasonFolder = matchSeasonFolder(showSubfolders, sNum);

  let candidateFiles: Array<{ id: string; name: string; sizeBytes: number }> = [];
  let seasonDirectoryId: string | undefined = undefined;

  if (seasonFolder) {
    seasonDirectoryId = seasonFolder.id;
    const sListing = await listDirectoryItems(storage, seasonFolder.id);
    candidateFiles = sListing.files.filter((f) => inferFileType(f.name, false) === "video");
  } else if (sNum === 1) {
    candidateFiles = showRootFiles.filter((f) => inferFileType(f.name, false) === "video");
    seasonDirectoryId = mediaFolder.id;
  }

  const uniqueEpisodesMap = extractSeasonEpisodes(candidateFiles, sNum);
  const dedupedEpisodes = Array.from(uniqueEpisodesMap.values()).sort(
    (a, b) => a.episodeNumber - b.episodeNumber,
  );
  const targetEpisodesCount = Math.max(
    sReq.latestAiredEpisode > 0 ? sReq.latestAiredEpisode : sReq.totalEpisodes,
    1,
  );

  const missingEpisodeNumbers: number[] = [];
  for (let epNum = 1; epNum <= targetEpisodesCount; epNum++) {
    if (!uniqueEpisodesMap.has(epNum)) {
      missingEpisodeNumbers.push(epNum);
    }
  }

  let completeness: "full" | "partial" | "none" = "none";
  if (dedupedEpisodes.length >= targetEpisodesCount && missingEpisodeNumbers.length === 0) {
    completeness = "full";
  } else if (dedupedEpisodes.length > 0) {
    completeness = "partial";
  }

  return {
    seasonNumber: sNum,
    seasonDirectoryId,
    completeness,
    totalEpisodes: sReq.totalEpisodes,
    latestAiredEpisode: sReq.latestAiredEpisode,
    existingEpisodes: dedupedEpisodes,
    missingEpisodeNumbers,
  };
}

async function inspectTvPreflight(
  input: StoragePreflightInput,
  mediaFolder: { id: string; name: string },
): Promise<StoragePreflightTvResult> {
  const { folders: showSubfolders, files: showRootFiles } = await listDirectoryItems(
    input.storage,
    mediaFolder.id,
  );

  const seasonsToInspect = input.seasons && input.seasons.length > 0
    ? input.seasons
    : [{ seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 }];

  const seasonResults: StoragePreflightSeasonResult[] = [];
  for (const sReq of seasonsToInspect) {
    seasonResults.push(
      await inspectSingleSeason(input.storage, mediaFolder, showSubfolders, showRootFiles, sReq),
    );
  }

  const allFull = seasonResults.every((s) => s.completeness === "full");
  const anyPresent = seasonResults.some((s) => s.completeness === "full" || s.completeness === "partial");
  const overallCompleteness: "full" | "partial" | "none" = allFull
    ? "full"
    : anyPresent
      ? "partial"
      : "none";

  return {
    mediaKind: input.mediaKind === "movie" ? "tv" : input.mediaKind,
    matched: true,
    showDirectoryId: mediaFolder.id,
    showDirectoryName: mediaFolder.name,
    seasons: seasonResults,
    overallCompleteness,
  };
}

/**
 * 订阅前置探针：探测网盘中是否已有该电影或剧集/动漫，及已有季/集情况
 */
export async function inspectStorageBeforeAcquisition(
  input: StoragePreflightInput,
): Promise<StoragePreflightResult> {
  const mediaFolder = await findExistingMediaFolder(input.storage, input.categoryParentId, {
    title: input.title,
    year: input.year,
    tmdbId: input.tmdbId,
  });

  if (!mediaFolder) {
    if (input.mediaKind === "movie") {
      return {
        mediaKind: "movie",
        matched: false,
        completeness: "none",
        videoFiles: [],
      };
    }
    return {
      mediaKind: input.mediaKind,
      matched: false,
      seasons: (input.seasons ?? []).map((s) => ({
        seasonNumber: s.seasonNumber,
        completeness: "none",
        totalEpisodes: s.totalEpisodes,
        latestAiredEpisode: s.latestAiredEpisode,
        existingEpisodes: [],
        missingEpisodeNumbers: Array.from({ length: s.latestAiredEpisode || s.totalEpisodes }, (_, i) => i + 1),
      })),
      overallCompleteness: "none",
    };
  }

  if (input.mediaKind === "movie") {
    return inspectMoviePreflight(input.storage, mediaFolder);
  }

  return inspectTvPreflight(input, mediaFolder);
}

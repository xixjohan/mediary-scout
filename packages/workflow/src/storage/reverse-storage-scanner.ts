import type { DriveFileManager } from "./drive-file-manager.js";
import { parseTitleWithChain } from "../domain/title-parse-chain.js";
import { buildTitleId } from "../domain/media-identity.js";
import type { MediaTitle, TrackedSeason } from "../domain/domain.js";
import { adoptExistingMovie, adoptExistingTvSeason } from "../execution/adopt-existing-media.js";
import { inspectStorageBeforeAcquisition } from "./storage-preflight-inspector.js";
import type { WorkflowRepository } from "../persistence/repository.js";
import type { TmdbSearchProvider } from "../providers/tmdb-provider.js";
import { sniffMediaKind, type StoragePartitionCids } from "../domain/media-kind-sniffer.js";
import { episodeCodeFromFileName } from "../domain/episode-code.js";

export interface ReverseStorageScannerOptions {
  fileManager: DriveFileManager;
  storageProvider: string;
  jobId: string;
  accountId: string;
  storageId: string;
  targetCid: string;
  category?: "movie" | "tv" | "anime" | "auto" | undefined;
  repo: WorkflowRepository;
  searchProvider?: TmdbSearchProvider | undefined;
  storageCids?: StoragePartitionCids | undefined;
  pacerDelayMs?: number | undefined;
  maxDepth?: number | undefined;
  shouldAbort?: (() => boolean) | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DiscoveredMediaFolder {
  folderId: string;
  folderName: string;
  relativePath: string;
  parsedTitle?: string | undefined;
  parsedYear?: number | undefined;
  parsedSeason?: number | undefined;
  tmdbId?: number | undefined;
  confidence: number;
}

interface ItemResolutionContext {
  fileManager: DriveFileManager;
  accountId: string;
  storageId: string;
  category: "movie" | "tv" | "anime" | "auto";
  repo: WorkflowRepository;
  searchProvider?: TmdbSearchProvider | undefined;
  storageCids?: StoragePartitionCids | undefined;
}

function processCrawledItem(
  item: { id: string; name: string; isFolder: boolean },
  current: { dirId: string; currentPath: string; depth: number },
  maxDepth: number,
  discoveredFolders: DiscoveredMediaFolder[],
  queue: Array<{ dirId: string; currentPath: string; depth: number }>,
): void {
  if (!item.isFolder) return;

  const folderPath = current.currentPath ? `${current.currentPath}/${item.name}` : item.name;
  const parsed = parseTitleWithChain({ folderName: item.name });

  if (parsed && (parsed.tmdbId || parsed.confidence >= 60)) {
    discoveredFolders.push({
      folderId: item.id,
      folderName: item.name,
      relativePath: folderPath,
      ...(parsed.title ? { parsedTitle: parsed.title } : {}),
      ...(parsed.year ? { parsedYear: parsed.year } : {}),
      ...(parsed.seasonNumber ? { parsedSeason: parsed.seasonNumber } : {}),
      ...(parsed.tmdbId ? { tmdbId: parsed.tmdbId } : {}),
      confidence: parsed.confidence,
    });
  } else if (current.depth < maxDepth) {
    queue.push({
      dirId: item.id,
      currentPath: folderPath,
      depth: current.depth + 1,
    });
  }
}

async function crawlDriveDirectories(
  options: ReverseStorageScannerOptions,
): Promise<{ folders: DiscoveredMediaFolder[]; aborted: boolean }> {
  const {
    fileManager,
    storageProvider,
    jobId,
    targetCid,
    repo,
    pacerDelayMs = storageProvider === "pan115" ? 1200 : 350,
    maxDepth = 3,
    shouldAbort,
  } = options;

  const discoveredFolders: DiscoveredMediaFolder[] = [];
  const queue: Array<{ dirId: string; currentPath: string; depth: number }> = [
    { dirId: targetCid, currentPath: "", depth: 0 },
  ];
  let scannedFolderCount = 0;

  while (queue.length > 0) {
    if (shouldAbort && shouldAbort()) {
      return { folders: discoveredFolders, aborted: true };
    }

    const current = queue.shift()!;
    scannedFolderCount++;

    if (scannedFolderCount > 1 && pacerDelayMs > 0) {
      await sleep(pacerDelayMs);
    }

    let listing;
    try {
      listing = await fileManager.listDirectory(current.dirId);
    } catch (listErr) {
      console.warn(`[reverse-scanner] failed to list dir ${current.dirId}: ${String(listErr)}`);
      continue;
    }

    for (const item of listing.items) {
      processCrawledItem(item, current, maxDepth, discoveredFolders, queue);
    }

    if (scannedFolderCount % 5 === 0 || queue.length === 0) {
      const estTotal = scannedFolderCount + queue.length;
      const percent = Math.min(50, Math.round((scannedFolderCount / Math.max(estTotal, 1)) * 50));
      await repo.updateReverseScanJob(jobId, {
        scannedFolders: scannedFolderCount,
        totalFolders: estTotal,
        discoveredTitles: discoveredFolders.length,
        progressPercent: percent,
        currentStepMessage: `已扫描 ${scannedFolderCount} 个文件夹，发现 ${discoveredFolders.length} 部疑似影视...`,
      });
    }
  }

  return { folders: discoveredFolders, aborted: false };
}

async function resolveMetadata(
  item: DiscoveredMediaFolder,
  initialKind: "movie" | "tv",
  searchProvider?: TmdbSearchProvider,
  listingItems?: Array<{ name: string; isFolder: boolean; type?: string }>,
): Promise<{
  resolvedTmdbId?: number | undefined;
  resolvedTitle: string;
  resolvedYear: number;
  mediaKind: "movie" | "tv";
  matchedPosterPath?: string | null;
  seasons?: Array<{ seasonNumber: number; totalEpisodes: number; latestAiredEpisode: number }> | undefined;
}> {
  let resolvedTmdbId = item.tmdbId;
  let resolvedTitle = item.parsedTitle ?? item.folderName;
  let resolvedYear = item.parsedYear ?? 2024;
  let mediaKind: "movie" | "tv" = initialKind;
  let matchedPosterPath: string | null = null;
  let seasons: Array<{ seasonNumber: number; totalEpisodes: number; latestAiredEpisode: number }> | undefined;

  const searchQuery = item.parsedTitle ?? item.folderName;
  if (searchProvider && searchQuery) {
    try {
      const candidates = await searchProvider.searchMedia({ query: searchQuery, page: 1 });
      const topMatch = resolvedTmdbId
        ? candidates.find((c) => c.tmdbId === resolvedTmdbId) ?? candidates[0]
        : candidates[0];
      if (topMatch) {
        if (!resolvedTmdbId) {
          resolvedTmdbId = topMatch.tmdbId;
          resolvedTitle = topMatch.title;
          resolvedYear = topMatch.year;
        }
        matchedPosterPath = topMatch.posterPath ?? null;
        if (topMatch.seasons && topMatch.seasons.length > 0) {
          seasons = topMatch.seasons.map((s) => ({
            seasonNumber: s.seasonNumber,
            totalEpisodes: s.episodeCount,
            latestAiredEpisode: s.latestAiredEpisode,
          }));
        }
        mediaKind = sniffMediaKind({
          folderName: item.folderName,
          relativePath: item.relativePath,
          parsedSeason: item.parsedSeason,
          items: listingItems,
          tmdbMediaType: topMatch.mediaType,
        });
      }
    } catch (tmdbErr) {
      console.warn(`[reverse-scanner] tmdb search failed for ${item.folderName}: ${String(tmdbErr)}`);
    }
  }

  return { resolvedTmdbId, resolvedTitle, resolvedYear, mediaKind, matchedPosterPath, seasons };
}

function buildExistingEpisodes(
  videoFiles: Array<{ id: string; name: string; sizeBytes?: number }>,
  seasonNum: number,
): Array<{ episodeCode: string; seasonNumber: number; episodeNumber: number; fileId: string; fileName: string; sizeBytes: number }> {
  const existingEpisodes: Array<{ episodeCode: string; seasonNumber: number; episodeNumber: number; fileId: string; fileName: string; sizeBytes: number }> = [];
  for (const v of videoFiles) {
    const parsedCode = episodeCodeFromFileName(v.name, seasonNum);
    const match = parsedCode ? /^S(\d+)E(\d+)$/i.exec(parsedCode) : null;
    const finalSeasonNumber = match ? Number(match[1]) : seasonNum;
    const finalEpisodeNumber = match ? Number(match[2]) : existingEpisodes.length + 1;
    const finalEpisodeCode =
      parsedCode ?? `S${String(seasonNum).padStart(2, "0")}E${String(finalEpisodeNumber).padStart(2, "0")}`;

    if (finalSeasonNumber === seasonNum) {
      existingEpisodes.push({
        episodeCode: finalEpisodeCode,
        seasonNumber: finalSeasonNumber,
        episodeNumber: finalEpisodeNumber,
        fileId: v.id,
        fileName: v.name,
        sizeBytes: v.sizeBytes ?? 0,
      });
    }
  }
  return existingEpisodes;
}

async function adoptTvSeasonMedia(input: {
  ctx: ItemResolutionContext;
  titleObj: MediaTitle;
  seasonNum: number;
  directoryId: string;
  videoFiles: Array<{ id: string; name: string; sizeBytes?: number }>;
  metaSeasons?: Array<{ seasonNumber: number; totalEpisodes: number; latestAiredEpisode: number }> | undefined;
}): Promise<boolean> {
  const { ctx, titleObj, seasonNum, directoryId, videoFiles, metaSeasons } = input;
  if (videoFiles.length === 0) return false;

  const existingEpisodes = buildExistingEpisodes(videoFiles, seasonNum);
  const targetSeason = metaSeasons?.find((s) => s.seasonNumber === seasonNum);
  const totalEpisodes = targetSeason?.totalEpisodes ?? Math.max(existingEpisodes.length, 1);
  const latestAired = targetSeason?.latestAiredEpisode ?? totalEpisodes;

  const targetCoverage = latestAired > 0 ? latestAired : totalEpisodes;
  const isFull = existingEpisodes.length >= targetCoverage && targetCoverage > 0;

  const trackedSeason: TrackedSeason = {
    id: `${titleObj.id}_s${seasonNum}`,
    mediaTitleId: titleObj.id,
    seasonNumber: seasonNum,
    status: isFull ? "completed" : "active",
    qualityPreference: "1080p",
    storageDirectoryId: directoryId,
    totalEpisodes,
    latestAiredEpisode: latestAired,
    latestAiredSource: "metadata",
  };

  await adoptExistingTvSeason({
    title: titleObj,
    season: trackedSeason,
    repository: ctx.repo,
    accountId: ctx.accountId,
    connectedStorageId: ctx.storageId,
    directoryId,
    existingEpisodes,
    isFull,
  });

  return true;
}

async function adoptDiscoveredMedia(
  ctx: ItemResolutionContext,
  item: DiscoveredMediaFolder,
  meta: {
    resolvedTmdbId: number;
    resolvedTitle: string;
    resolvedYear: number;
    mediaKind: "movie" | "tv";
    matchedPosterPath?: string | null;
    seasons?: Array<{ seasonNumber: number; totalEpisodes: number; latestAiredEpisode: number }> | undefined;
  },
  listingItems: Array<{ id: string; name: string; isFolder: boolean; sizeBytes?: number; type?: string }>,
): Promise<boolean> {
  const titleObj: MediaTitle = {
    id: buildTitleId({ source: "tmdb", mediaKind: meta.mediaKind, id: meta.resolvedTmdbId }),
    tmdbId: meta.resolvedTmdbId,
    type: meta.mediaKind,
    title: meta.resolvedTitle,
    originalTitle: meta.resolvedTitle,
    year: meta.resolvedYear,
    aliases: [],
    posterPath: meta.matchedPosterPath ?? null,
  };

  if (meta.mediaKind === "movie") {
    const videoFiles = listingItems
      .filter((f) => !f.isFolder && (f.type === "video" || /\.(mp4|mkv|avi|mov|iso|ts)$/i.test(f.name)))
      .map((f) => ({ id: f.id, name: f.name, sizeBytes: f.sizeBytes ?? 0 }));
    if (videoFiles.length === 0) return false;

    await adoptExistingMovie({
      title: titleObj,
      repository: ctx.repo,
      accountId: ctx.accountId,
      connectedStorageId: ctx.storageId,
      directoryId: item.folderId,
      videoFiles,
    });
    return true;
  }

  const seasonDirs = listingItems.filter(
    (i) => i.isFolder && (/^Season\s+\d+$/i.test(i.name) || /^第\s*\d+\s*季$/i.test(i.name)),
  );

  let adoptedAny = false;
  if (seasonDirs.length > 0) {
    for (const sDir of seasonDirs) {
      const match = /^Season\s+(\d+)$/i.exec(sDir.name) ?? /^第\s*(\d+)\s*季$/i.exec(sDir.name);
      const sNum = match ? Number(match[1]) : 1;
      let sListing;
      try {
        sListing = await ctx.fileManager.listDirectory(sDir.id);
      } catch (err) {
        console.warn(`[reverse-scanner] failed to list season dir ${sDir.id}:`, err);
        continue;
      }
      const sVideos = sListing.items
        .filter((f) => !f.isFolder && (f.type === "video" || /\.(mp4|mkv|avi|mov|iso|ts)$/i.test(f.name)))
        .map((f) => ({ id: f.id, name: f.name, sizeBytes: f.sizeBytes ?? 0 }));

      const res = await adoptTvSeasonMedia({
        ctx,
        titleObj,
        seasonNum: sNum,
        directoryId: sDir.id,
        videoFiles: sVideos,
        metaSeasons: meta.seasons,
      });
      if (res) adoptedAny = true;
    }
  } else {
    const rootVideos = listingItems
      .filter((f) => !f.isFolder && (f.type === "video" || /\.(mp4|mkv|avi|mov|iso|ts)$/i.test(f.name)))
      .map((f) => ({ id: f.id, name: f.name, sizeBytes: f.sizeBytes ?? 0 }));

    if (rootVideos.length > 0) {
      const sNum = item.parsedSeason ?? 1;
      adoptedAny = await adoptTvSeasonMedia({
        ctx,
        titleObj,
        seasonNum: sNum,
        directoryId: item.folderId,
        videoFiles: rootVideos,
        metaSeasons: meta.seasons,
      });
    }
  }

  return adoptedAny;
}

async function processDiscoveredItem(
  ctx: ItemResolutionContext,
  jobId: string,
  item: DiscoveredMediaFolder,
): Promise<{ isAdopted: boolean; isPendingReview: boolean }> {
  let listing;
  try {
    listing = await ctx.fileManager.listDirectory(item.folderId);
  } catch (err) {
    console.warn(`[reverse-scanner] failed to list dir ${item.folderId}: ${String(err)}`);
    return { isAdopted: false, isPendingReview: false };
  }

  const initialKind = sniffMediaKind({
    folderName: item.folderName,
    relativePath: item.relativePath,
    parsedSeason: item.parsedSeason,
    items: listing.items,
    preferredCategory: ctx.category,
    storageCids: ctx.storageCids,
  });

  const meta = await resolveMetadata(item, initialKind, ctx.searchProvider, listing.items);
  const confidence = meta.resolvedTmdbId ? Math.max(item.confidence, 85) : item.confidence;
  const reviewStatus = confidence >= 85 ? "auto_accepted" : confidence >= 50 ? "pending_review" : "ignored";

  let isAdopted = false;
  if (reviewStatus === "auto_accepted" && meta.resolvedTmdbId) {
    try {
      isAdopted = await adoptDiscoveredMedia(
        ctx,
        item,
        { ...meta, resolvedTmdbId: meta.resolvedTmdbId },
        listing.items,
      );
    } catch (ingestErr) {
      console.warn(`[reverse-scanner] auto-adoption failed for ${item.folderName}: ${String(ingestErr)}`);
    }
  }

  const videoFiles = listing.items.filter(
    (f) => !f.isFolder && (f.type === "video" || /\.(mp4|mkv|avi|mov|iso|ts)$/i.test(f.name)),
  );
  const discoveredFilesJson = JSON.stringify(
    videoFiles.map((v) => ({ id: v.id, name: v.name, sizeBytes: v.sizeBytes })),
  );

  await ctx.repo.createReverseScanItem({
    jobId,
    accountId: ctx.accountId,
    folderId: item.folderId,
    folderName: item.folderName,
    relativePath: item.relativePath,
    ...(item.parsedTitle ? { parsedTitle: item.parsedTitle } : {}),
    ...(item.parsedYear ? { parsedYear: item.parsedYear } : {}),
    ...(meta.resolvedTmdbId ? { matchedTmdbId: meta.resolvedTmdbId } : {}),
    matchedMediaType: meta.mediaKind,
    matchedTitle: meta.resolvedTitle,
    ...(meta.matchedPosterPath ? { matchedPosterPath: meta.matchedPosterPath } : {}),
    confidence,
    reviewStatus: isAdopted ? "auto_accepted" : reviewStatus,
    discoveredFilesJson,
  });

  return { isAdopted, isPendingReview: reviewStatus === "pending_review" };
}

export async function runReverseStorageScan(options: ReverseStorageScannerOptions): Promise<void> {
  const { jobId, accountId, storageId, category = "auto", repo, searchProvider, shouldAbort, fileManager } = options;

  try {
    await repo.updateReverseScanJob(jobId, {
      status: "scanning_directories",
      startedAt: new Date().toISOString(),
      currentStepMessage: "正在扫描网盘目录树...",
      progressPercent: 5,
    });

    const crawlResult = await crawlDriveDirectories(options);
    if (crawlResult.aborted) {
      await repo.updateReverseScanJob(jobId, { status: "paused", currentStepMessage: "扫描已暂停" });
      return;
    }

    const discoveredFolders = crawlResult.folders;
    await repo.updateReverseScanJob(jobId, {
      status: "matching_metadata",
      currentStepMessage: `目录扫描完毕，开始进行元数据匹配与落盘校验 (共 ${discoveredFolders.length} 项)...`,
      progressPercent: 55,
    });

    let autoIngestedCount = 0;
    let pendingReviewCount = 0;
    const ctx: ItemResolutionContext = {
      fileManager,
      accountId,
      storageId,
      category,
      repo,
      searchProvider,
      storageCids: options.storageCids,
    };

    for (let i = 0; i < discoveredFolders.length; i++) {
      if (shouldAbort && shouldAbort()) {
        await repo.updateReverseScanJob(jobId, { status: "paused", currentStepMessage: "扫描已暂停" });
        return;
      }

      const item = discoveredFolders[i]!;
      const result = await processDiscoveredItem(ctx, jobId, item);
      if (result.isAdopted) autoIngestedCount++;
      if (result.isPendingReview) pendingReviewCount++;

      const currentProgress = 55 + Math.round(((i + 1) / Math.max(discoveredFolders.length, 1)) * 40);
      await repo.updateReverseScanJob(jobId, {
        progressPercent: currentProgress,
        autoIngestedTitles: autoIngestedCount,
        pendingReviewTitles: pendingReviewCount,
        currentStepMessage: `正在元数据匹配与纳管 (${i + 1}/${discoveredFolders.length})...`,
      });
    }

    await repo.updateReverseScanJob(jobId, {
      status: "completed",
      progressPercent: 100,
      autoIngestedTitles: autoIngestedCount,
      pendingReviewTitles: pendingReviewCount,
      finishedAt: new Date().toISOString(),
      currentStepMessage: `扫描恢复完成！自动归档纳管 ${autoIngestedCount} 部，待确认 ${pendingReviewCount} 部。`,
    });
  } catch (error) {
    console.error(`[reverse-scanner] job ${jobId} failed:`, error);
    await repo.updateReverseScanJob(jobId, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "扫描过程中发生未知错误",
      finishedAt: new Date().toISOString(),
      currentStepMessage: "扫描失败，请检查网盘连接状态",
    });
  }
}

import {
  parseTitleWithChain,
  sniffMediaKind,
  adoptExistingMovie,
  adoptExistingTvSeason,
  buildTitleId,
  episodeCodeFromFileName,
  createTmdbSearchProvider,
  type MediaTitle,
  type TrackedSeason,
  type ExistingEpisodeItem,
  type TrackedSeasonState,
  type DriveFileManager,
} from "@media-track/workflow";
import {
  getAccountDriveFileManager,
  getWorkflowRepository,
  getAccountScopedSettings,
  getTmdbAccesses,
  buildAccountContextResolver,
} from "../../../lib/workflow-runtime";
import { seriesTargetFor } from "../../../lib/series-target";
import {
  handleMovieOrganize,
  handleTvOrganize,
} from "../titles/organize/organize-handlers";

async function queryTmdbCandidate(title: string, accountId: string) {
  const tmdbAccesses = await getTmdbAccesses(getAccountScopedSettings(accountId));
  if (tmdbAccesses.length === 0) return null;
  try {
    const searchProvider = createTmdbSearchProvider(tmdbAccesses);
    const candidates = await searchProvider.searchMedia({ query: title, page: 1 });
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

function buildAdoptedTitle(
  tmdbId: number,
  mediaKind: "movie" | "tv",
  title: string,
  year: number,
  posterPath?: string | null,
  backdropPath?: string | null,
): MediaTitle {
  return {
    id: buildTitleId({ source: "tmdb", mediaKind, id: tmdbId }),
    tmdbId,
    type: mediaKind,
    title,
    originalTitle: title,
    year,
    aliases: [],
    posterPath: posterPath ?? null,
    backdropPath: backdropPath ?? null,
  };
}

interface MediaCandidate {
  folderId: string;
  folderName: string;
  parsedTitle: string;
  year: number | null;
  type: "movie" | "tv" | "anime";
  tmdbId: number | null;
  seasonNumber: number;
  isTracked: boolean;
  videoCount: number;
  posterPath: string | null;
}

async function inspectCandidateFolder(
  folder: { id: string; name: string },
  fileManager: DriveFileManager,
  accountId: string,
  trackedStates: TrackedSeasonState[],
): Promise<MediaCandidate> {
  const parsed = parseTitleWithChain({ folderName: folder.name });
  const mediaKind = sniffMediaKind({
    folderName: folder.name,
    parsedSeason: parsed?.seasonNumber,
  });

  let resolvedTmdbId = parsed?.tmdbId ?? null;
  let title = parsed?.title ?? folder.name;
  let year = parsed?.year ?? null;
  let posterPath: string | null = null;

  if (!resolvedTmdbId && title) {
    const match = await queryTmdbCandidate(title, accountId);
    if (match) {
      resolvedTmdbId = match.tmdbId;
      title = match.title;
      year = match.year;
      posterPath = match.posterPath ?? null;
    }
  }

  const isTracked = trackedStates.some(
    (s) =>
      (resolvedTmdbId && s.title.tmdbId === resolvedTmdbId) ||
      s.title.title.toLowerCase() === title.toLowerCase(),
  );

  const childListing = await fileManager.listDirectory(folder.id).catch(() => null);
  const videoCount = childListing
    ? childListing.items.filter(
        (i) => !i.isFolder && (i.type === "video" || /\.(mp4|mkv|avi|mov|iso|ts)$/i.test(i.name)),
      ).length
    : 0;

  return {
    folderId: folder.id,
    folderName: folder.name,
    parsedTitle: title,
    year,
    type: mediaKind,
    tmdbId: resolvedTmdbId,
    seasonNumber: parsed?.seasonNumber ?? 1,
    isTracked,
    videoCount,
    posterPath,
  };
}

// ── 1. scanDriveMedia ────────────────────────────────────────────────────────

export async function executeScanDriveMedia(
  accountId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const storageId = typeof args.storageId === "string" ? args.storageId : undefined;
  const fileManager = await getAccountDriveFileManager(accountId, storageId);
  if (!fileManager) {
    return { ok: false, error: "未找到连接的网盘或网盘未配置凭据" };
  }

  const targetFolderId = typeof args.folderId === "string" ? args.folderId : "0";
  const listing = await fileManager.listDirectory(targetFolderId).catch(() => null);
  if (!listing) {
    return { ok: false, error: `无法读取网盘目录: ${targetFolderId}` };
  }

  const repo = getWorkflowRepository();
  const trackedStates = await repo.listTrackedSeasonStates({
    accountId,
    connectedStorageId: storageId ?? null,
  });

  const subFolders = listing.items.filter((item) => item.isFolder);
  const candidates: MediaCandidate[] = [];

  for (const folder of subFolders) {
    const cand = await inspectCandidateFolder(folder, fileManager, accountId, trackedStates);
    candidates.push(cand);
  }

  return {
    ok: true,
    scannedFolderId: targetFolderId,
    totalCandidates: candidates.length,
    untrackedCount: candidates.filter((c) => !c.isTracked).length,
    candidates,
  };
}

// ── 2. adoptDriveMedia ────────────────────────────────────────────────────────

async function adoptMovieCandidate(input: {
  accountId: string;
  storageId?: string | undefined;
  fileManager: DriveFileManager;
  folderId: string;
  tmdbId: number;
}): Promise<unknown> {
  const { accountId, storageId, fileManager, folderId, tmdbId } = input;
  const candidate = await queryTmdbCandidate(`tmdb:${tmdbId}`, accountId);
  const titleObj = buildAdoptedTitle(
    tmdbId,
    "movie",
    candidate?.title ?? `Movie ${tmdbId}`,
    candidate?.year ?? 2024,
    candidate?.posterPath,
    candidate?.backdropPath,
  );

  const listing = await fileManager.listDirectory(folderId).catch(() => null);
  const videoFiles = (listing?.items ?? [])
    .filter((i) => !i.isFolder && (i.type === "video" || /\.(mp4|mkv|avi|mov|iso|ts)$/i.test(i.name)))
    .map((i) => ({ id: i.id, name: i.name, sizeBytes: i.sizeBytes }));

  const runId = await adoptExistingMovie({
    title: titleObj,
    repository: getWorkflowRepository(),
    accountId,
    connectedStorageId: storageId,
    directoryId: folderId,
    videoFiles,
  });

  return {
    ok: true,
    adopted: true,
    workflowRunId: runId,
    tmdbId,
    type: "movie",
    title: titleObj.title,
    videoCount: videoFiles.length,
    message: `已成功将电影「${titleObj.title}」纳入订阅与媒体库！`,
  };
}

async function adoptTvCandidate(input: {
  accountId: string;
  storageId?: string | undefined;
  fileManager: DriveFileManager;
  folderId: string;
  tmdbId: number;
  seasonNum: number;
}): Promise<unknown> {
  const { accountId, storageId, fileManager, folderId, tmdbId, seasonNum } = input;
  const target = await seriesTargetFor(tmdbId).catch(() => null);
  const titleObj: MediaTitle =
    target?.title ?? buildAdoptedTitle(tmdbId, "tv", `TV ${tmdbId}`, 2024);

  const listing = await fileManager.listDirectory(folderId).catch(() => null);
  const directVideos = (listing?.items ?? []).filter(
    (i) => !i.isFolder && (i.type === "video" || /\.(mp4|mkv|avi|mov|iso|ts)$/i.test(i.name)),
  );

  const directEpisodes: ExistingEpisodeItem[] = directVideos.map((v, idx) => {
    const code = episodeCodeFromFileName(v.name, seasonNum);
    const epMatch = code ? /E(\d+)/i.exec(code) : null;
    const epNum = epMatch ? Number(epMatch[1]) : idx + 1;
    return {
      episodeNumber: epNum,
      seasonNumber: seasonNum,
      episodeCode: code ?? `S${String(seasonNum).padStart(2, "0")}E${String(idx + 1).padStart(2, "0")}`,
      fileId: v.id,
      fileName: v.name,
      sizeBytes: v.sizeBytes ?? 0,
    };
  });

  const targetSeason = target?.seasons.find((s) => s.seasonNumber === seasonNum);
  const totalEpisodes = targetSeason?.totalEpisodes || directEpisodes.length || 12;
  const latestAired = targetSeason?.latestAiredEpisode || totalEpisodes;
  const isFull = directEpisodes.length >= latestAired && latestAired > 0;

  const trackedSeason: TrackedSeason = {
    id: `${titleObj.id}_s${seasonNum}`,
    mediaTitleId: titleObj.id,
    seasonNumber: seasonNum,
    status: isFull ? "completed" : "active",
    qualityPreference: "1080p",
    storageDirectoryId: folderId,
    totalEpisodes,
    latestAiredEpisode: latestAired,
    latestAiredSource: "metadata",
  };

  const runId = await adoptExistingTvSeason({
    title: titleObj,
    season: trackedSeason,
    repository: getWorkflowRepository(),
    accountId,
    connectedStorageId: storageId,
    directoryId: folderId,
    existingEpisodes: directEpisodes,
    isFull,
  });

  return {
    ok: true,
    adopted: true,
    workflowRunId: runId,
    tmdbId,
    type: "tv",
    title: titleObj.title,
    seasonNumber: seasonNum,
    existingEpisodesCount: directEpisodes.length,
    totalEpisodes,
    isFull,
    message: `已成功将剧集「${titleObj.title}」第 ${seasonNum} 季纳入订阅与媒体库！`,
  };
}

export async function executeAdoptDriveMedia(
  accountId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const folderId = String(args.folderId || "").trim();
  const tmdbId = Number(args.tmdbId);
  if (!folderId) throw new Error("folderId 必须为非空字符串");
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw new Error("tmdbId 必须为有效正整数");

  const storageId = typeof args.storageId === "string" ? args.storageId : undefined;
  const fileManager = await getAccountDriveFileManager(accountId, storageId);
  if (!fileManager) {
    return { ok: false, error: "未找到连接的网盘或网盘未配置凭据" };
  }

  const mediaKind = args.type === "movie" ? "movie" : "tv";
  const seasonNum =
    typeof args.seasonNumber === "number" && Number.isInteger(args.seasonNumber) && args.seasonNumber > 0
      ? args.seasonNumber
      : 1;

  if (mediaKind === "movie") {
    return adoptMovieCandidate({ accountId, storageId, fileManager, folderId, tmdbId });
  }

  return adoptTvCandidate({ accountId, storageId, fileManager, folderId, tmdbId, seasonNum });
}

// ── 3. planOrganizeMedia ──────────────────────────────────────────────────────

async function resolveTrackedTarget(input: {
  accountId: string;
  tmdbId: number;
  seasonNumber?: number | undefined;
  storageId?: string | undefined;
  directoryId?: string | undefined;
}): Promise<
  | { ok: true; tracked: TrackedSeasonState; effectiveDirectoryId: string }
  | { ok: false; code: string; error: string }
> {
  const states = await getWorkflowRepository().listTrackedSeasonStates({
    accountId: input.accountId,
    connectedStorageId: input.storageId ?? null,
  });

  const matchedStates = states.filter((s) => s.title.tmdbId === input.tmdbId);
  if (matchedStates.length === 0) {
    return {
      ok: false,
      code: "NOT_TRACKED",
      error: `作品 TMDB ID ${input.tmdbId} 尚未纳入媒体库追踪，请先调用 adoptDriveMedia 进行认领。`,
    };
  }

  const tracked =
    matchedStates.find((s) =>
      input.seasonNumber !== undefined ? s.season?.seasonNumber === input.seasonNumber : true,
    ) ?? matchedStates[0]!;

  const effectiveDirectoryId = input.directoryId ?? tracked.season.storageDirectoryId;
  if (!effectiveDirectoryId) {
    return { ok: false, code: "NO_STORAGE_DIRECTORY", error: "该作品尚未绑定网盘目录。" };
  }

  return { ok: true, tracked, effectiveDirectoryId };
}

export async function executePlanOrganizeMedia(
  accountId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tmdbId = Number(args.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw new Error("tmdbId 必须为有效正整数");

  const seasonNumber = typeof args.seasonNumber === "number" ? args.seasonNumber : undefined;
  const storageId = typeof args.storageId === "string" ? args.storageId : undefined;
  const directoryId = typeof args.directoryId === "string" ? args.directoryId : undefined;

  const target = await resolveTrackedTarget({ accountId, tmdbId, seasonNumber, storageId, directoryId });
  if (!target.ok) return target;

  const { tracked, effectiveDirectoryId } = target;
  const accountContext = await buildAccountContextResolver()(accountId, tracked.connectedStorageId);
  const storage = accountContext?.storage;
  if (!storage) {
    return { ok: false, error: "网盘连接未就绪或凭据已失效" };
  }

  const childDirs: Array<{ id: string; name: string }> = await storage
    .listChildDirectories(effectiveDirectoryId)
    .catch(() => []);
  const stagingDirs = childDirs.filter((d) => d.name.toLowerCase().startsWith("staging-"));

  if (tracked.title.type === "movie") {
    const files = await storage.listVideoFiles(effectiveDirectoryId).catch(() => []);
    return {
      ok: true,
      tmdbId,
      type: "movie",
      title: tracked.title.title,
      sourceDirectoryId: effectiveDirectoryId,
      stagingDirectories: stagingDirs.map((d) => ({ id: d.id, name: d.name })),
      videoFilesCount: files.length,
      planKind: files.length > 0 ? "deterministic" : "noop",
      canExecute: true,
      message:
        files.length > 0
          ? `检测到电影目录包含 ${files.length} 个视频文件，可执行标准命名与版本去重归档`
          : "目录中未检测到视频文件",
    };
  }

  const effectiveSeasonNum = seasonNumber ?? tracked.season?.seasonNumber ?? 1;
  const videoFiles: Array<{ id: string; name: string }> = await storage
    .listVideoFiles(effectiveDirectoryId)
    .catch(() => []);
  const duplicateEpisodes = videoFiles.filter((v) => /\(\d+\)\.[^.]+$/i.test(v.name));

  return {
    ok: true,
    tmdbId,
    type: tracked.title.type,
    title: tracked.title.title,
    seasonNumber: effectiveSeasonNum,
    sourceDirectoryId: effectiveDirectoryId,
    stagingDirectories: stagingDirs.map((d) => ({ id: d.id, name: d.name })),
    duplicateEpisodesCount: duplicateEpisodes.length,
    videoFilesCount: videoFiles.length,
    canExecute: true,
    message: `检测到 ${stagingDirs.length} 个临时 staging 目录、${duplicateEpisodes.length} 个多版本冗余文件`,
  };
}

// ── 4. executeOrganizeMedia ───────────────────────────────────────────────────

async function runMovieOrganizeExecution(input: {
  storage: any;
  tracked: TrackedSeasonState;
  effectiveDirectoryId: string;
  accountContext: any;
  accountId: string;
  tmdbId: number;
}): Promise<unknown> {
  const { storage, tracked, effectiveDirectoryId, accountContext, accountId, tmdbId } = input;
  const res = await handleMovieOrganize({
    storage,
    title: tracked.title,
    sourceDirectoryId: effectiveDirectoryId,
    connectedStorageId: tracked.connectedStorageId,
    moviesParentDirectoryId: accountContext?.moviesParentDirectoryId,
    season: tracked.season,
    accountId,
  });
  const json = (await res.json()) as Record<string, unknown>;
  return {
    ok: res.ok,
    tmdbId,
    type: "movie",
    title: tracked.title.title,
    ...json,
  };
}

async function runTvOrganizeExecution(input: {
  storage: any;
  tracked: TrackedSeasonState;
  effectiveDirectoryId: string;
  accountContext: any;
  accountId: string;
  tmdbId: number;
  seasonNumber?: number | undefined;
}): Promise<unknown> {
  const { storage, tracked, effectiveDirectoryId, accountContext, accountId, tmdbId, seasonNumber } = input;
  const tvParentDir =
    tracked.title.type === "anime"
      ? (accountContext?.animeStorageParentDirectoryId ?? accountContext?.storageParentDirectoryId)
      : accountContext?.storageParentDirectoryId;

  const res = await handleTvOrganize({
    storage,
    title: tracked.title,
    sourceDirectoryId: effectiveDirectoryId,
    connectedStorageId: tracked.connectedStorageId,
    tvParentDirectoryId: tvParentDir,
    season: tracked.season,
    accountId,
    currentSeasonNumber: seasonNumber ?? tracked.season?.seasonNumber,
  });
  const json = (await res.json()) as Record<string, unknown>;
  return {
    ok: res.ok,
    tmdbId,
    type: tracked.title.type,
    title: tracked.title.title,
    seasonNumber: seasonNumber ?? tracked.season?.seasonNumber ?? 1,
    ...json,
  };
}

export async function executeExecuteOrganizeMedia(
  accountId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tmdbId = Number(args.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw new Error("tmdbId 必须为有效正整数");

  const seasonNumber = typeof args.seasonNumber === "number" ? args.seasonNumber : undefined;
  const storageId = typeof args.storageId === "string" ? args.storageId : undefined;

  const target = await resolveTrackedTarget({ accountId, tmdbId, seasonNumber, storageId });
  if (!target.ok) return target;

  const { tracked, effectiveDirectoryId } = target;
  const accountContext = await buildAccountContextResolver()(accountId, tracked.connectedStorageId);
  const storage = accountContext?.storage;
  if (!storage) {
    return { ok: false, error: "网盘连接未就绪或凭据已失效" };
  }

  if (tracked.title.type === "movie") {
    return runMovieOrganizeExecution({
      storage,
      tracked,
      effectiveDirectoryId,
      accountContext,
      accountId,
      tmdbId,
    });
  }

  return runTvOrganizeExecution({
    storage,
    tracked,
    effectiveDirectoryId,
    accountContext,
    accountId,
    tmdbId,
    seasonNumber,
  });
}

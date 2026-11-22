import {
  type TrackedSeasonState,
  MediaOrganizer,
  StorageArchiveAdapter,
} from "@media-track/workflow";
import {
  getWorkflowRepository,
  buildAccountContextResolver,
} from "../../../lib/workflow-runtime";
import {
  handleMovieOrganize,
  handleTvOrganize,
} from "../titles/organize/organize-handlers";

function parseOrganizeArgs(args: Record<string, unknown>) {
  const tmdbId = Number(args.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    throw new Error("tmdbId 必须为有效正整数");
  }
  return {
    tmdbId,
    seasonNumber: typeof args.seasonNumber === "number" ? args.seasonNumber : undefined,
    storageId: typeof args.storageId === "string" ? args.storageId : undefined,
    directoryId: typeof args.directoryId === "string" ? args.directoryId : undefined,
  };
}

export async function resolveTrackedTarget(input: {
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

// ── 1. planOrganizeMedia ──────────────────────────────────────────────────────

export async function executePlanOrganizeMedia(
  accountId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { tmdbId, seasonNumber, storageId, directoryId } = parseOrganizeArgs(args);
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

// ── 2. executeOrganizeMedia ───────────────────────────────────────────────────

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

async function launchAsyncOrganizeTask(input: {
  accountId: string;
  tracked: TrackedSeasonState;
  effectiveDirectoryId: string;
  accountContext: any;
  storage: any;
  tmdbId: number;
  seasonNumber?: number | undefined;
}): Promise<string> {
  const { accountId, tracked, effectiveDirectoryId, accountContext, storage, tmdbId, seasonNumber } = input;
  const runId = `organize_${tracked.title.tmdbId}_${Date.now()}`;
  const now = new Date().toISOString();
  const repo = getWorkflowRepository();

  await Promise.resolve(
    repo.saveWorkflowRunSnapshot({
      accountId,
      connectedStorageId: tracked.connectedStorageId ?? null,
      title: tracked.title,
      season: tracked.season,
      workflowRun: {
        id: runId,
        kind: "title_organize",
        status: "running",
        trackedSeasonId: tracked.season?.id ?? "",
        startedAt: now,
        finishedAt: null,
        auditEvents: [
          {
            type: "organize_started",
            message: `开始规范化整理《${tracked.title.title}》网盘文件`,
            data: { effectiveDirectoryId },
          },
        ],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
      keepCurrentEpisodes: true,
    }),
  ).catch(() => undefined);

  void (async () => {
    try {
      const result =
        tracked.title.type === "movie"
          ? await runMovieOrganizeExecution({ storage, tracked, effectiveDirectoryId, accountContext, accountId, tmdbId })
          : await runTvOrganizeExecution({ storage, tracked, effectiveDirectoryId, accountContext, accountId, tmdbId, seasonNumber });

      await Promise.resolve(
        repo.saveWorkflowRunSnapshot({
          accountId,
          connectedStorageId: tracked.connectedStorageId ?? null,
          title: tracked.title,
          season: tracked.season,
          workflowRun: {
            id: runId,
            kind: "title_organize",
            status: "succeeded",
            trackedSeasonId: tracked.season?.id ?? "",
            startedAt: now,
            finishedAt: new Date().toISOString(),
            auditEvents: [
              {
                type: "organize_completed",
                message: `《${tracked.title.title}》网盘规范化整理执行完成`,
                data: result as Record<string, unknown>,
              },
            ],
          },
          episodes: [],
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
          keepCurrentEpisodes: true,
        }),
      ).catch(() => undefined);
    } catch (err) {
      await Promise.resolve(
        repo.saveWorkflowRunSnapshot({
          accountId,
          connectedStorageId: tracked.connectedStorageId ?? null,
          title: tracked.title,
          season: tracked.season,
          workflowRun: {
            id: runId,
            kind: "title_organize",
            status: "failed",
            trackedSeasonId: tracked.season?.id ?? "",
            startedAt: now,
            finishedAt: new Date().toISOString(),
            auditEvents: [
              {
                type: "organize_failed",
                message: `《${tracked.title.title}》网盘规范化整理异常: ${String(err)}`,
                data: { error: String(err) },
              },
            ],
          },
          episodes: [],
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
          keepCurrentEpisodes: true,
        }),
      ).catch(() => undefined);
    }
  })();

  return runId;
}

export async function executeExecuteOrganizeMedia(
  accountId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { tmdbId, seasonNumber, storageId, directoryId } = parseOrganizeArgs(args);
  const asyncExecution = args.asyncExecution !== false;

  const target = await resolveTrackedTarget({ accountId, tmdbId, seasonNumber, storageId, directoryId });
  if (!target.ok) return target;

  const { tracked, effectiveDirectoryId } = target;
  const accountContext = await buildAccountContextResolver()(accountId, tracked.connectedStorageId);
  const storage = accountContext?.storage;
  if (!storage) {
    return { ok: false, error: "网盘连接未就绪或凭据已失效" };
  }

  if (asyncExecution) {
    const taskId = await launchAsyncOrganizeTask({
      accountId,
      tracked,
      effectiveDirectoryId,
      accountContext,
      storage,
      tmdbId,
      seasonNumber,
    });
    return {
      ok: true,
      mode: "async",
      taskId,
      status: "running",
      tmdbId,
      type: tracked.title.type,
      title: tracked.title.title,
      effectiveDirectoryId,
      message: `已为《${tracked.title.title}》启动后台异步规范化整理任务 (taskId: ${taskId})。请调用 queryStatus 轮询任务执行状态与整理详情。`,
    };
  }

  if (tracked.title.type === "movie") {
    return runMovieOrganizeExecution({ storage, tracked, effectiveDirectoryId, accountContext, accountId, tmdbId });
  }

  return runTvOrganizeExecution({ storage, tracked, effectiveDirectoryId, accountContext, accountId, tmdbId, seasonNumber });
}

// ── 3. cleanStagingDirectories ────────────────────────────────────────────────

export async function executeCleanStagingDirectories(
  accountId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { tmdbId, seasonNumber, storageId, directoryId } = parseOrganizeArgs(args);
  const target = await resolveTrackedTarget({ accountId, tmdbId, seasonNumber, storageId, directoryId });
  if (!target.ok) return target;

  const { tracked, effectiveDirectoryId } = target;
  const accountContext = await buildAccountContextResolver()(accountId, tracked.connectedStorageId);
  const storage = accountContext?.storage;
  if (!storage) {
    return { ok: false, error: "网盘连接未就绪或凭据已失效" };
  }

  const archiveAdapter = new StorageArchiveAdapter({
    storage,
    rootCid: accountContext?.animeStorageParentDirectoryId ?? accountContext?.storageParentDirectoryId ?? null,
  });
  const organizer = new MediaOrganizer({ storage, archiveAdapter });
  const cleanupResult = await organizer.cleanupStagingDirectories({ showDirectoryId: effectiveDirectoryId });

  return {
    ok: true,
    tmdbId,
    type: tracked.title.type,
    title: tracked.title.title,
    directoryId: effectiveDirectoryId,
    removed: cleanupResult.removed,
    remaining: cleanupResult.remaining,
    removedCount: cleanupResult.removed.length,
    remainingCount: cleanupResult.remaining.length,
    message:
      cleanupResult.removed.length > 0
        ? `成功清理 ${cleanupResult.removed.length} 个 staging 临时目录: ${cleanupResult.removed.join(", ")}`
        : cleanupResult.remaining.length > 0
          ? `检测到 ${cleanupResult.remaining.length} 个 staging 目录内仍包含视频文件，为防误删已安全保留`
          : "未检测到需要清理的 staging 临时目录",
  };
}

// ── 4. dedupeSeasonVersions ───────────────────────────────────────────────────

export async function executeDedupeSeasonVersions(
  accountId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { tmdbId, seasonNumber, storageId, directoryId } = parseOrganizeArgs(args);
  const target = await resolveTrackedTarget({ accountId, tmdbId, seasonNumber, storageId, directoryId });
  if (!target.ok) return target;

  const { tracked, effectiveDirectoryId } = target;
  const accountContext = await buildAccountContextResolver()(accountId, tracked.connectedStorageId);
  const storage = accountContext?.storage;
  if (!storage) {
    return { ok: false, error: "网盘连接未就绪或凭据已失效" };
  }

  const parentDir =
    tracked.title.type === "anime"
      ? (accountContext?.animeStorageParentDirectoryId ?? accountContext?.storageParentDirectoryId)
      : accountContext?.storageParentDirectoryId;

  const archiveAdapter = new StorageArchiveAdapter({
    storage,
    rootCid: parentDir ?? tracked.connectedStorageId ?? null,
  });
  const organizer = new MediaOrganizer({ storage, archiveAdapter });

  const dedupeResult = await organizer.dedupeSeasonDirectories({
    showDirectoryId: effectiveDirectoryId,
    title: tracked.title.title,
    type: tracked.title.type === "anime" ? "anime" : "tv",
    year: tracked.title.year,
    tmdbId: tracked.title.tmdbId,
    fallbackCategoryParentId: parentDir ?? effectiveDirectoryId,
  });

  return {
    ok: true,
    tmdbId,
    type: tracked.title.type,
    title: tracked.title.title,
    directoryId: effectiveDirectoryId,
    seasonsScanned: dedupeResult.seasonsScanned,
    archivedCount: dedupeResult.archivedCount,
    archivedItems: dedupeResult.archivedItems,
    message:
      dedupeResult.archivedCount > 0
        ? `已成功软归档 ${dedupeResult.archivedCount} 个多版本重复视频文件: ${dedupeResult.archivedItems.join(", ")}`
        : "季目录内未发现重复的多版本视频文件",
  };
}

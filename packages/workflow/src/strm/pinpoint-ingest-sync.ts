import { nativePath as path } from "../domain/native-require.js";
import type { MediaServerCoordinator } from "../mediaserver/coordinator.js";
import type { WorkflowRepository } from "../persistence/repository.js";
import type { StorageExecutor } from "../domain/ports.js";
import type { MediaTitle } from "../domain/domain.js";
import { ensureMediaLibraryDirectory, mediaLibraryFolderName } from "../domain/media-library-folder.js";
import { buildPlayUrl, safeStem, writeStrmFile } from "./strm-writer.js";
import type { StrmTask } from "./strm-types.js";
import { resolveStrmOutputPath } from "./output-path.js";

export interface LandedMediaFile {
  id: string; // 网盘内部 fileId
  name: string; // 文件名，如 "Frieren.S01E01.mkv"
  sizeBytes: number;
  subPath?: string; // 相对路径，如 "葬送的芙莉莲/Season 1"
}

export interface PinpointIngestSyncInput {
  accountId: string;
  storageId: string;
  files: LandedMediaFile[];
  repository: WorkflowRepository;
  baseUrl: string;
  categoryParentId?: string | undefined;
  mediaType?: "movie" | "show" | "tv" | "anime" | undefined;
  title?: string | undefined;
  mediaServerCoordinator?: MediaServerCoordinator | undefined;
}

export interface PinpointIngestSyncResult {
  generatedPaths: string[];
  refreshed: boolean;
}

export interface PostIngestSyncTriggerInput {
  accountId: string;
  connectedStorageId?: string | null | undefined;
  repository: WorkflowRepository;
  storage: StorageExecutor;
  title: MediaTitle;
  categoryParentId: string;
  baseUrl?: string | undefined;
  mediaServerCoordinator?: MediaServerCoordinator | undefined;
}

export interface StrmTaskMatchOptions {
  storageId: string;
  categoryParentId?: string | undefined;
  mediaType?: "movie" | "show" | "tv" | "anime" | undefined;
  title?: string | undefined;
}

export function matchStrmTasksForIngest(
  allTasks: StrmTask[],
  options: StrmTaskMatchOptions,
): StrmTask[] {
  const activeTasks = allTasks.filter(
    (t) => t.status !== "paused" && t.storageId === options.storageId && t.isActive !== false,
  );
  if (activeTasks.length === 0) return [];

  const isMovieTarget = options.mediaType === "movie";
  const isTvTarget = options.mediaType === "tv" || options.mediaType === "show" || options.mediaType === "anime";

  const isTvExclusive = (t: StrmTask) => {
    const combined = `${t.name} ${t.remotePath}`.toLowerCase();
    return /剧|tv|show|series|season/i.test(combined) && !/电影|movie/i.test(combined);
  };

  const isMovieExclusive = (t: StrmTask) => {
    const combined = `${t.name} ${t.remotePath}`.toLowerCase();
    return /电影|movie/i.test(combined) && !/剧|tv|show|series|season/i.test(combined);
  };

  const filterConflicting = (tasks: StrmTask[]) => {
    return tasks.filter((t) => {
      if (isMovieTarget && isTvExclusive(t)) return false;
      if (isTvTarget && isMovieExclusive(t)) return false;
      return true;
    });
  };

  // Rule 1: 精确 remoteFolderId 匹配
  if (options.categoryParentId) {
    const exact = filterConflicting(
      activeTasks.filter((t) => t.remoteFolderId === options.categoryParentId),
    );
    if (exact.length > 0) return exact;
  }

  // Rule 2: 远端路径包含匹配
  const pathMatches = filterConflicting(
    activeTasks.filter((t) => {
      const norm = (t.remotePath || "").replace(/\\/g, "/").toLowerCase();
      if (isMovieTarget && (norm.endsWith("/movies") || norm.endsWith("/movie") || norm.includes("/电影"))) return true;
      if (isTvTarget && (norm.endsWith("/tv") || norm.endsWith("/show") || norm.includes("/剧集") || norm.includes("/电视剧"))) return true;
      return false;
    }),
  );
  if (pathMatches.length > 0) return pathMatches;

  // Rule 3: 任务名称语义匹配
  const semanticMatches = filterConflicting(
    activeTasks.filter((t) => {
      const normName = t.name.toLowerCase();
      if (isMovieTarget && (normName.includes("电影") || normName.includes("movie"))) return true;
      if (isTvTarget && (normName.includes("剧") || normName.includes("tv") || normName.includes("show"))) return true;
      return false;
    }),
  );
  if (semanticMatches.length > 0) return semanticMatches;

  // Rule 4: 全盘监控根任务兜底 (remoteFolderId === "0" 或空)
  const rootTasks = filterConflicting(
    activeTasks.filter((t) => t.remoteFolderId === "0" || !t.remoteFolderId),
  );
  if (rootTasks.length > 0) return rootTasks;

  // 兜底返回同存储下不冲突的全部任务
  return filterConflicting(activeTasks);
}

function shouldIncludeFile(
  file: LandedMediaFile,
  allowedExts: Set<string>,
  minBytes: number,
  excludeRegex: RegExp | null,
): boolean {
  const ext = path.extname(file.name).toLowerCase().replace(/^\./, "");
  if (!allowedExts.has(ext)) return false;
  if (file.sizeBytes < minBytes) return false;
  if (excludeRegex && excludeRegex.test(file.name)) return false;
  return true;
}

interface TaskExecutionSyncResult {
  generatedPaths: string[];
  relativeSubPaths: string[];
}

async function writeStrmFilesForTask(
  task: StrmTask,
  files: LandedMediaFile[],
  baseUrl: string,
): Promise<TaskExecutionSyncResult> {
  const outputDir = resolveStrmOutputPath(task.localOutputDir);
  const allowedExts = new Set(
    task.extensions
      .split(";")
      .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
      .filter(Boolean),
  );
  const minBytes = task.minFileSizeMb > 0 ? task.minFileSizeMb * 1024 * 1024 : 0;
  const excludeRegex = task.excludeKeywords?.trim()
    ? new RegExp(task.excludeKeywords.trim(), "i")
    : null;

  const generatedPaths: string[] = [];
  const relativeSubPaths: string[] = [];

  for (const file of files) {
    if (!shouldIncludeFile(file, allowedExts, minBytes, excludeRegex)) continue;

    const fileStem = path.parse(file.name).name;
    const stem = safeStem(fileStem);
    const strmFileName = `${stem}.strm`;
    const targetDir = file.subPath
      ? path.join(outputDir, file.subPath)
      : outputDir;
    const targetFilePath = path.join(targetDir, strmFileName);
    const playUrl = buildPlayUrl(baseUrl, task.id, file.id, file.name);

    await writeStrmFile({ targetFilePath, playUrl });
    generatedPaths.push(targetFilePath);

    const rel = file.subPath
      ? path.posix.join(file.subPath.replace(/\\/g, "/"), strmFileName)
      : strmFileName;
    relativeSubPaths.push(rel);
  }
  return { generatedPaths, relativeSubPaths };
}

async function executeTaskSync(
  task: StrmTask,
  files: LandedMediaFile[],
  accountId: string,
  baseUrl: string,
  repository: WorkflowRepository,
): Promise<TaskExecutionSyncResult> {
  const startTime = Date.now();
  let recordId: string | undefined;

  try {
    const rec = await repository.createStrmExecutionRecord({
      taskId: task.id,
      taskName: task.name,
      accountId,
      triggerSource: "pinpoint_ingest",
      status: "running",
      scannedCount: files.length,
    });
    recordId = rec.id;
  } catch {
    // non-blocking
  }

  try {
    const res = await writeStrmFilesForTask(task, files, baseUrl);
    if (recordId) {
      await repository
        .updateStrmExecutionRecord({
          id: recordId,
          status: "succeeded",
          scannedCount: files.length,
          generatedCount: res.generatedPaths.length,
          updatedCount: 0,
          removedCount: 0,
          durationMs: Date.now() - startTime,
        })
        .catch(() => {});
    }
    return res;
  } catch (err: unknown) {
    if (recordId) {
      await repository
        .updateStrmExecutionRecord({
          id: recordId,
          status: "failed",
          scannedCount: files.length,
          generatedCount: 0,
          durationMs: Date.now() - startTime,
          errorMessage: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {});
    }
    return { generatedPaths: [], relativeSubPaths: [] };
  }
}

export async function syncPinpointIngestedFiles(
  input: PinpointIngestSyncInput,
): Promise<PinpointIngestSyncResult> {
  const { accountId, storageId, files, repository, baseUrl, mediaServerCoordinator } = input;
  if (!files || files.length === 0) {
    return { generatedPaths: [], refreshed: false };
  }

  const allTasks = await repository.listStrmTasks(accountId);
  const matchedTasks = matchStrmTasksForIngest(allTasks, {
    storageId,
    categoryParentId: input.categoryParentId,
    mediaType: input.mediaType,
    title: input.title,
  });

  if (matchedTasks.length === 0) {
    return { generatedPaths: [], refreshed: false };
  }

  const allGeneratedPaths: string[] = [];
  let refreshed = false;

  for (const task of matchedTasks) {
    const taskRes = await executeTaskSync(task, files, accountId, baseUrl, repository);
    for (const p of taskRes.generatedPaths) {
      allGeneratedPaths.push(p);
    }
    if (taskRes.generatedPaths.length > 0 && mediaServerCoordinator) {
      const coordinator = mediaServerCoordinator as any;
      if (typeof coordinator.notifyTaskFilesChanged === "function") {
        coordinator.notifyTaskFilesChanged({
          accountId,
          taskId: task.id,
          taskName: task.name,
          storageId,
          localOutputDir: task.localOutputDir,
          mediaType: input.mediaType === "movie" ? "movie" : "show",
          mediaServerId: task.mediaServerId,
          mediaLibraryId: task.mediaLibraryId,
          mediaLibraryName: task.mediaLibraryName,
          generatedPaths: taskRes.generatedPaths,
          relativeSubPaths: taskRes.relativeSubPaths,
        });
      } else {
        mediaServerCoordinator.notifyFilesChanged(accountId, taskRes.generatedPaths);
      }
      refreshed = true;
    }
  }

  return { generatedPaths: allGeneratedPaths, refreshed };
}

async function collectLandedFiles(
  storage: StorageExecutor,
  title: MediaTitle,
  targetDirId: string,
): Promise<LandedMediaFile[]> {
  const canonicalFolder = mediaLibraryFolderName({
    title: title.title,
    year: title.year ?? "—",
    tmdbId: title.tmdbId,
  });

  const landedFiles: LandedMediaFile[] = [];
  if (title.type === "movie") {
    try {
      const vFiles = await storage.listVideoFiles(targetDirId);
      for (const vf of vFiles) {
        landedFiles.push({
          id: vf.id,
          name: vf.name,
          sizeBytes: vf.sizeBytes,
          subPath: canonicalFolder,
        });
      }
    } catch (err) {
      console.warn(`[triggerPostIngestSync] listVideoFiles failed for movie ${targetDirId}:`, err);
    }
    return landedFiles;
  }

  try {
    const childDirs = await storage.listChildDirectories(targetDirId);
    for (const child of childDirs) {
      const sFiles = await storage.listVideoFiles(child.id);
      for (const sf of sFiles) {
        landedFiles.push({
          id: sf.id,
          name: sf.name,
          sizeBytes: sf.sizeBytes,
          subPath: path.posix.join(canonicalFolder, child.name),
        });
      }
    }
  } catch {
    try {
      const sFiles = await storage.listVideoFiles(targetDirId);
      for (const sf of sFiles) {
        landedFiles.push({
          id: sf.id,
          name: sf.name,
          sizeBytes: sf.sizeBytes,
          subPath: canonicalFolder,
        });
      }
    } catch (err) {
      console.warn(`[triggerPostIngestSync] listVideoFiles failed for series ${targetDirId}:`, err);
    }
  }
  return landedFiles;
}

/**
 * 入库成功后的精准 STRM 生成与影视库防抖刷新联动
 * 严格遵循故障隔离原则：外部影视库或 STRM 异常绝不影响入库主流程成功结果。
 */
export async function triggerPostIngestSync(input: PostIngestSyncTriggerInput): Promise<void> {
  const { accountId, repository, storage, title, categoryParentId, baseUrl, mediaServerCoordinator } = input;
  let effectiveStorageId = input.connectedStorageId;

  // 缺省/未绑定存储 ID 时的自动降级解析
  if (!effectiveStorageId) {
    try {
      const storages = await repository.listConnectedStorages(accountId);
      const activeStorage = storages.find((s) => s.status === "active") ?? storages[0];
      if (activeStorage) {
        effectiveStorageId = activeStorage.id;
      }
    } catch {
      // non-blocking
    }
  }

  if (!effectiveStorageId) return;

  try {
    const allTasks = await repository.listStrmTasks(accountId);
    const matchedTasks = matchStrmTasksForIngest(allTasks, {
      storageId: effectiveStorageId,
      categoryParentId,
      mediaType: title.type,
      title: title.title,
    });
    if (matchedTasks.length === 0) return;

    const targetDirId = await ensureMediaLibraryDirectory({
      executor: storage,
      parentId: categoryParentId,
      title: title.title,
      year: title.year ?? "—",
      tmdbId: title.tmdbId,
    });

    const landedFiles = await collectLandedFiles(storage, title, targetDirId);
    if (landedFiles.length > 0) {
      const resolvedBaseUrl = baseUrl || process.env.APP_BASE_URL || "http://127.0.0.1:3000";
      await syncPinpointIngestedFiles({
        accountId,
        storageId: effectiveStorageId,
        files: landedFiles,
        categoryParentId,
        mediaType: title.type,
        title: title.title,
        repository,
        baseUrl: resolvedBaseUrl,
        mediaServerCoordinator,
      });
    }
  } catch (err) {
    console.error("[triggerPostIngestSync] Failed to sync pinpoint ingested files:", err);
  }
}

export async function triggerPostIngestSyncIfSucceeded(
  status: string,
  input: PostIngestSyncTriggerInput,
): Promise<void> {
  if (status === "succeeded") {
    await triggerPostIngestSync(input);
  }
}

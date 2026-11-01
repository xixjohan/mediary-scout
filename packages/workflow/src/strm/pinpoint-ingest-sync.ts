import { nativePath as path } from "../domain/native-require.js";
import type { MediaServerCoordinator } from "../mediaserver/coordinator.js";
import type { WorkflowRepository } from "../persistence/repository.js";
import type { StorageExecutor } from "../domain/ports.js";
import type { MediaTitle } from "../domain/domain.js";
import { ensureMediaLibraryDirectory } from "../domain/media-library-folder.js";
import { buildPlayUrl, safeStem, writeStrmFile } from "./strm-writer.js";
import type { StrmTask } from "./strm-types.js";

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
  mediaServerCoordinator?: MediaServerCoordinator | undefined;
}

export interface PinpointIngestSyncResult {
  generatedPaths: string[];
  refreshed: boolean;
}

export interface PostIngestSyncTriggerInput {
  accountId: string;
  connectedStorageId: string | null | undefined;
  repository: WorkflowRepository;
  storage: StorageExecutor;
  title: MediaTitle;
  categoryParentId: string;
  baseUrl?: string | undefined;
  mediaServerCoordinator?: MediaServerCoordinator | undefined;
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

async function writeStrmFilesForTask(
  task: StrmTask,
  files: LandedMediaFile[],
  baseUrl: string,
): Promise<string[]> {
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

  const paths: string[] = [];
  for (const file of files) {
    if (!shouldIncludeFile(file, allowedExts, minBytes, excludeRegex)) continue;

    const stem = safeStem(file.name);
    const strmFileName = `${stem}.strm`;
    const targetDir = file.subPath
      ? path.join(task.localOutputDir, file.subPath)
      : task.localOutputDir;
    const targetFilePath = path.join(targetDir, strmFileName);
    const playUrl = buildPlayUrl(baseUrl, task.storageId, file.id, file.name);

    await writeStrmFile({ targetFilePath, playUrl });
    paths.push(targetFilePath);
  }
  return paths;
}

async function executeTaskSync(
  task: StrmTask,
  files: LandedMediaFile[],
  accountId: string,
  baseUrl: string,
  repository: WorkflowRepository,
): Promise<string[]> {
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
    const generated = await writeStrmFilesForTask(task, files, baseUrl);
    if (recordId) {
      await repository
        .updateStrmExecutionRecord({
          id: recordId,
          status: "succeeded",
          scannedCount: files.length,
          generatedCount: generated.length,
          updatedCount: 0,
          removedCount: 0,
          durationMs: Date.now() - startTime,
        })
        .catch(() => {});
    }
    return generated;
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
    return [];
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
  const activeTasks = allTasks.filter(
    (t) => t.status !== "paused" && t.storageId === storageId,
  );
  if (activeTasks.length === 0) {
    return { generatedPaths: [], refreshed: false };
  }

  const generatedPaths: string[] = [];
  for (const task of activeTasks) {
    const taskPaths = await executeTaskSync(task, files, accountId, baseUrl, repository);
    for (const p of taskPaths) {
      generatedPaths.push(p);
    }
  }

  let refreshed = false;
  if (generatedPaths.length > 0 && mediaServerCoordinator) {
    mediaServerCoordinator.notifyFilesChanged(accountId, generatedPaths);
    refreshed = true;
  }

  return { generatedPaths, refreshed };
}

async function collectLandedFiles(
  storage: StorageExecutor,
  title: MediaTitle,
  targetDirId: string,
): Promise<LandedMediaFile[]> {
  const landedFiles: LandedMediaFile[] = [];
  if (title.type === "movie") {
    try {
      const vFiles = await storage.listVideoFiles(targetDirId);
      for (const vf of vFiles) {
        landedFiles.push({ id: vf.id, name: vf.name, sizeBytes: vf.sizeBytes });
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
          subPath: path.posix.join(title.title, child.name),
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
          subPath: title.title,
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
  const { accountId, connectedStorageId, repository, storage, title, categoryParentId, baseUrl, mediaServerCoordinator } = input;
  if (!connectedStorageId) return;

  try {
    const allTasks = await repository.listStrmTasks(accountId);
    const activeTasks = allTasks.filter(
      (t) => t.status !== "paused" && t.storageId === connectedStorageId,
    );
    if (activeTasks.length === 0) return;

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
        storageId: connectedStorageId,
        files: landedFiles,
        repository,
        baseUrl: resolvedBaseUrl,
        mediaServerCoordinator,
      });
    }
  } catch (err) {
    console.error("[triggerPostIngestSync] Failed to sync pinpoint ingested files:", err);
  }
}

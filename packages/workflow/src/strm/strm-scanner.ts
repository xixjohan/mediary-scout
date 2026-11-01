import { nativeFs as fs, nativePath as path } from "../domain/native-require.js";
import type { DriveFileManager, DriveFileItem } from "../storage/drive-file-manager.js";
import type { StorageExecutor } from "../domain/ports.js";
import type { PackageTreeFile, VerifiedFile } from "../domain/domain.js";
import type { StrmTask } from "./strm-types.js";
import { buildPlayUrl, safeStem, writeStrmFile } from "./strm-writer.js";

export interface StrmScanResult {
  scannedCount: number;
  generatedCount: number;
  updatedCount: number;
  removedCount: number;
  protected: boolean;
  protectReason?: string;
  generatedPaths: string[];
}

export interface StrmScanProgress {
  phase: "scanning_remote" | "filtering" | "scanning_local" | "generating" | "cleaning_orphans" | "completed";
  percent: number;
  scannedCount: number;
  generatedCount: number;
  updatedCount: number;
  removedCount: number;
  message: string;
}

export interface StrmScanOptions {
  task: StrmTask;
  storage: StorageExecutor | DriveFileManager;
  baseUrl: string;
  forceAllowEmptyCleanup?: boolean;
  onProgress?: (progress: StrmScanProgress) => Promise<void> | void;
}

export class StrmScanner {
  private async fetchRemoteFiles(
    storage: StorageExecutor | DriveFileManager,
    folderId: string,
  ): Promise<VerifiedFile[]> {
    if (typeof (storage as DriveFileManager).listDirectory === "function") {
      const listing = await (storage as DriveFileManager).listDirectory(folderId);
      return listing.items
        .filter((it: DriveFileItem) => !it.isFolder)
        .map((it: DriveFileItem) => ({
          id: it.id,
          storageDirectoryId: folderId,
          name: it.name,
          sizeBytes: it.sizeBytes,
          episodeCode: null,
          providerFileId: it.id,
        }));
    }

    try {
      return await (storage as StorageExecutor).listVideoFiles(folderId);
    } catch {
      const tree = await (storage as StorageExecutor).listTree({ directoryId: folderId });
      return tree.map((f: PackageTreeFile) => ({
        id: f.providerFileId,
        storageDirectoryId: folderId,
        name: path.basename(f.path),
        sizeBytes: f.sizeBytes,
        episodeCode: null,
        providerFileId: f.providerFileId,
      }));
    }
  }

  private filterValidFiles(remoteFiles: VerifiedFile[], task: StrmTask): VerifiedFile[] {
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

    return remoteFiles.filter((f) => {
      const ext = path.extname(f.name).toLowerCase().replace(/^\./, "");
      if (!allowedExts.has(ext)) return false;
      if (f.sizeBytes < minBytes) return false;
      if (excludeRegex && excludeRegex.test(f.name)) return false;
      return true;
    });
  }

  private scanLocalStrmFiles(localDir: string): Map<string, string> {
    const localMap = new Map<string, string>();
    if (!fs.existsSync(localDir)) return localMap;

    const walk = (curDir: string, relBase = "") => {
      const entries = fs.readdirSync(curDir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(curDir, e.name);
        const rel = path.join(relBase, e.name).replace(/\\/g, "/");
        if (e.isDirectory()) {
          walk(full, rel);
        } else if (e.isFile() && e.name.toLowerCase().endsWith(".strm")) {
          localMap.set(rel, full);
        }
      }
    };
    walk(localDir);
    return localMap;
  }

  private async syncSingleFile(
    rf: VerifiedFile,
    task: StrmTask,
    baseUrl: string,
    localStrmMap: Map<string, string>,
    result: StrmScanResult,
  ): Promise<string> {
    const stem = path.parse(rf.name).name;
    const safeName = safeStem(stem) + ".strm";
    const relStrmPath = safeName.replace(/\\/g, "/");
    const targetFullPath = path.join(task.localOutputDir, safeName);
    const playUrl = buildPlayUrl(baseUrl, task.storageId, rf.id, rf.name);

    if (!localStrmMap.has(relStrmPath)) {
      await writeStrmFile({ targetFilePath: targetFullPath, playUrl });
      result.generatedCount++;
      result.generatedPaths.push(targetFullPath);
    } else if (task.scanMode === "incremental_update" || task.scanMode === "full_sync") {
      try {
        const currentContent = fs.readFileSync(targetFullPath, "utf8").trim();
        if (currentContent !== playUrl.trim()) {
          await writeStrmFile({ targetFilePath: targetFullPath, playUrl });
          result.updatedCount++;
          result.generatedPaths.push(targetFullPath);
        }
      } catch {
        // non-blocking
      }
    }
    return relStrmPath;
  }

  private cleanOrphanFiles(
    localStrmMap: Map<string, string>,
    expectedLocalRels: Set<string>,
    result: StrmScanResult,
  ): void {
    for (const [relPath, fullPath] of localStrmMap.entries()) {
      if (!expectedLocalRels.has(relPath)) {
        try {
          fs.unlinkSync(fullPath);
          result.removedCount++;
        } catch {
          // ignore unlink error
        }
      }
    }
  }

  private checkEmptyProtect(
    task: StrmTask,
    validRemoteCount: number,
    localStrmCount: number,
    forceAllowEmptyCleanup: boolean,
  ): string | null {
    if (
      task.scanMode === "full_sync" &&
      validRemoteCount === 0 &&
      localStrmCount > 0 &&
      !forceAllowEmptyCleanup
    ) {
      return `远端网盘返回0个有效媒体文件，但本地存在 ${localStrmCount} 个STRM文件，空保护已触发拦截清理。`;
    }
    return null;
  }

  private async syncAllValidFiles(
    validRemoteFiles: VerifiedFile[],
    task: StrmTask,
    baseUrl: string,
    localStrmMap: Map<string, string>,
    result: StrmScanResult,
    onProgress?: (progress: StrmScanProgress) => Promise<void> | void,
  ): Promise<Set<string>> {
    const expectedLocalRels = new Set<string>();
    const totalValid = validRemoteFiles.length;

    for (let idx = 0; idx < totalValid; idx++) {
      const rf = validRemoteFiles[idx];
      if (!rf) continue;
      const relStrmPath = await this.syncSingleFile(rf, task, baseUrl, localStrmMap, result);
      expectedLocalRels.add(relStrmPath);

      if (idx % 20 === 0 || idx === totalValid - 1) {
        const genPercent = Math.min(85, Math.floor(30 + (idx / Math.max(1, totalValid)) * 55));
        await onProgress?.({
          phase: "generating",
          percent: genPercent,
          scannedCount: totalValid,
          generatedCount: result.generatedCount,
          updatedCount: result.updatedCount,
          removedCount: 0,
          message: `正在生成/比对 STRM 文件 (${idx + 1}/${totalValid})...`,
        });
      }
    }
    return expectedLocalRels;
  }

  async runScan(options: StrmScanOptions): Promise<StrmScanResult> {
    const { task, storage, baseUrl, forceAllowEmptyCleanup = false, onProgress } = options;
    const result: StrmScanResult = {
      scannedCount: 0,
      generatedCount: 0,
      updatedCount: 0,
      removedCount: 0,
      protected: false,
      generatedPaths: [],
    };

    await onProgress?.({
      phase: "scanning_remote",
      percent: 5,
      scannedCount: 0,
      generatedCount: 0,
      updatedCount: 0,
      removedCount: 0,
      message: "正在遍历远端网盘目录...",
    });

    const remoteFiles = await this.fetchRemoteFiles(storage, task.remoteFolderId);
    const validRemoteFiles = this.filterValidFiles(remoteFiles, task);
    result.scannedCount = validRemoteFiles.length;

    await onProgress?.({
      phase: "filtering",
      percent: 20,
      scannedCount: remoteFiles.length,
      generatedCount: 0,
      updatedCount: 0,
      removedCount: 0,
      message: `已获取远端 ${remoteFiles.length} 个条目，匹配到 ${validRemoteFiles.length} 个有效媒体...`,
    });

    const localStrmMap = this.scanLocalStrmFiles(task.localOutputDir);

    await onProgress?.({
      phase: "scanning_local",
      percent: 30,
      scannedCount: validRemoteFiles.length,
      generatedCount: 0,
      updatedCount: 0,
      removedCount: 0,
      message: `匹配到 ${validRemoteFiles.length} 个有效媒体，已检索到 ${localStrmMap.size} 个本地 STRM`,
    });

    const protectReason = this.checkEmptyProtect(
      task,
      validRemoteFiles.length,
      localStrmMap.size,
      forceAllowEmptyCleanup,
    );
    if (protectReason) {
      result.protected = true;
      result.protectReason = protectReason;
      await onProgress?.({
        phase: "completed",
        percent: 100,
        scannedCount: 0,
        generatedCount: 0,
        updatedCount: 0,
        removedCount: 0,
        message: protectReason,
      });
      return result;
    }

    const expectedLocalRels = await this.syncAllValidFiles(
      validRemoteFiles,
      task,
      baseUrl,
      localStrmMap,
      result,
      onProgress,
    );

    if (task.scanMode === "full_sync") {
      await onProgress?.({
        phase: "cleaning_orphans",
        percent: 90,
        scannedCount: validRemoteFiles.length,
        generatedCount: result.generatedCount,
        updatedCount: result.updatedCount,
        removedCount: result.removedCount,
        message: "正在清理远端已不存在的本地孤儿 STRM 文件...",
      });
      this.cleanOrphanFiles(localStrmMap, expectedLocalRels, result);
    }

    await onProgress?.({
      phase: "completed",
      percent: 100,
      scannedCount: result.scannedCount,
      generatedCount: result.generatedCount,
      updatedCount: result.updatedCount,
      removedCount: result.removedCount,
      message: `同步完成: 匹配 ${result.scannedCount} 个媒体，新增 ${result.generatedCount}，更新 ${result.updatedCount}，清理 ${result.removedCount} 个孤儿文件`,
    });

    return result;
  }
}

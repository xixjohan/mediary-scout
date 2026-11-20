import { nativeFs as fs, nativePath as path } from "../domain/native-require.js";
import type { DriveFileManager, DriveFileItem } from "../storage/drive-file-manager.js";
import type { StorageExecutor } from "../domain/ports.js";
import type { PackageTreeFile, VerifiedFile } from "../domain/domain.js";
import type { StrmTask } from "./strm-types.js";
import { resolveStrmOutputPath } from "./output-path.js";
import { buildPlayUrl, safeDirSegments, safeStem, writeStrmFile, removeStrmFile } from "./strm-writer.js";
import { judgeStrmContent } from "./strm-token-heal.js";
import { cleanMediaTitle, episodeCodeFromFileName } from "../domain/episode-code.js";

export interface StrmScanResult {
  scannedCount: number;
  generatedCount: number;
  updatedCount: number;
  removedCount: number;
  protected: boolean;
  protectReason?: string;
  generatedPaths: string[];
  /** 本轮被删除的 `.strm` 绝对路径。媒体服务器要据此刷新，否则条目要等下次
   *  全库扫描才消失（期间用户点开是 404）。 */
  removedPaths: string[];
  /** 远端遍历失败时的错误（此时未生成、未删除任何文件）。 */
  traversalError?: string;
  /** 本轮跳过清理的原因（遍历失败 / 空盘保护 / 超过删除比例）。写进执行记录，
   *  让 `removedCount: 0` 可解释——「没有孤儿」与「没跑清理」必须能区分。 */
  cleanupSkippedReason?: string;
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

/** 远端遍历的结果：**完整性与文件列表是一个整体**，不能拆成两件事。
 *
 *  缺陷原型（2026-11-19）：旧实现的 `catch { return [] }` 让「目录真的空了」与
 *  「这次没看到」（令牌过期、网络抖动、目录被改名）完全不可区分。清理绑定在
 *  full_sync 上时后果有限，一旦放开到所有模式，一次令牌过期就能清空整库。
 *
 *  因此失败必须显式表达为 `ok: false`，调用方据此**拒绝删除**——与
 *  `classifySearchSourceFault` 同一条教义：不猜。 */
export type RemoteTraversal =
  | { ok: true; files: VerifiedFile[] }
  | { ok: false; reason: "list_failed"; error: string };

export class StrmScanner {
  private async fetchRemoteFiles(
    storage: StorageExecutor | DriveFileManager,
    folderId: string,
    maxDepth = 8,
  ): Promise<RemoteTraversal> {
    if (typeof (storage as DriveFileManager).listDirectory === "function") {
      const results: VerifiedFile[] = [];
      const dfm = storage as DriveFileManager;

      const walk = async (dirId: string, prefix: string, depth: number): Promise<void> => {
        if (depth > maxDepth) return;
        const listing = await dfm.listDirectory(dirId);
        for (const it of listing.items) {
          if (it.isFolder) {
            await walk(it.id, `${prefix}${it.name}/`, depth + 1);
          } else {
            results.push({
              id: it.id,
              storageDirectoryId: dirId,
              name: it.name,
              sizeBytes: it.sizeBytes,
              episodeCode: null,
              providerFileId: it.id,
              relativePath: `${prefix}${it.name}`,
            });
          }
        }
      };

      try {
        await walk(folderId, "", 1);
        return { ok: true, files: results };
      } catch (error) {
        // 任意一层目录失败 ⇒ 这份结果不能作为「哪些文件被删了」的依据。
        return { ok: false, reason: "list_failed", error: error instanceof Error ? error.message : String(error) };
      }
    }

    if (typeof (storage as StorageExecutor).listTree === "function") {
      try {
        const tree = await (storage as StorageExecutor).listTree({ directoryId: folderId, maxDepth });
        if (tree && tree.length > 0) {
          return {
            ok: true,
            files: tree.map((f: PackageTreeFile) => ({
              id: f.providerFileId,
              storageDirectoryId: folderId,
              name: path.basename(f.path),
              sizeBytes: f.sizeBytes,
              episodeCode: null,
              providerFileId: f.providerFileId,
              relativePath: f.path,
            })),
          };
        }
      } catch {
        // listTree 失败不再「回落成空数组」——直接降级到 listVideoFiles 一次，
        // 两者都失败才算遍历失败（下面统一处理）。
      }
    }

    try {
      const files = await (storage as StorageExecutor).listVideoFiles(folderId);
      return {
        ok: true,
        files: files.map((f) => ({
          ...f,
          relativePath: f.name,
        })),
      };
    } catch (error) {
      // 曾经的 `return []` 把「失败」伪装成「没有文件」——正是删除路径最危险的输入。
      return { ok: false, reason: "list_failed", error: error instanceof Error ? error.message : String(error) };
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

  /**
   * Derive a canonical STRM stem for a video file, normalizing episode tokens
   * (e.g. "Title - S01E02") for optimal media server (Emby/Jellyfin/Plex) scraping.
   */
  private canonicalStrmStem(rfName: string, safeSegments: string[]): string {
    const originalStem = path.parse(rfName).name;

    // Detect if inside a Season directory (e.g. "Season 01")
    let seasonNumber = 1;
    let titleSegment = "";
    for (let i = 0; i < safeSegments.length; i++) {
      const seg = safeSegments[i] ?? "";
      const seasonMatch = /^Season\s+(\d+)$/i.exec(seg);
      if (seasonMatch && seasonMatch[1]) {
        seasonNumber = Number(seasonMatch[1]);
        titleSegment = safeSegments[i - 1] ?? "";
        break;
      }
    }

    const epCode = episodeCodeFromFileName(rfName, seasonNumber);
    if (!epCode) {
      return safeStem(originalStem);
    }

    const cleanTitle = titleSegment ? cleanMediaTitle(titleSegment) : "";
    if (cleanTitle) {
      return safeStem(`${cleanTitle} - ${epCode}`);
    }
    return safeStem(epCode);
  }

  private async syncSingleFile(
    rf: VerifiedFile,
    task: StrmTask,
    baseUrl: string,
    localStrmMap: Map<string, string>,
    result: StrmScanResult,
  ): Promise<string> {
    const relDir = rf.relativePath ? path.dirname(rf.relativePath) : "";
    const safeSegments = relDir && relDir !== "." ? safeDirSegments(relDir) : [];
    const stem = this.canonicalStrmStem(rf.name, safeSegments);
    const safeName = stem + ".strm";
    const relStrmPath = safeSegments.length > 0
      ? `${safeSegments.join("/")}/${safeName}`
      : safeName;
    const targetFullPath = path.join(task.localOutputDir, ...safeSegments, safeName);
    const playUrl = buildPlayUrl(baseUrl, task.id, rf.id, rf.name, { sign: true });

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
    } else {
      /**
       * `incremental_missing`（默认模式）**曾经只生成缺失文件、从不检查已存在的**。
       * 签名 secret 轮换后（2026-11-17 从硬编码常量改为实例 JWT secret），磁盘上
       * 已有的 `.strm` 全部带着旧 token 永久 401，而这条路径永远不会重写它们——
       * 用户看到的就是「.strm 忽然播不了、重新扫描也没用」。
       *
       * 稳态下仍然「不碰没坏的文件」（内容相同 → 零动作、零额外网盘调用）；
       * 只有**内容本身判为失效**时才重写。判定是纯 CPU（正则 + HMAC 验签），
       * 每个已存在文件一次 `readFileSync`。
       */
      try {
        const currentContent = fs.readFileSync(targetFullPath, "utf8");
        const verdict = judgeStrmContent({
          content: currentContent,
          taskId: task.id,
          fileId: rf.id,
          expectedPlayUrl: playUrl,
        });
        if (verdict.kind === "rewrite") {
          await writeStrmFile({ targetFilePath: targetFullPath, playUrl });
          // 计入 updatedCount 而不是 generated：文件本来就在，只是内容失效被自愈。
          result.updatedCount++;
          result.generatedPaths.push(targetFullPath);
          console.log(
            `[strm-scanner] healed stale .strm (${verdict.reason}): ${targetFullPath}`,
          );
        }
      } catch {
        // non-blocking：读失败/写失败不阻断整轮扫描（与上面两条分支一致）。
      }
    }
    return relStrmPath;
  }

  private async cleanOrphanFiles(
    localStrmMap: Map<string, string>,
    expectedLocalRels: Set<string>,
    result: StrmScanResult,
  ): Promise<void> {
    for (const [relPath, fullPath] of localStrmMap.entries()) {
      if (!expectedLocalRels.has(relPath)) {
        try {
          await removeStrmFile(fullPath, true);
          result.removedCount++;
          result.removedPaths.push(fullPath);
        } catch {
          // ignore unlink error
        }
      }
    }
  }

  /**
   * 本轮孤儿清理的**告知性说明**（不拦截删除）。
   *
   * 为什么这里不像最初设想那样「删除比例 > 50% 就跳过」：那会把两件事混为一谈。
   *
   *  - **列表是否可信**：已由 `fetchRemoteFiles` 的 `ok: false` 严格回答——任意一层
   *    目录列举失败就不允许删（见 runScan 的早退分支）。
   *  - **变化是否很大**：这是镜像同步的**正常结果**，不是故障。生产实测「远端 38 /
   *    本地 955」（96%）正是本缺陷要修的场景；用 50% 阈值挡掉，修复对真实问题就
   *    完全无效。
   *
   * 所以这里只负责「把大额删除说出来」，让它出现在扫描记录里可审计：
   * 一次删掉一半以上时返回一句说明，调用方照常删除并把说明写进记录。
   * 真正的两道硬闸是：遍历失败（不删）+ 空盘（不删，除非显式强制）。
   */
  private largeDeletionNotice(input: {
    validRemoteCount: number;
    localStrmCount: number;
  }): string | null {
    if (input.localStrmCount < 4) return null;
    const toRemove = Math.max(0, input.localStrmCount - input.validRemoteCount);
    if (toRemove === 0) return null;
    const ratio = toRemove / input.localStrmCount;
    if (ratio <= 0.5) return null;
    return `本轮将删除 ${toRemove}/${input.localStrmCount} 个 STRM（${Math.round(ratio * 100)}%，属大幅变动）。若远端只是暂时不可见，请立即用备份或「立即扫描」复核。`;
  }

  /**
   * 空盘保护：远端 0 个有效媒体、本地却还有 STRM —— 极可能是故障（令牌过期、
   * 目录被改名、网络中断），不是「用户删光了」。此时整轮跳过，不做任何写入与删除。
   *
   * 2026-11-19 起覆盖**所有扫描模式**：清理不再是 `full_sync` 专属，这条闸也必须
   * 对所有模式生效，否则增量模式会变成「一次故障清空整库」的入口。
   */
  private checkEmptyProtect(
    validRemoteCount: number,
    localStrmCount: number,
    forceAllowEmptyCleanup: boolean,
  ): string | null {
    if (validRemoteCount === 0 && localStrmCount > 0 && !forceAllowEmptyCleanup) {
      return `远端网盘返回 0 个有效媒体文件，但本地存在 ${localStrmCount} 个 STRM 文件，空盘保护已拦截本轮同步（未生成、未删除）。确认远端确实为空后可强制执行。`;
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
      removedPaths: [],
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

    const traversal = await this.fetchRemoteFiles(storage, task.remoteFolderId);
    // 遍历失败：**不做任何写入也不做任何删除**。旧实现把失败当成空数组，于是
    // 「远端没了」与「这次没看到」不可区分——那是删除路径最危险的输入。
    if (!traversal.ok) {
      const message = `远端目录遍历失败，本轮跳过（未生成、未删除任何 STRM）：${traversal.error}`;
      await onProgress?.({
        phase: "completed",
        percent: 100,
        scannedCount: 0,
        generatedCount: 0,
        updatedCount: 0,
        removedCount: 0,
        message,
      });
      result.traversalError = traversal.error;
      result.cleanupSkippedReason = message;
      return result;
    }
    const remoteFiles = traversal.files;
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

    const outputDir = resolveStrmOutputPath(task.localOutputDir);
    const resolvedTask = { ...task, localOutputDir: outputDir };
    const localStrmMap = this.scanLocalStrmFiles(outputDir);

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
      validRemoteFiles.length,
      localStrmMap.size,
      forceAllowEmptyCleanup,
    );
    if (protectReason) {
      result.protected = true;
      result.protectReason = protectReason;
      result.cleanupSkippedReason = protectReason;
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
      resolvedTask,
      baseUrl,
      localStrmMap,
      result,
      onProgress,
    );

    /**
     * 孤儿清理**对所有模式生效**（2026-11-19 起）。
     *
     * 缺陷原型：它曾只挂在 `full_sync` 上，而 `incremental_missing` 是所有创建入口
     * 的默认值——于是「远端删了、本地该跟着删」这条常规同步语义在默认配置下
     * 永不发生（生产实测远端 38 / 本地 955）。「增量」被误读成「只增不删」，
     * 但用户期待的是同步。
     *
     * 硬闸只有两道（都在前面）：遍历失败不删、空盘不删。这里不做「删除比例上限」——
     * 大幅删除正是本缺陷要解决的问题本身（远端真的删了 96%，就该删 96%），
     * 用阈值挡住等于修了个寂寞。大额删除只记一条说明，供审计。
     */
    if (localStrmMap.size > 0) {
      const notice = this.largeDeletionNotice({
        validRemoteCount: validRemoteFiles.length,
        localStrmCount: localStrmMap.size,
      });
      await onProgress?.({
        phase: "cleaning_orphans",
        percent: 90,
        scannedCount: validRemoteFiles.length,
        generatedCount: result.generatedCount,
        updatedCount: result.updatedCount,
        removedCount: result.removedCount,
        message: notice ?? "正在清理远端已不存在的本地孤儿 STRM 文件...",
      });
      if (notice !== null) result.cleanupSkippedReason = notice;
      await this.cleanOrphanFiles(localStrmMap, expectedLocalRels, result);
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

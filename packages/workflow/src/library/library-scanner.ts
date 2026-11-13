import {
  type LibraryPathBinding,
  type LibraryMediaItem,
  type LibraryScanProgressEvent,
  type ScanStepStage,
  type SubtitleTrackInfo,
} from "@media-track/contracts";
import { type SqliteMediaLibraryRepository } from "../persistence/sqlite/sqlite-media-library.js";
import { identifyMediaFile } from "../domain/media-identification-engine.js";
import { episodeCodeFromFileName } from "../domain/episode-code.js";
import { FilenameQualityAdapter } from "../domain/filename-quality-adapter.js";
import type { DriveFileManager, DriveFileItem } from "../storage/drive-file-manager-types.js";
import { inferExtension } from "../storage/drive-file-manager.js";

export function normalizeMediaTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s\._\-\[\]\(\)\{\}\u3010\u3011\uFF08\uFF09]+/g, "")
    .trim();
}

export interface LibraryScannerDependencies {
  repo: SqliteMediaLibraryRepository;
  getFileManager: (storageId: string) => Promise<DriveFileManager | null>;
  searchMetadata?: (query: string, year?: number | null, type?: "movie" | "tv") => Promise<{
    tmdbId?: number | null;
    doubanId?: string | null;
    title: string;
    originalTitle?: string | null;
    overview?: string | null;
    posterPath?: string | null;
    backdropPath?: string | null;
    rating?: number | null;
    genres?: string[];
  } | null>;
}

export class MediaLibraryScanner {
  private readonly runningBindings = new Set<string>();

  constructor(private readonly deps: LibraryScannerDependencies) {}

  isBindingRunning(bindingId: string): boolean {
    return this.runningBindings.has(bindingId);
  }

  async scanBinding(
    bindingId: string,
    options?: {
      forceFullScan?: boolean;
      onProgress?: (event: LibraryScanProgressEvent) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ scannedFiles: number; ingestedEpisodes: number }> {
    if (this.runningBindings.has(bindingId)) {
      throw new Error(`BINDING_ALREADY_SCANNING: 路径绑定 ${bindingId} 正在扫描中，请勿重复触发`);
    }

    const binding = this.deps.repo.getPathBinding(bindingId);
    if (!binding) {
      throw new Error(`BINDING_NOT_FOUND: 路径绑定 ${bindingId} 不存在`);
    }

    const library = this.deps.repo.getLibrary(binding.libraryId);
    if (!library) {
      throw new Error(`LIBRARY_NOT_FOUND: 所属影视库 ${binding.libraryId} 不存在`);
    }

    this.runningBindings.add(bindingId);
    this.deps.repo.updatePathBinding(bindingId, { lastScanStatus: "running" });

    const emit = (
      stage: ScanStepStage,
      message: string,
      percent: number,
      currentTitle?: string,
      extra?: { total?: number; processed?: number; error?: string },
    ) => {
      const event: LibraryScanProgressEvent = {
        libraryId: library.id,
        bindingId,
        stage,
        message,
        percent: Math.min(100, Math.max(0, Math.round(percent))),
        totalDiscovered: extra?.total ?? 0,
        processedCount: extra?.processed ?? 0,
        timestamp: new Date().toISOString(),
      };
      if (currentTitle !== undefined) {
        event.currentTitle = currentTitle;
      }
      if (extra?.error !== undefined) {
        event.error = extra.error;
      }
      options?.onProgress?.(event);
    };

    let totalDiscovered = 0;
    let ingestedEpisodes = 0;

    try {
      emit("DISCOVERING_FOLDERS", `正在连接网盘存储驱动 ${binding.storageId}...`, 5);
      const fileManager = await this.deps.getFileManager(binding.storageId);
      if (!fileManager) {
        throw new Error(`STORAGE_MANAGER_NOT_READY: 无法初始化网盘驱动 ${binding.storageId}`);
      }

      // 是否属于剧集类媒体库 (TV / 动漫)
      const isSeriesLibrary = library.libraryType === "tv" || library.libraryType === "anime";

      // 递归队列结构
      interface CrawlQueueItem {
        folderId: string;
        folderName: string;
        relativePath: string;
        parentDirName?: string | undefined;
        grandParentDirName?: string | undefined;
        depth: number;
        seriesDirName?: string | undefined; // 剧集/动漫一级容器目录名称
      }

      const queue: CrawlQueueItem[] = [
        {
          folderId: binding.remoteFolderId,
          folderName: binding.remotePath.split("/").filter(Boolean).pop() || "Root",
          relativePath: "",
          depth: 0,
        },
      ];

      const isIncremental = !options?.forceFullScan && binding.scanMode === "incremental_missing";
      const minSizeBytes = binding.minFileSizeMb * 1024 * 1024;
      const excludePatterns = binding.excludeKeywords.map((k) => new RegExp(k, "i"));

      emit("DISCOVERING_FOLDERS", "开始遍历网盘目录与文件...", 10);

      const discoveredVideoFiles: Array<{
        file: DriveFileItem;
        parentDirName?: string | undefined;
        grandParentDirName?: string | undefined;
        relativePath: string;
        subtitles: SubtitleTrackInfo[];
        seriesDirName?: string | undefined;
      }> = [];

      while (queue.length > 0) {
        if (options?.signal?.aborted) {
          emit("ABORTED", "扫描已被用户中止", 100);
          this.deps.repo.updatePathBinding(bindingId, { lastScanStatus: "idle" });
          return { scannedFiles: totalDiscovered, ingestedEpisodes };
        }

        const current = queue.shift()!;
        let listing;
        try {
          listing = await fileManager.listDirectory(current.folderId);
        } catch (err) {
          console.warn(`[MediaLibraryScanner] 读取网盘目录失败 (${current.folderId}):`, err);
          continue;
        }

        // 提取该目录下的字幕文件（用于同级外挂字幕关联）
        const dirSubtitles: SubtitleTrackInfo[] = [];
        for (const item of listing.items) {
          if (!item.isFolder && item.type === "subtitle") {
            const ext = inferExtension(item.name).replace(".", "") as "srt" | "ass" | "vtt";
            dirSubtitles.push({
              id: item.id,
              fileId: item.id,
              title: item.name,
              language: "und",
              format: ext || "srt",
              type: "external",
            });
          }
        }

        // 增量快照计算
        const currentHash = `${listing.items.length}_${listing.items.map((i) => i.id).join("_")}`.slice(0, 64);
        const snapshot = this.deps.repo.getScanSnapshot(bindingId, current.folderId);

        // 如果是增量扫描，且当前目录快照未发生任何变动，且非根目录
        if (
          isIncremental &&
          current.depth > 0 &&
          snapshot &&
          snapshot.lastModifiedHash === currentHash &&
          snapshot.fileCount === listing.items.length
        ) {
          // 目录无变动，跳过进一步递归下潜
          continue;
        }

        // 保存/更新该目录的快照
        this.deps.repo.saveScanSnapshot({
          id: `snap_${bindingId}_${current.folderId}`,
          bindingId,
          dirId: current.folderId,
          dirName: current.folderName,
          dirPath: current.relativePath,
          fileCount: listing.items.length,
          lastModifiedHash: currentHash,
          checkedAt: new Date().toISOString(),
        });

        // 遍历处理子项
        for (const item of listing.items) {
          if (item.isFolder) {
            // 目录入队继续下潜，最大深度 5 层
            if (current.depth < 5) {
              const rel = current.relativePath ? `${current.relativePath}/${item.name}` : item.name;
              // 若为剧集/动漫库，根目录 (depth=0) 下的直接子目录即为 Series 容器！
              // 下潜的子孙层级强制继承该 seriesDirName，作为剧名权威来源
              const seriesDirName = isSeriesLibrary
                ? current.seriesDirName || (current.depth === 0 ? item.name : undefined)
                : undefined;

              queue.push({
                folderId: item.id,
                folderName: item.name,
                relativePath: rel,
                parentDirName: current.folderName,
                grandParentDirName: current.parentDirName ?? undefined,
                depth: current.depth + 1,
                seriesDirName,
              });
            }
          } else if (item.type === "video") {
            totalDiscovered++;
            // 过滤：大小过滤
            if (item.sizeBytes < minSizeBytes) continue;
            // 过滤：排除关键词
            if (excludePatterns.some((regex) => regex.test(item.name))) continue;

            // 寻找该视频的同名外挂字幕 (例如 Movie.1080p.mkv 与 Movie.1080p.zh-CN.ass)
            const baseVideoName = item.name.replace(/\.[a-zA-Z0-9]+$/, "").toLowerCase();
            const matchedSubs = dirSubtitles.filter((sub) => {
              const subBase = sub.title.replace(/\.[a-zA-Z0-9]+$/, "").toLowerCase();
              return subBase.startsWith(baseVideoName);
            });

            discoveredVideoFiles.push({
              file: item,
              parentDirName: current.folderName,
              grandParentDirName: current.parentDirName ?? undefined,
              relativePath: current.relativePath ? `${current.relativePath}/${item.name}` : item.name,
              subtitles: matchedSubs,
              seriesDirName: current.seriesDirName,
            });
          }
        }
      }

      emit("PARSING_FILENAMES", `已发现 ${discoveredVideoFiles.length} 个视频文件，开始结构化识别与刮削...`, 40, undefined, {
        total: discoveredVideoFiles.length,
        processed: 0,
      });

      // 阶段：识别与入库（引入会话级内存聚类缓存，防御同片多版本并发分散创建卡片）
      const inMemoryItemsCache = new Map<string, LibraryMediaItem>();

      for (let i = 0; i < discoveredVideoFiles.length; i++) {
        if (options?.signal?.aborted) {
          emit("ABORTED", "扫描已被用户中止", 100);
          this.deps.repo.updatePathBinding(bindingId, { lastScanStatus: "idle" });
          return { scannedFiles: totalDiscovered, ingestedEpisodes };
        }

        const entry = discoveredVideoFiles[i]!;
        const { file, parentDirName, grandParentDirName, relativePath, subtitles, seriesDirName } = entry;

        // 若为剧集类且拥有一级剧集目录名，优先解析该一级容器作为剧集权威元数据
        let identifiedSeries = null;
        if (isSeriesLibrary && seriesDirName) {
          identifiedSeries = identifyMediaFile({
            fileName: seriesDirName,
            libraryType: library.libraryType,
          });
        }

        // 智能识别单集与片名
        const identified = identifyMediaFile({
          fileName: file.name,
          ...(parentDirName !== undefined ? { parentDirName } : {}),
          ...(grandParentDirName !== undefined ? { grandParentDirName } : {}),
          libraryType: library.libraryType,
        });

        // 剧集权威属性：优先由一级剧集目录锚定，杜绝下层子目录和带广告文件名导致剧名分裂！
        const targetTitle = identifiedSeries ? identifiedSeries.title : identified.title;
        const targetYear = identifiedSeries ? identifiedSeries.year : identified.year;
        const targetTmdbId = identifiedSeries?.tmdbId ?? identified.tmdbId ?? null;
        const targetMediaType = identifiedSeries ? identifiedSeries.mediaType : identified.mediaType;

        const percent = 40 + Math.round(((i + 1) / discoveredVideoFiles.length) * 55);
        emit("SCRAPING_METADATA", `正在刮削与整理: ${targetTitle}`, percent, targetTitle, {
          total: discoveredVideoFiles.length,
          processed: i + 1,
        });

        // 1. 查找或创建媒体项 (MediaItem)：优先从内存聚类缓存命中，防御多文件同片重复生成
        const normalizedIdentifiedTitle = normalizeMediaTitle(targetTitle);
        const titleYearKey = `norm_${normalizedIdentifiedTitle}_${targetYear ?? 0}`;
        const tmdbKey = targetTmdbId ? `tmdb_${targetTmdbId}` : null;

        let mediaItem: LibraryMediaItem | null = null;
        if (tmdbKey && inMemoryItemsCache.has(tmdbKey)) {
          mediaItem = inMemoryItemsCache.get(tmdbKey)!;
        } else if (inMemoryItemsCache.has(titleYearKey)) {
          mediaItem = inMemoryItemsCache.get(titleYearKey)!;
        }

        if (!mediaItem) {
          // 数据库查重
          mediaItem = targetTmdbId
            ? this.deps.repo.findMediaItemByTmdb(library.id, targetTmdbId)
            : this.deps.repo.findMediaItemByTitleYear(library.id, targetTitle, targetYear);
        }

        if (!mediaItem) {
          // 查询远程元数据
          let metadata = null;
          if (this.deps.searchMetadata) {
            try {
              metadata = await this.deps.searchMetadata(
                targetTitle,
                targetYear,
                targetMediaType,
              );
            } catch (err) {
              console.warn(`[MediaLibraryScanner] 远程刮削元数据失败:`, err);
            }
          }

          // 若刮削得到了 TMDB ID，检查内存与库内是否已有同 TMDB 条目（实现多版本自动聚类归集）
          if (metadata?.tmdbId) {
            const scrapedTmdbKey = `tmdb_${metadata.tmdbId}`;
            if (inMemoryItemsCache.has(scrapedTmdbKey)) {
              mediaItem = inMemoryItemsCache.get(scrapedTmdbKey)!;
            } else {
              const existingByScrapedTmdb = this.deps.repo.findMediaItemByTmdb(library.id, metadata.tmdbId);
              if (existingByScrapedTmdb) {
                mediaItem = existingByScrapedTmdb;
              }
            }
          }

          if (!mediaItem) {
            const itemId = `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            mediaItem = this.deps.repo.upsertMediaItem({
              id: itemId,
              libraryId: library.id,
              tmdbId: metadata?.tmdbId ?? targetTmdbId ?? null,
              doubanId: metadata?.doubanId ?? null,
              mediaType: targetMediaType,
              title: metadata?.title || targetTitle,
              originalTitle: metadata?.originalTitle ?? identifiedSeries?.title ?? null,
              releaseYear: targetYear,
              overview: metadata?.overview ?? null,
              posterPath: metadata?.posterPath ?? null,
              backdropPath: metadata?.backdropPath ?? null,
              rating: metadata?.rating ?? 0,
              genres: metadata?.genres ?? [],
              isMetadataLocked: false,
              reviewStatus: (identifiedSeries?.confidence ?? identified.confidence) >= 80 ? "auto_accepted" : "needs_review",
            });
          }
        }

        // 注册到内存聚类缓存，确保后续同片名/同 TMDB 的不同版本立即归集
        if (mediaItem) {
          if (mediaItem.tmdbId) {
            inMemoryItemsCache.set(`tmdb_${mediaItem.tmdbId}`, mediaItem);
          }
          inMemoryItemsCache.set(
            `norm_${normalizeMediaTitle(mediaItem.title)}_${mediaItem.releaseYear ?? 0}`,
            mediaItem,
          );
          inMemoryItemsCache.set(titleYearKey, mediaItem);
        }

        // 2. 解析季号 (Season) 与集号 (Episode)
        let seasonNum = identified.seasonNumber;
        let epNum = identified.episodeNumber ?? 1;

        // 专门通过 episodeCodeFromFileName 支持国漫连续编号与多格式解析 (如 EP02, [02], 125, 第125集)
        const parsedEpCode = episodeCodeFromFileName(file.name, seasonNum);
        if (parsedEpCode) {
          const epMatch = /[Ss](\d+)[Ee](\d+)/.exec(parsedEpCode);
          if (epMatch && epMatch[2]) {
            seasonNum = Number(epMatch[1]);
            epNum = Number(epMatch[2]);
          }
        }

        // 查找或创建季度 (Season)
        const seasonId = `season_${mediaItem.id}_s${seasonNum}`;
        const season = this.deps.repo.upsertSeason({
          id: seasonId,
          mediaItemId: mediaItem.id,
          seasonNumber: seasonNum,
          name: targetMediaType === "movie" ? "正片" : `第 ${seasonNum} 季`,
        });

        // 3. 提取画质与版本标签 (Version Adapter) 并录入单集/版本 (Episode)
        const quality = FilenameQualityAdapter.parse(file.name, file.sizeBytes);
        const episodeId = `ep_${season.id}_e${epNum}_${file.id.slice(-6)}`;
        this.deps.repo.upsertEpisode({
          id: episodeId,
          seasonId: season.id,
          bindingId: binding.id,
          episodeNumber: epNum,
          episodeName: identified.suggestedCanonicalName,
          storageId: binding.storageId,
          fileId: file.id,
          fileName: file.name,
          versionTag: quality.displayBadge,
          isDefaultVersion: false,
          pickCode: file.pickCode ?? null,
          sizeBytes: file.sizeBytes,
          videoCodec: quality.videoCodec ?? identified.videoCodec,
          resolution: quality.resolution ?? identified.resolution,
          subtitles,
          relativePath,
        });

        ingestedEpisodes++;
      }

      emit("COMPLETED", `扫描完成！成功入库 ${ingestedEpisodes} 部/集影视文件`, 100, undefined, {
        total: discoveredVideoFiles.length,
        processed: discoveredVideoFiles.length,
      });

      this.deps.repo.updatePathBinding(bindingId, {
        lastScanAt: new Date().toISOString(),
        lastScanStatus: "success",
      });

      return { scannedFiles: totalDiscovered, ingestedEpisodes };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      emit("FAILED", `扫描失败: ${errorMsg}`, 100, undefined, { error: errorMsg });
      this.deps.repo.updatePathBinding(bindingId, {
        lastScanStatus: "failed",
      });
      throw err;
    } finally {
      this.runningBindings.delete(bindingId);
    }
  }
}

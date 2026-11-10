import type { StorageExecutor } from "../domain/ports.js";
import type { PackageTreeFile } from "../domain/domain.js";
import { mediaLibraryFolderName } from "../domain/media-library-folder.js";
import {
  rankMovieCandidates,
  rankTvCandidates,
  isVideoFile,
  type MediaCandidateItem,
} from "./version-ranker.js";
import {
  StorageArchiveAdapter,
  type ArchiveCategory,
} from "../storage/storage-archive-adapter.js";
import { parseEpisodeCode, canonicalEpisodeFileName } from "../domain/episode-code.js";

export interface OrganizeMovieInput {
  movieDirectoryId: string;
  title: string;
  year?: number | string | null | undefined;
  tmdbId: number;
  fallbackCategoryParentId?: string | undefined;
}

export interface OrganizeMovieResult {
  status: "organized" | "no_media" | "already_clean";
  primaryMovie?: MediaCandidateItem | undefined;
  archivedCount: number;
  archivedItems: string[];
}

export interface OrganizeStagingTvInput {
  stagingDirectoryId: string;
  showDirectoryId: string;
  title: string;
  type: "tv" | "anime";
  year?: number | string | null | undefined;
  tmdbId: number;
  fallbackCategoryParentId?: string | undefined;
}

export interface OrganizeTvResult {
  status: "organized" | "no_media" | "already_clean";
  placedEpisodes: string[];
  archivedCount: number;
  archivedItems: string[];
  stagingRemoved: boolean;
}

export class MediaOrganizer {
  private readonly storage: StorageExecutor;
  private readonly archiveAdapter: StorageArchiveAdapter;
  private readonly log?: ((line: string) => void) | undefined;

  constructor(opts: {
    storage: StorageExecutor;
    archiveAdapter: StorageArchiveAdapter;
    log?: ((line: string) => void) | undefined;
  }) {
    this.storage = opts.storage;
    this.archiveAdapter = opts.archiveAdapter;
    this.log = opts.log;
  }

  private collectCandidatesFromTree(
    tree: PackageTreeFile[],
    childDirByName: Map<string, string>,
  ): { candidates: MediaCandidateItem[]; totalVideosByWrapper: Map<string, number> } {
    const candidates: MediaCandidateItem[] = [];
    const totalVideosByWrapper = new Map<string, number>();
    for (const file of tree) {
      const parts = file.path.split("/").filter(Boolean);
      const fileName = parts[parts.length - 1] ?? "";
      if (!isVideoFile(fileName)) continue;

      let wrapperFolderId: string | undefined;
      let wrapperFolderName: string | undefined;
      if (parts.length > 1) {
        wrapperFolderName = parts[0];
        wrapperFolderId = wrapperFolderName ? childDirByName.get(wrapperFolderName) : undefined;
      }

      if (wrapperFolderId) {
        totalVideosByWrapper.set(wrapperFolderId, (totalVideosByWrapper.get(wrapperFolderId) ?? 0) + 1);
      }

      candidates.push({
        id: file.providerFileId,
        name: fileName,
        sizeBytes: file.sizeBytes,
        wrapperFolderId,
        wrapperFolderName,
      });
    }
    return { candidates, totalVideosByWrapper };
  }

  private async archiveRedundantMovieItems(
    movieDirectoryId: string,
    canonicalFolderName: string,
    fallbackCategoryParentId: string | undefined,
    primary: MediaCandidateItem,
    redundant: MediaCandidateItem[],
    childDirs: Array<{ id: string; name: string }>,
  ): Promise<{ archivedCount: number; archivedItems: string[] }> {
    const shouldArchive =
      redundant.length > 0 ||
      (childDirs.length > 0 && !(childDirs.length === 1 && childDirs[0]?.id === primary.wrapperFolderId));

    if (!shouldArchive) {
      return { archivedCount: 0, archivedItems: [] };
    }

    const targetArchiveFolderId = await this.archiveAdapter.getOrCreateTitleArchiveFolder(
      "Movies",
      canonicalFolderName,
      fallbackCategoryParentId,
    );

    let archivedCount = 0;
    const archivedItems: string[] = [];

    const wrapperFoldersToArchive = childDirs.filter((d) => d.id !== primary.wrapperFolderId);
    const archivedFolderIds = new Set(wrapperFoldersToArchive.map((d) => d.id));

    if (wrapperFoldersToArchive.length > 0) {
      const res = await this.archiveAdapter.archiveItems({
        targetArchiveDirectoryId: targetArchiveFolderId,
        items: wrapperFoldersToArchive.map((d) => ({ id: d.id, name: d.name, isFolder: true })),
        sourceDirectoryId: movieDirectoryId,
      });
      archivedCount += res.archivedCount;
      archivedItems.push(...wrapperFoldersToArchive.map((d) => d.name));
    }

    const looseRedundantFiles = redundant.filter(
      (r) => !r.wrapperFolderId || !archivedFolderIds.has(r.wrapperFolderId),
    );
    if (looseRedundantFiles.length > 0) {
      const res = await this.archiveAdapter.archiveItems({
        targetArchiveDirectoryId: targetArchiveFolderId,
        items: looseRedundantFiles.map((f) => ({ id: f.id, name: f.name, isFolder: false })),
        sourceDirectoryId: movieDirectoryId,
      });
      archivedCount += res.archivedCount;
      archivedItems.push(...looseRedundantFiles.map((f) => f.name));
    }

    return { archivedCount, archivedItems };
  }

  /**
   * Organizes a Movie directory:
   * 1. Finds all video files across root and wrapper subfolders.
   * 2. Ranks them to pick the single best version as primary.
   * 3. Moves primary file to movie directory root if nested.
   * 4. Archives all redundant version packages / files to /Mediary Scout/Archive/Movies/<TitleFolder>/
   * 5. Cleans up empty wrapper folders and junk files.
   */
  async organizeMovieDirectory(input: OrganizeMovieInput): Promise<OrganizeMovieResult> {
    const canonicalFolderName = mediaLibraryFolderName({
      title: input.title,
      year: input.year,
      tmdbId: input.tmdbId,
    });

    const childDirs = await this.storage.listChildDirectories(input.movieDirectoryId);
    const childDirByName = new Map(childDirs.map((d) => [d.name, d.id]));

    const tree = await this.storage.listTree({ directoryId: input.movieDirectoryId });
    if (tree.length === 0) {
      return { status: "no_media", archivedCount: 0, archivedItems: [] };
    }

    const { candidates } = this.collectCandidatesFromTree(tree, childDirByName);
    if (candidates.length === 0) {
      return { status: "no_media", archivedCount: 0, archivedItems: [] };
    }

    const { primary, redundant } = rankMovieCandidates(candidates);
    if (!primary) {
      return { status: "no_media", archivedCount: 0, archivedItems: [] };
    }

    this.log?.(`[MediaOrganizer] Selected primary movie: ${primary.name}`);

    if (primary.wrapperFolderId) {
      await this.storage.moveFiles({
        fileIds: [primary.id],
        targetDirectoryId: input.movieDirectoryId,
      });
    }

    const { archivedCount, archivedItems } = await this.archiveRedundantMovieItems(
      input.movieDirectoryId,
      canonicalFolderName,
      input.fallbackCategoryParentId,
      primary,
      redundant,
      childDirs,
    );

    if (primary.wrapperFolderId) {
      try {
        await this.storage.removeDirectory(primary.wrapperFolderId);
      } catch {
        // Safe to ignore if not empty
      }
    }

    return {
      status: "organized",
      primaryMovie: primary,
      archivedCount,
      archivedItems,
    };
  }

  private async placePrimaryTvEpisodes(
    showDirectoryId: string,
    primary: Map<string, MediaCandidateItem>,
    titleName: string,
  ): Promise<{ placedEpisodes: string[]; extractedByWrapper: Map<string, number> }> {
    const showChildDirs = await this.storage.listChildDirectories(showDirectoryId);
    const seasonDirMap = new Map<number, string>();
    for (const dir of showChildDirs) {
      const match = /^Season\s+(\d+)$/i.exec(dir.name);
      if (match?.[1]) {
        seasonDirMap.set(Number(match[1]), dir.id);
      }
    }

    const placedEpisodes: string[] = [];
    const extractedByWrapper = new Map<string, number>();

    for (const [code, item] of primary.entries()) {
      const parts = parseEpisodeCode(code);
      if (!parts) continue;

      let seasonDirId = seasonDirMap.get(parts.seasonNumber);
      if (!seasonDirId) {
        const seasonName = `Season ${String(parts.seasonNumber).padStart(2, "0")}`;
        seasonDirId = await this.storage.createDirectory({
          name: seasonName,
          parentId: showDirectoryId,
        });
        seasonDirMap.set(parts.seasonNumber, seasonDirId);
      }

      await this.storage.moveFiles({
        fileIds: [item.id],
        targetDirectoryId: seasonDirId,
      });

      // 规范化重命名，同时保留高质量/发布组画质标签
      try {
        const canonicalName = canonicalEpisodeFileName({
          title: titleName,
          episodeCode: code,
          sourceName: item.name,
          preserveMetadata: true,
        });
        if (canonicalName && canonicalName !== item.name) {
          await this.storage.renameFile({
            directoryId: seasonDirId,
            fileId: item.id,
            newName: canonicalName,
          });
        }
      } catch {
        // rename failure won't block move
      }

      placedEpisodes.push(code);
      if (item.wrapperFolderId) {
        extractedByWrapper.set(
          item.wrapperFolderId,
          (extractedByWrapper.get(item.wrapperFolderId) ?? 0) + 1,
        );
      }
    }

    return { placedEpisodes, extractedByWrapper };
  }

  private async archiveRedundantTvPackages(
    stagingDirectoryId: string,
    canonicalFolderName: string,
    category: ArchiveCategory,
    fallbackCategoryParentId: string | undefined,
    redundant: MediaCandidateItem[],
    stagingChildDirs: Array<{ id: string; name: string }>,
    extractedByWrapper: Map<string, number>,
    totalVideosByWrapper: Map<string, number>,
  ): Promise<{ archivedCount: number; archivedItems: string[] }> {
    const targetArchiveFolderId = await this.archiveAdapter.getOrCreateTitleArchiveFolder(
      category,
      canonicalFolderName,
      fallbackCategoryParentId,
    );

    let archivedCount = 0;
    const archivedItems: string[] = [];
    const handledWrapperIds = new Set<string>();

    for (const dir of stagingChildDirs) {
      const total = totalVideosByWrapper.get(dir.id) ?? 0;
      const extracted = extractedByWrapper.get(dir.id) ?? 0;

      if (total > 0 && extracted >= total) {
        // 视频全部被抽空的包装壳文件夹，直接删除清理
        try {
          await this.storage.removeDirectory(dir.id);
        } catch {
          // ignore
        }
        handledWrapperIds.add(dir.id);
      } else {
        // 含有落败多余版本或未被提取的包，整包归档到 Archive 目录
        const res = await this.archiveAdapter.archiveItems({
          targetArchiveDirectoryId: targetArchiveFolderId,
          items: [{ id: dir.id, name: dir.name, isFolder: true }],
          sourceDirectoryId: stagingDirectoryId,
        });
        archivedCount += res.archivedCount;
        archivedItems.push(dir.name);
        handledWrapperIds.add(dir.id);
      }
    }

    // 处理散落（不在任何包装文件夹内）的落败视频文件
    const looseRedundantFiles = redundant.filter(
      (r) => !r.wrapperFolderId || !handledWrapperIds.has(r.wrapperFolderId),
    );
    if (looseRedundantFiles.length > 0) {
      const res = await this.archiveAdapter.archiveItems({
        targetArchiveDirectoryId: targetArchiveFolderId,
        items: looseRedundantFiles.map((f) => ({ id: f.id, name: f.name, isFolder: false })),
        sourceDirectoryId: stagingDirectoryId,
      });
      archivedCount += res.archivedCount;
      archivedItems.push(...looseRedundantFiles.map((f) => f.name));
    }

    return { archivedCount, archivedItems };
  }

  /**
   * Organizes a TV / Anime staging directory or show directory:
   * 1. Finds all video files in staging (and existing Season folders).
   * 2. Ranks candidates per episode (SxxExx) to find the best version.
   * 3. Moves primary episodes into standard Season XX folders.
   * 4. Archives redundant version packages / files to /Mediary Scout/Archive/TV(or Anime)/<TitleFolder>/
   * 5. Deletes the staging directory once clean.
   */
  async organizeStagingDirectory(input: OrganizeStagingTvInput): Promise<OrganizeTvResult> {
    const category: ArchiveCategory = input.type === "anime" ? "Anime" : "TV";
    const canonicalFolderName = mediaLibraryFolderName({
      title: input.title,
      year: input.year,
      tmdbId: input.tmdbId,
    });

    const stagingChildDirs = await this.storage.listChildDirectories(input.stagingDirectoryId);
    const stagingChildByName = new Map(stagingChildDirs.map((d) => [d.name, d.id]));

    const stagingTree = await this.storage.listTree({ directoryId: input.stagingDirectoryId });
    if (stagingTree.length === 0) {
      try {
        await this.storage.removeDirectory(input.stagingDirectoryId);
      } catch {
        // ignore
      }
      return { status: "no_media", placedEpisodes: [], archivedCount: 0, archivedItems: [], stagingRemoved: true };
    }

    const { candidates, totalVideosByWrapper } = this.collectCandidatesFromTree(
      stagingTree,
      stagingChildByName,
    );
    if (candidates.length === 0) {
      return { status: "no_media", placedEpisodes: [], archivedCount: 0, archivedItems: [], stagingRemoved: false };
    }

    const { primary, redundant } = rankTvCandidates(candidates);
    const { placedEpisodes, extractedByWrapper } = await this.placePrimaryTvEpisodes(
      input.showDirectoryId,
      primary,
      input.title,
    );

    const { archivedCount, archivedItems } = await this.archiveRedundantTvPackages(
      input.stagingDirectoryId,
      canonicalFolderName,
      category,
      input.fallbackCategoryParentId,
      redundant,
      stagingChildDirs,
      extractedByWrapper,
      totalVideosByWrapper,
    );

    let stagingRemoved = false;
    try {
      const removeResult = await this.storage.removeDirectory(input.stagingDirectoryId);
      stagingRemoved = removeResult.removed;
    } catch {
      // Best-effort cleanup
    }

    return {
      status: "organized",
      placedEpisodes,
      archivedCount,
      archivedItems,
      stagingRemoved,
    };
  }
}

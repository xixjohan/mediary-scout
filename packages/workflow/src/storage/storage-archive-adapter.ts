import type { StorageExecutor } from "../domain/ports.js";

export type ArchiveCategory = "Movies" | "TV" | "Anime";

export interface ArchiveItemInput {
  id: string;
  name: string;
  isFolder?: boolean;
}

export interface StorageArchiveAdapterOptions {
  storage: Pick<StorageExecutor, "createDirectory" | "listChildDirectories" | "moveFiles" | "renameFile">;
  /** Root CID (e.g. "Mediary Scout" root folder ID). If absent, category parent can be used as fallback */
  rootCid?: string | null;
  /** Name of the archive root folder. Defaults to "Archive". */
  archiveRootName?: string;
}

/**
 * StorageArchiveAdapter manages the archive structure:
 *   /Mediary Scout/Archive/Movies/<TitleFolder>/
 *   /Mediary Scout/Archive/TV/<TitleFolder>/
 *   /Mediary Scout/Archive/Anime/<TitleFolder>/
 *
 * It provides idempotent creation and atomic moving of redundant files and directories
 * to prevent duplicate files while strictly preserving user assets (Zero-destructive deletion).
 */
export class StorageArchiveAdapter {
  private readonly storage: StorageArchiveAdapterOptions["storage"];
  private readonly rootCid: string | null;
  private readonly archiveRootName: string;

  // Cached directory IDs to minimize API roundtrips
  private archiveRootId: string | null = null;
  private categoryDirIds = new Map<ArchiveCategory, string>();
  private titleDirIds = new Map<string, string>();

  constructor(opts: StorageArchiveAdapterOptions) {
    this.storage = opts.storage;
    this.rootCid = opts.rootCid ?? null;
    this.archiveRootName = opts.archiveRootName || "Archive";
  }

  /**
   * Resolves or creates the Archive root folder (under rootCid).
   */
  async getOrCreateArchiveRoot(fallbackParentId?: string): Promise<string> {
    if (this.archiveRootId) {
      return this.archiveRootId;
    }

    const parentId = this.rootCid || fallbackParentId;
    if (!parentId) {
      throw new Error("ARCHIVE_ADAPTER_ERROR: Neither rootCid nor fallbackParentId was provided.");
    }

    const children = await this.storage.listChildDirectories(parentId);
    const existing = children.find(
      (c) => c.name.toLowerCase() === this.archiveRootName.toLowerCase(),
    );

    if (existing) {
      this.archiveRootId = existing.id;
      return existing.id;
    }

    const createdId = await this.storage.createDirectory({
      name: this.archiveRootName,
      parentId,
    });
    this.archiveRootId = createdId;
    return createdId;
  }

  /**
   * Resolves or creates a category directory under Archive (Movies / TV / Anime).
   */
  async getOrCreateCategoryFolder(category: ArchiveCategory, fallbackParentId?: string): Promise<string> {
    const cached = this.categoryDirIds.get(category);
    if (cached) {
      return cached;
    }

    const archiveRoot = await this.getOrCreateArchiveRoot(fallbackParentId);
    const children = await this.storage.listChildDirectories(archiveRoot);
    const existing = children.find((c) => c.name.toLowerCase() === category.toLowerCase());

    if (existing) {
      this.categoryDirIds.set(category, existing.id);
      return existing.id;
    }

    const createdId = await this.storage.createDirectory({
      name: category,
      parentId: archiveRoot,
    });
    this.categoryDirIds.set(category, createdId);
    return createdId;
  }

  /**
   * Resolves or creates the title-specific archive directory:
   * /Mediary Scout/Archive/<category>/<titleFolderName>/
   */
  async getOrCreateTitleArchiveFolder(
    category: ArchiveCategory,
    titleFolderName: string,
    fallbackParentId?: string,
  ): Promise<string> {
    const cacheKey = `${category}:${titleFolderName}`;
    const cached = this.titleDirIds.get(cacheKey);
    if (cached) {
      return cached;
    }

    const categoryId = await this.getOrCreateCategoryFolder(category, fallbackParentId);
    const children = await this.storage.listChildDirectories(categoryId);
    const existing = children.find(
      (c) => c.name.trim().toLowerCase() === titleFolderName.trim().toLowerCase(),
    );

    if (existing) {
      this.titleDirIds.set(cacheKey, existing.id);
      return existing.id;
    }

    const createdId = await this.storage.createDirectory({
      name: titleFolderName,
      parentId: categoryId,
    });
    this.titleDirIds.set(cacheKey, createdId);
    return createdId;
  }

  /**
   * Safely moves redundant items (files or wrapper folders) to the target archive folder.
   * If collision occurs, renames before moving.
   */
  async archiveItems(input: {
    targetArchiveDirectoryId: string;
    items: ArchiveItemInput[];
    sourceDirectoryId?: string;
  }): Promise<{ archivedCount: number; archivedIds: string[] }> {
    if (input.items.length === 0) {
      return { archivedCount: 0, archivedIds: [] };
    }

    // Check existing child items in target to avoid name collision
    let existingNames = new Set<string>();
    try {
      const existingDirs = await this.storage.listChildDirectories(input.targetArchiveDirectoryId);
      for (const d of existingDirs) {
        existingNames.add(d.name.toLowerCase());
      }
    } catch {
      // Best-effort check; continue if listing fails
    }

    const fileIdsToMove: string[] = [];
    const archivedIds: string[] = [];

    for (const item of input.items) {
      if (!item.id) continue;

      // Handle collision by renaming if same name already exists in target
      if (existingNames.has(item.name.toLowerCase()) && input.sourceDirectoryId) {
        const dotIndex = item.name.lastIndexOf(".");
        const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const newName =
          dotIndex > 0 && !item.isFolder
            ? `${item.name.slice(0, dotIndex)} (archive-${timestamp})${item.name.slice(dotIndex)}`
            : `${item.name} (archive-${timestamp})`;

        try {
          await this.storage.renameFile({
            directoryId: input.sourceDirectoryId,
            fileId: item.id,
            newName,
          });
        } catch {
          // If rename fails, try moving anyway
        }
      }

      fileIdsToMove.push(item.id);
    }

    if (fileIdsToMove.length > 0) {
      const moveResult = await this.storage.moveFiles({
        fileIds: fileIdsToMove,
        targetDirectoryId: input.targetArchiveDirectoryId,
      });
      archivedIds.push(...(moveResult.moved || []));
    }

    return {
      archivedCount: archivedIds.length,
      archivedIds,
    };
  }
}

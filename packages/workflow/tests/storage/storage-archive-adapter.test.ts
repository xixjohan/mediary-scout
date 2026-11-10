import { describe, it, expect, vi } from "vitest";
import { StorageArchiveAdapter } from "../../src/storage/storage-archive-adapter.js";

describe("StorageArchiveAdapter", () => {
  it("idempotently creates Archive/Category/Title directory structure", async () => {
    const existingDirs = new Map<string, Array<{ id: string; name: string }>>();
    existingDirs.set("root_1", []); // root has no children initially

    let nextId = 100;
    const createDirectory = vi.fn(async ({ name, parentId }: { name: string; parentId: string }) => {
      const id = `dir_${nextId++}`;
      const list = existingDirs.get(parentId) ?? [];
      list.push({ id, name });
      existingDirs.set(parentId, list);
      existingDirs.set(id, []);
      return id;
    });

    const listChildDirectories = vi.fn(async (parentId: string) => {
      return existingDirs.get(parentId) ?? [];
    });

    const moveFiles = vi.fn(async ({ fileIds }: { fileIds: string[]; targetDirectoryId: string }) => {
      return { moved: fileIds };
    });

    const renameFile = vi.fn(async () => {});

    const adapter = new StorageArchiveAdapter({
      storage: {
        createDirectory,
        listChildDirectories,
        moveFiles,
        renameFile,
      },
      rootCid: "root_1",
    });

    // 1. First call: creates Archive, Movies, and the Title folder
    const titleFolderId1 = await adapter.getOrCreateTitleArchiveFolder(
      "Movies",
      "The Hotel New Hampshire (1984) {tmdb-11308}",
    );

    expect(titleFolderId1).toBe("dir_102"); // 100 = Archive, 101 = Movies, 102 = Title
    expect(createDirectory).toHaveBeenCalledTimes(3);

    // 2. Second call: uses cache / finds existing
    const titleFolderId2 = await adapter.getOrCreateTitleArchiveFolder(
      "Movies",
      "The Hotel New Hampshire (1984) {tmdb-11308}",
    );
    expect(titleFolderId2).toBe("dir_102");
    expect(createDirectory).toHaveBeenCalledTimes(3); // No new directories created

    // 3. Archive items into the folder
    const archiveResult = await adapter.archiveItems({
      targetArchiveDirectoryId: titleFolderId2,
      items: [
        { id: "redundant_file_1", name: "movie_rarbg.mp4" },
        { id: "redundant_dir_2", name: "movie_amiable_dir", isFolder: true },
      ],
    });

    expect(archiveResult.archivedCount).toBe(2);
    expect(moveFiles).toHaveBeenCalledWith({
      fileIds: ["redundant_file_1", "redundant_dir_2"],
      targetDirectoryId: "dir_102",
    });
  });
});

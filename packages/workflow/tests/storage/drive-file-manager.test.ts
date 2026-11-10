import { describe, expect, it } from "vitest";
import {
  createDriveFileManager,
  FakeFileManagerAdapter,
  inferExtension,
  inferFileType,
  resolveCurrentDirectoryName,
  type DriveFileManagerOptions,
} from "../../src/storage/drive-file-manager.js";
import { DriveDirectoryCache } from "../../src/storage/drive-file-manager.js";

describe("drive-file-manager", () => {
  describe("file type inference", () => {
    it("identifies folders properly", () => {
      expect(inferFileType("SomeMovie", true)).toBe("folder");
      expect(inferFileType("subtitles", true)).toBe("folder");
    });

    it("identifies video file extensions", () => {
      expect(inferFileType("movie.mp4", false)).toBe("video");
      expect(inferFileType("show.S01E01.mkv", false)).toBe("video");
      expect(inferFileType("disc.iso", false)).toBe("video");
    });

    it("identifies subtitle extensions", () => {
      expect(inferFileType("track.srt", false)).toBe("subtitle");
      expect(inferFileType("sub.ass", false)).toBe("subtitle");
    });

    it("identifies audio, archive, and image extensions", () => {
      expect(inferFileType("song.mp3", false)).toBe("audio");
      expect(inferFileType("pack.7z", false)).toBe("archive");
      expect(inferFileType("poster.jpg", false)).toBe("image");
      expect(inferFileType("notes.txt", false)).toBe("file");
    });

    it("handles edge cases in extension inference", () => {
      expect(inferExtension("noextension")).toBe("");
      expect(inferExtension(".hidden")).toBe("");
      expect(inferExtension("movie.2024.1080p.MKV")).toBe(".mkv");
    });
  });

  describe("resolveCurrentDirectoryName", () => {
    const opts = {
      rootCid: "root_100",
      moviesCid: "movies_200",
      tvCid: "tv_300",
      animeCid: "anime_400",
    };

    it("resolves preset category directory names", () => {
      expect(resolveCurrentDirectoryName("movies_200", opts)).toBe("电影");
      expect(resolveCurrentDirectoryName("tv_300", opts)).toBe("剧集");
      expect(resolveCurrentDirectoryName("anime_400", opts)).toBe("动漫");
      expect(resolveCurrentDirectoryName("root_100", opts)).toBe("根目录");
      expect(resolveCurrentDirectoryName("0", opts)).toBe("根目录");
      expect(resolveCurrentDirectoryName("", opts)).toBe("根目录");
    });

    it("formats arbitrary directory ids", () => {
      expect(resolveCurrentDirectoryName("abc12345xyz", opts)).toBe("目录");
      expect(resolveCurrentDirectoryName("abc12345xyz", opts, "Season 01")).toBe("Season 01");
    });
  });

  describe("DriveDirectoryCache", () => {
    const opts: DriveFileManagerOptions = {
      storageId: "cs_quark_test",
      provider: "quark",
      rootCid: "root_0",
      moviesCid: "movies_1",
      tvCid: "tv_2",
      animeCid: "anime_3",
    };

    it("builds breadcrumbs recursively for nested children", () => {
      const cache = new DriveDirectoryCache(opts);
      cache.recordChildren("anime_3", [
        {
          id: "anime_folder_1",
          name: "桃源暗鬼 (2025)",
          isFolder: true,
          sizeBytes: 0,
          updatedAt: "",
          type: "folder",
          extension: "",
        },
      ]);
      cache.recordChildren("anime_folder_1", [
        {
          id: "season_folder_2",
          name: "Season 01",
          isFolder: true,
          sizeBytes: 0,
          updatedAt: "",
          type: "folder",
          extension: "",
        },
      ]);

      const crumbs = cache.buildBreadcrumbs("season_folder_2");
      expect(crumbs).toEqual([
        { id: "root_0", name: "根目录" },
        { id: "anime_3", name: "动漫" },
        { id: "anime_folder_1", name: "桃源暗鬼 (2025)" },
        { id: "season_folder_2", name: "Season 01" },
      ]);
    });

    it("falls back gracefully when parent is not yet in cache", () => {
      const cache = new DriveDirectoryCache(opts);
      const crumbs = cache.buildBreadcrumbs("unknown_folder_99", "未知分类");
      expect(crumbs).toEqual([
        { id: "root_0", name: "根目录" },
        { id: "unknown_folder_99", name: "未知分类" },
      ]);
    });
  });

  describe("FakeFileManagerAdapter", () => {
    const opts: DriveFileManagerOptions = {
      storageId: "cs_test",
      provider: "quark",
      rootCid: "root_0",
      moviesCid: "movies_1",
      tvCid: "tv_2",
      animeCid: "anime_3",
    };

    it("initializes with root categories", async () => {
      const adapter = new FakeFileManagerAdapter(opts);
      const res = await adapter.listDirectory("root_0");

      expect(res.storageId).toBe("cs_test");
      expect(res.currentDirectoryId).toBe("root_0");
      expect(res.currentDirectoryName).toBe("根目录");
      expect(res.items.map((i) => i.name)).toEqual(["Anime", "Movies", "TV"]);
      expect(res.folderCount).toBe(3);
      expect(res.fileCount).toBe(0);
    });

    it("supports creating a folder and listing it", async () => {
      const adapter = new FakeFileManagerAdapter(opts);
      const created = await adapter.createFolder({ parentId: "movies_1", name: "Inception (2010)" });

      expect(created.name).toBe("Inception (2010)");
      expect(created.id).toBeTruthy();

      const list = await adapter.listDirectory("movies_1");
      expect(list.items.map((i) => i.name)).toContain("Inception (2010)");
    });

    it("supports renaming a folder or file", async () => {
      const adapter = new FakeFileManagerAdapter(opts);
      const created = await adapter.createFolder({ parentId: "movies_1", name: "Old Name" });
      await adapter.renameItem({ itemId: created.id, newName: "New Name", isFolder: true });

      const list = await adapter.listDirectory("movies_1");
      expect(list.items.find((i) => i.id === created.id)?.name).toBe("New Name");
    });

    it("supports moving items to a target directory", async () => {
      const adapter = new FakeFileManagerAdapter(opts);
      const created = await adapter.createFolder({ parentId: "movies_1", name: "Movie To Move" });

      const moved = await adapter.moveItems({
        items: [{ id: created.id, isFolder: true }],
        targetDirectoryId: "tv_2",
      });
      expect(moved.movedCount).toBe(1);

      const moviesList = await adapter.listDirectory("movies_1");
      expect(moviesList.items.find((i) => i.id === created.id)).toBeUndefined();

      const tvList = await adapter.listDirectory("tv_2");
      expect(tvList.items.find((i) => i.id === created.id)?.name).toBe("Movie To Move");
    });

    it("supports copying items to a target directory", async () => {
      const adapter = new FakeFileManagerAdapter(opts);
      const created = await adapter.createFolder({ parentId: "movies_1", name: "Source Item" });

      const copied = await adapter.copyItems({
        items: [{ id: created.id, isFolder: true }],
        targetDirectoryId: "tv_2",
      });
      expect(copied.copiedCount).toBe(1);

      // Original remains in movies_1
      const moviesList = await adapter.listDirectory("movies_1");
      expect(moviesList.items.find((i) => i.id === created.id)).toBeDefined();

      // Copy appears in tv_2
      const tvList = await adapter.listDirectory("tv_2");
      expect(tvList.items.find((i) => i.name === "Source Item_副本")).toBeDefined();
    });

    it("supports deleting items", async () => {
      const adapter = new FakeFileManagerAdapter(opts);
      const created = await adapter.createFolder({ parentId: "movies_1", name: "To Delete" });

      const del = await adapter.deleteItems([{ id: created.id, isFolder: true, name: "To Delete" }]);
      expect(del.deletedCount).toBe(1);

      const list = await adapter.listDirectory("movies_1");
      expect(list.items.find((i) => i.id === created.id)).toBeUndefined();
    });
  });

  describe("createDriveFileManager factory", () => {
    it("creates FakeFileManagerAdapter when MEDIA_TRACK_STORAGE_ADAPTER=fake", () => {
      const prev = process.env.MEDIA_TRACK_STORAGE_ADAPTER;
      try {
        process.env.MEDIA_TRACK_STORAGE_ADAPTER = "fake";
        const mgr = createDriveFileManager({
          storageId: "cs_1",
          provider: "quark",
        });
        expect(mgr).toBeInstanceOf(FakeFileManagerAdapter);
      } finally {
        process.env.MEDIA_TRACK_STORAGE_ADAPTER = prev;
      }
    });

    it("Pan115FileManagerAdapter correctly identifies files with fid even if fc is 0 or '0'", async () => {
      const { Pan115FileManagerAdapter } = await import("../../src/storage/drive-file-manager.js");
      const adapter = new Pan115FileManagerAdapter({
        storageId: "cs_115",
        provider: "pan115",
        cookie: "test_cookie",
      });
      // Mock listItemsWithBreadcrumbs on internal client
      (adapter as any).client.listItemsWithBreadcrumbs = async () => ({
        items: [
          { fid: "file_mp4_1", cid: "parent_dir", n: "episode01.mp4", s: 1048576, fc: "0" },
          { fid: "file_mkv_2", cid: "parent_dir", n: "episode02.mkv", s: 2048576, fc: 0 },
          { cid: "sub_dir_1", n: "Season 1", s: 0, fc: "0" },
        ],
        breadcrumbs: [{ cid: "parent_dir", name: "Staging" }],
      });

      const listing = await adapter.listDirectory("parent_dir");
      expect(listing.items).toHaveLength(3);

      const mp4Item = listing.items.find((i) => i.id === "file_mp4_1")!;
      expect(mp4Item).toBeDefined();
      expect(mp4Item.isFolder).toBe(false);
      expect(mp4Item.type).toBe("video");

      const mkvItem = listing.items.find((i) => i.id === "file_mkv_2")!;
      expect(mkvItem).toBeDefined();
      expect(mkvItem.isFolder).toBe(false);
      expect(mkvItem.type).toBe("video");

      const dirItem = listing.items.find((i) => i.id === "sub_dir_1")!;
      expect(dirItem).toBeDefined();
      expect(dirItem.isFolder).toBe(true);
      expect(dirItem.type).toBe("folder");
    });
  });
});

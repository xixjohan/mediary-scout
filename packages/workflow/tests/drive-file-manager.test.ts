import { describe, expect, it } from "vitest";
import {
  createDriveFileManager,
  FakeFileManagerAdapter,
  inferExtension,
  inferFileType,
  resolveCurrentDirectoryName,
  type DriveFileManagerOptions,
} from "../src/drive-file-manager.js";

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
      expect(resolveCurrentDirectoryName("abc12345xyz", opts)).toBe("目录 (abc12345…)");
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
  });
});

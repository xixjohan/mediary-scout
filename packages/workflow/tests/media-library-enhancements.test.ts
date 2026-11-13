import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteMediaLibraryRepository } from "../src/persistence/sqlite/sqlite-media-library.js";
import { SQLITE_SCHEMA, upgradeMediaLibraryShape } from "../src/persistence/sqlite/sqlite-schema.js";
import { FilenameQualityAdapter } from "../src/domain/filename-quality-adapter.js";

describe("Media Library Architectural Enhancements", () => {
  let db: Database.Database;
  let repo: SqliteMediaLibraryRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SQLITE_SCHEMA);
    upgradeMediaLibraryShape(db);
    repo = new SqliteMediaLibraryRepository(db);
  });

  describe("Topic 1: Filename Quality & Multi-Version Parsing", () => {
    it("should parse 4K HDR Remux correctly with human-friendly displayBadge", () => {
      const parsed = FilenameQualityAdapter.parse(
        "Oppenheimer.2023.2160p.UHD.Remux.HEVC.DV.TrueHD.Atmos-MEDIA.mkv",
        56254789120, // ~52.4 GB
      );

      expect(parsed.resolution).toBe("2160p");
      expect(parsed.hdrType).toBe("DV");
      expect(parsed.videoCodec).toBe("HEVC");
      expect(parsed.audioCodec).toBe("Atmos");
      expect(parsed.sourceType).toBe("Remux");
      expect(parsed.displayBadge).toContain("4K · DV · Remux");
      expect(parsed.displayBadge).toContain("52.4 GB");
    });

    it("should parse 1080p WEB-DL edition correctly", () => {
      const parsed = FilenameQualityAdapter.parse(
        "Dune.Part.Two.2024.1080p.IMAX.WEB-DL.DDP5.1.Atmos.H.264.mkv",
        8589934592, // 8.0 GB
      );

      expect(parsed.resolution).toBe("1080p");
      expect(parsed.videoCodec).toBe("AVC");
      expect(parsed.sourceType).toBe("WEB-DL");
      expect(parsed.edition).toBe("IMAX");
      expect(parsed.displayBadge).toContain("1080p · WEB-DL · IMAX (8.0 GB)");
    });
  });

  describe("Topic 4: Library Type Immutability & Basic Info Update", () => {
    it("should allow updating name and defaultDeliveryMode but reject mutating libraryType", () => {
      const lib = repo.createLibrary({
        accountId: "acc_1",
        name: "我的测试电影库",
        libraryType: "movie",
        defaultDeliveryMode: "redirect",
      });

      expect(lib.libraryType).toBe("movie");

      // Attempt to maliciously or accidentally patch libraryType to 'tv'
      const updated = repo.updateLibrary(lib.id, {
        name: "修改后的电影库",
        defaultDeliveryMode: "proxy",
        ...({ libraryType: "tv" } as unknown as Record<string, unknown>),
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe("修改后的电影库");
      expect(updated?.defaultDeliveryMode).toBe("proxy");
      // Immutability enforced: still 'movie'!
      expect(updated?.libraryType).toBe("movie");
    });
  });

  describe("Topic 3: Auto-Cleanup Cascades for Removed Paths", () => {
    it("should cascade-delete episodes, orphaned seasons and orphaned media items when path is unbound", () => {
      const lib = repo.createLibrary({
        accountId: "acc_1",
        name: "Cascade Test Lib",
        libraryType: "movie",
      });

      // Bind path A and path B
      const bindingA = repo.createPathBinding({
        libraryId: lib.id,
        storageId: "115_drive_1",
        remoteFolderId: "cid_100",
        remotePath: "/Movies/FolderA",
      });

      const bindingB = repo.createPathBinding({
        libraryId: lib.id,
        storageId: "115_drive_1",
        remoteFolderId: "cid_200",
        remotePath: "/Movies/FolderB",
      });

      // Media Item 1 has 2 versions: one from Binding A, one from Binding B
      const item1 = repo.upsertMediaItem({
        id: "item_1",
        libraryId: lib.id,
        mediaType: "movie",
        title: "奥本海默",
      });

      const season1 = repo.upsertSeason({
        id: "season_1",
        mediaItemId: item1.id,
        seasonNumber: 1,
        name: "第 1 季",
      });

      // Episode from path A (4K Remux)
      repo.upsertEpisode({
        id: "ep_1_remux",
        seasonId: season1.id,
        bindingId: bindingA.id,
        episodeNumber: 1,
        storageId: "115_drive_1",
        fileId: "file_101",
        fileName: "Oppenheimer.2023.2160p.Remux.mkv",
        versionTag: "4K · Remux",
        isDefaultVersion: true,
        sizeBytes: 50000000000,
      });

      // Episode from path B (1080p WEB-DL)
      repo.upsertEpisode({
        id: "ep_1_webdl",
        seasonId: season1.id,
        bindingId: bindingB.id,
        episodeNumber: 1,
        storageId: "115_drive_1",
        fileId: "file_201",
        fileName: "Oppenheimer.2023.1080p.WEB-DL.mkv",
        versionTag: "1080p · WEB-DL",
        isDefaultVersion: false,
        sizeBytes: 8000000000,
      });

      // Media Item 2 only exists in Path A
      const item2 = repo.upsertMediaItem({
        id: "item_2",
        libraryId: lib.id,
        mediaType: "movie",
        title: "沙丘2",
      });

      const season2 = repo.upsertSeason({
        id: "season_2",
        mediaItemId: item2.id,
        seasonNumber: 1,
        name: "第 1 季",
      });

      repo.upsertEpisode({
        id: "ep_2_sole",
        seasonId: season2.id,
        bindingId: bindingA.id,
        episodeNumber: 1,
        storageId: "115_drive_1",
        fileId: "file_102",
        fileName: "Dune.Part.Two.2024.1080p.mkv",
        versionTag: "1080p",
        sizeBytes: 9000000000,
      });

      // Check versionCount before unbinding:
      const beforeRes = repo.listMediaItems({ libraryId: lib.id });
      const itemsBefore = beforeRes.items;
      const item1Before = itemsBefore.find((i) => i.id === "item_1");
      const item2Before = itemsBefore.find((i) => i.id === "item_2");

      expect(itemsBefore.length).toBe(2);
      expect(item1Before?.versionCount).toBe(2);
      expect(item2Before?.versionCount).toBe(1);

      // Now unbind Path A
      const cleanupResult = repo.deletePathBinding(bindingA.id);
      expect(cleanupResult.deletedEpisodes).toBe(2); // ep_1_remux + ep_2_sole
      expect(cleanupResult.deletedItems).toBe(1); // item_2 orphaned & deleted

      // Verify item_1 still survives with 1 remaining version (from Path B)!
      const afterRes = repo.listMediaItems({ libraryId: lib.id });
      const itemsAfter = afterRes.items;
      expect(itemsAfter.length).toBe(1);
      expect(itemsAfter[0]?.id).toBe("item_1");
      expect(itemsAfter[0]?.versionCount).toBe(1);

      // Item 2 and its episodes must be completely gone
      expect(repo.getMediaItem("item_2")).toBeNull();
      expect(repo.getEpisode("ep_2_sole")).toBeNull();
      expect(repo.getEpisode("ep_1_remux")).toBeNull();
      // Episode from path B is intact
      expect(repo.getEpisode("ep_1_webdl")).not.toBeNull();
    });
  });

  describe("Topic 2: Batch Review & Batch Deletion", () => {
    it("should batch accept and batch delete media items cleanly", () => {
      const lib = repo.createLibrary({
        accountId: "acc_1",
        name: "Batch Action Test",
        libraryType: "movie",
      });

      const it1 = repo.upsertMediaItem({
        id: "batch_1",
        libraryId: lib.id,
        mediaType: "movie",
        title: "未识别电影1",
        reviewStatus: "needs_review",
      });

      const it2 = repo.upsertMediaItem({
        id: "batch_2",
        libraryId: lib.id,
        mediaType: "movie",
        title: "未识别电影2",
        reviewStatus: "needs_review",
      });

      expect(it1.reviewStatus).toBe("needs_review");
      expect(it2.reviewStatus).toBe("needs_review");

      // Batch accept
      repo.batchUpdateReviewStatus(["batch_1", "batch_2"], "auto_accepted");
      expect(repo.getMediaItem("batch_1")?.reviewStatus).toBe("auto_accepted");
      expect(repo.getMediaItem("batch_2")?.reviewStatus).toBe("auto_accepted");

      // Batch delete
      const deletedCount = repo.batchDeleteMediaItems(["batch_1"]);
      expect(deletedCount).toBe(1);
      expect(repo.getMediaItem("batch_1")).toBeNull();
      expect(repo.getMediaItem("batch_2")).not.toBeNull();
    });
  });
});

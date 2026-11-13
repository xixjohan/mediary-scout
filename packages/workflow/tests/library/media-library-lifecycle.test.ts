import Database from "better-sqlite3";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SQLITE_SCHEMA, upgradeMediaLibraryShape } from "../../src/persistence/sqlite/sqlite-schema.js";
import { SqliteMediaLibraryRepository } from "../../src/persistence/sqlite/sqlite-media-library.js";
import { MediaLibraryScanner, normalizeMediaTitle } from "../../src/library/library-scanner.js";
import type { DriveFileManager, DriveDirectoryListing } from "../../src/storage/drive-file-manager-types.js";

describe("MediaLibraryLifecycle & Deduplication Guard", () => {
  let db: Database.Database;
  let repo: SqliteMediaLibraryRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SQLITE_SCHEMA);
    upgradeMediaLibraryShape(db);

    repo = new SqliteMediaLibraryRepository({
      db,
      now: () => "2026-11-13T10:00:00.000Z",
      transaction: <T>(fn: () => T) => db.transaction(fn),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("normalizeMediaTitle should strip punctuation, whitespace and casing correctly", () => {
    expect(normalizeMediaTitle("The Hotel New Hampshire")).toBe("thehotelnewhampshire");
    expect(normalizeMediaTitle("The.Hotel.New.Hampshire")).toBe("thehotelnewhampshire");
    expect(normalizeMediaTitle("新汉普夏饭店 (1984)")).toBe("新汉普夏饭店1984");
    expect(normalizeMediaTitle("【4K】凡人修仙传 [星海飞驰]")).toBe("4k凡人修仙传星海飞驰");
  });

  it("should cluster multiple video files of the same movie into a SINGLE media item with multiple versions", async () => {
    const lib = repo.createLibrary({
      accountId: "acct_demo",
      name: "测试电影库",
      libraryType: "movie",
    });

    const binding = repo.createPathBinding({
      libraryId: lib.id,
      storageId: "pan115_mock",
      remoteFolderId: "cid_hotel_folder",
      remotePath: "/Movies/The Hotel New Hampshire",
      minFileSizeMb: 10,
    });

    // 模拟用户真实场景中的 6 个不同清晰度/命名的同一部电影文件
    const mockFiles = [
      { id: "f_01", name: "The.Hotel.New.Hampshire.1984.1080p.BluRay.x264.mkv", sizeBytes: 8 * 1024 * 1024 * 1024 },
      { id: "f_02", name: "新汉普夏饭店.1984.Remux.AVC.DTS-HD.MA.mkv", sizeBytes: 25 * 1024 * 1024 * 1024 },
      { id: "f_03", name: "The Hotel New Hampshire (1984) 2160p UHD HDR.mkv", sizeBytes: 30 * 1024 * 1024 * 1024 },
      { id: "f_04", name: "Hotel.New.Hampshire.1984.720p.HDTV.x264.mp4", sizeBytes: 2 * 1024 * 1024 * 1024 },
      { id: "f_05", name: "[国英双语] 新汉普夏饭店 1984 WEB-DL 1080p.mkv", sizeBytes: 4 * 1024 * 1024 * 1024 },
      { id: "f_06", name: "The Hotel New Hampshire 1984 BDRip.avi", sizeBytes: 1500 * 1024 * 1024 },
    ];

    const mockFileManager: DriveFileManager = {
      listDirectory: async (_folderId?: string): Promise<DriveDirectoryListing> => ({
        storageId: "pan115_mock",
        provider: "pan115",
        currentDirectoryId: "cid_hotel_folder",
        currentDirectoryName: "The Hotel New Hampshire",
        folderCount: 0,
        fileCount: mockFiles.length,
        totalSizeBytes: mockFiles.reduce((acc, f) => acc + f.sizeBytes, 0),
        breadcrumbs: [],
        rootCid: null,
        moviesCid: null,
        tvCid: null,
        animeCid: null,
        items: mockFiles.map((f) => ({
          id: f.id,
          name: f.name,
          isFolder: false,
          sizeBytes: f.sizeBytes,
          extension: f.name.split(".").pop() || "mkv",
          updatedAt: "2026-11-13",
          type: "video" as const,
        })),
        totalCount: mockFiles.length,
      }),
      createFolder: async () => ({ id: "f_dummy", name: "dummy" }),
      renameItem: async () => {},
      deleteItems: async () => ({ deletedCount: 0 }),
      moveItems: async () => ({ movedCount: 0 }),
      copyItems: async () => ({ copiedCount: 0 }),
    };

    const scanner = new MediaLibraryScanner({
      repo,
      getFileManager: async () => mockFileManager,
      searchMetadata: async (query, year) => {
        // 模拟 TMDB 成功返回《新汉普夏饭店》元数据
        return {
          tmdbId: 11843,
          doubanId: null,
          title: "新汉普夏饭店",
          originalTitle: "The Hotel New Hampshire",
          overview: "一个奇特家庭在不同旅馆间迁徙的故事",
          posterPath: "/poster_hotel.jpg",
          backdropPath: "/backdrop_hotel.jpg",
          rating: 5.7,
          genres: ["剧情", "喜剧"],
        };
      },
    });

    const result = await scanner.scanBinding(binding.id);
    expect(result.scannedFiles).toBe(6);
    expect(result.ingestedEpisodes).toBe(6);

    // 核心断言 1：电影条目绝对不能重复生成 6 个卡片，必须且只能有 1 个卡片！
    const listResult = repo.listMediaItems({ libraryId: lib.id });
    expect(listResult.total).toBe(1);
    expect(listResult.items.length).toBe(1);

    const singleItem = listResult.items[0]!;
    expect(singleItem.title).toBe("新汉普夏饭店");
    expect(singleItem.tmdbId).toBe(11843);
    // 聚合了 6 个不同版本的单片
    expect(singleItem.versionCount).toBe(6);

    // 核心断言 2：正片 Season 下存在 6 个独立的 episode 版本，且带有不同的画质标签
    const seasons = repo.listSeasons(singleItem.id);
    expect(seasons.length).toBe(1);

    const episodes = repo.listEpisodes(seasons[0]!.id);
    expect(episodes.length).toBe(6);
    const tags = episodes.map((e) => e.versionTag);
    expect(tags.some((t) => t?.includes("1080p") || t?.includes("BluRay"))).toBe(true);
    expect(tags.some((t) => t?.includes("2160p") || t?.includes("4K"))).toBe(true);
  });

  it("should cleanly cascade delete all episodes, seasons and media items when binding is removed", async () => {
    const lib = repo.createLibrary({
      accountId: "acct_demo",
      name: "待清理库",
      libraryType: "movie",
    });

    const binding = repo.createPathBinding({
      libraryId: lib.id,
      storageId: "pan115_mock",
      remoteFolderId: "cid_test",
      remotePath: "/test",
    });

    const item = repo.upsertMediaItem({
      id: "item_test_01",
      libraryId: lib.id,
      mediaType: "movie",
      title: "待测试电影",
      releaseYear: 2024,
    });

    const season = repo.upsertSeason({
      id: "season_test_01",
      mediaItemId: item.id,
      seasonNumber: 1,
      name: "正片",
    });

    repo.upsertEpisode({
      id: "ep_test_01",
      seasonId: season.id,
      bindingId: binding.id,
      episodeNumber: 1,
      storageId: "pan115_mock",
      fileId: "f_test_01",
      fileName: "Movie.1080p.mkv",
      sizeBytes: 1024 * 1024 * 100,
    });

    // 确认入库成功
    expect(repo.listMediaItems({ libraryId: lib.id }).total).toBe(1);

    // 删除路径绑定
    const delResult = repo.deletePathBinding(binding.id);
    expect(delResult.success).toBe(true);
    expect(delResult.deletedEpisodes).toBe(1);
    expect(delResult.deletedItems).toBe(1);

    // 断言：该库下所有内容已被彻底级联清空
    const afterList = repo.listMediaItems({ libraryId: lib.id });
    expect(afterList.total).toBe(0);
    expect(afterList.items.length).toBe(0);

    // 数据库底层不留任何孤儿 season 与 episode
    expect(repo.listSeasons(item.id).length).toBe(0);
  });

  it("purgeOrphanedLibraryItems should self-heal and purge leftover items from unconfigured libraries", () => {
    const lib = repo.createLibrary({
      accountId: "acct_demo",
      name: "无绑定路径的空库",
      libraryType: "movie",
    });

    // 模拟无路径绑定的库中由于历史脏数据残留的孤儿条目
    repo.upsertMediaItem({
      id: "item_orphan_99",
      libraryId: lib.id,
      mediaType: "movie",
      title: "孤儿残留电影",
      releaseYear: 2020,
    });

    // 调用针对该库的深度孤儿清理
    const purgeReport = repo.purgeOrphanedLibraryItems(lib.id);
    expect(purgeReport.deletedItems).toBe(1);

    // 校验清空自愈成功
    const remaining = repo.listMediaItems({ libraryId: lib.id });
    expect(remaining.total).toBe(0);
  });
});

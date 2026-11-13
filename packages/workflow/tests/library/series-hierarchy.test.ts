import Database from "better-sqlite3";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SQLITE_SCHEMA, upgradeMediaLibraryShape } from "../../src/persistence/sqlite/sqlite-schema.js";
import { SqliteMediaLibraryRepository } from "../../src/persistence/sqlite/sqlite-media-library.js";
import { MediaLibraryScanner } from "../../src/library/library-scanner.js";
import type { DriveFileManager, DriveDirectoryListing } from "../../src/storage/drive-file-manager-types.js";

describe("Series Hierarchy & Episode-Version Separation Guard", () => {
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

  it("should cluster all nested video files into ONE series item using top-level folder boundary and separate episodes from versions", async () => {
    const lib = repo.createLibrary({
      accountId: "acct_demo",
      name: "动漫媒体库",
      libraryType: "anime",
    });

    const binding = repo.createPathBinding({
      libraryId: lib.id,
      storageId: "pan115_mock",
      remoteFolderId: "cid_root_anime",
      remotePath: "/动漫",
      minFileSizeMb: 10,
    });

    // 模拟网盘真实目录结构：
    // /动漫/ (root)
    //   └── 凡人修仙传 (2020) {tmdb-106449}/ (cid_fanren 一级剧集容器)
    //         ├── Season 01/ (cid_s1)
    //         │     ├── [GM-Team]凡人修仙传.EP01.1080p.mp4
    //         │     └── 凡人修仙传.EP01.4K.HDR.mkv  <-- 同一集(EP01)的多版本!
    //         ├── staging-42218692-xxx/ (cid_staging 深层杂乱目录)
    //         │     └── [GM-Team][国漫][凡人修仙传 星海飞驰][2023][02][AVC][GB][1080P].mp4
    //         └── deep_dir/ (cid_deep)
    //               └── 【高清剧集网发布 www PTH...】凡人修仙传.EP03.4K.mkv
    const mockFileManager: DriveFileManager = {
      listDirectory: async (folderId?: string): Promise<DriveDirectoryListing> => {
        const base = {
          storageId: "pan115_mock",
          provider: "pan115",
          folderCount: 0,
          fileCount: 0,
          totalSizeBytes: 0,
          breadcrumbs: [],
          rootCid: null,
          moviesCid: null,
          tvCid: null,
          animeCid: null,
        };

        if (!folderId || folderId === "cid_root_anime") {
          return {
            ...base,
            currentDirectoryId: "cid_root_anime",
            currentDirectoryName: "动漫",
            folderCount: 1,
            items: [
              {
                id: "cid_fanren",
                name: "凡人修仙传 (2020) {tmdb-106449}",
                isFolder: true,
                sizeBytes: 0,
                extension: "",
                updatedAt: "2026-11-13",
                type: "folder",
              },
            ],
            totalCount: 1,
          };
        }

        if (folderId === "cid_fanren") {
          return {
            ...base,
            currentDirectoryId: "cid_fanren",
            currentDirectoryName: "凡人修仙传 (2020) {tmdb-106449}",
            folderCount: 3,
            items: [
              { id: "cid_s1", name: "Season 01", isFolder: true, sizeBytes: 0, extension: "", updatedAt: "2026-11-13", type: "folder" },
              { id: "cid_staging", name: "staging-42218692-xxx", isFolder: true, sizeBytes: 0, extension: "", updatedAt: "2026-11-13", type: "folder" },
              { id: "cid_deep", name: "deep_dir", isFolder: true, sizeBytes: 0, extension: "", updatedAt: "2026-11-13", type: "folder" },
            ],
            totalCount: 3,
          };
        }

        if (folderId === "cid_s1") {
          return {
            ...base,
            currentDirectoryId: "cid_s1",
            currentDirectoryName: "Season 01",
            fileCount: 2,
            items: [
              {
                id: "f_ep1_1080p",
                name: "[GM-Team]凡人修仙传.EP01.1080p.mp4",
                isFolder: false,
                sizeBytes: 800 * 1024 * 1024,
                extension: "mp4",
                updatedAt: "2026-11-13",
                type: "video",
              },
              {
                id: "f_ep1_4k",
                name: "凡人修仙传.EP01.4K.HDR.mkv",
                isFolder: false,
                sizeBytes: 2500 * 1024 * 1024,
                extension: "mkv",
                updatedAt: "2026-11-13",
                type: "video",
              },
            ],
            totalCount: 2,
          };
        }

        if (folderId === "cid_staging") {
          return {
            ...base,
            currentDirectoryId: "cid_staging",
            currentDirectoryName: "staging-42218692-xxx",
            fileCount: 1,
            items: [
              {
                id: "f_ep2",
                name: "[GM-Team][国漫][凡人修仙传 星海飞驰][2023][02][AVC][GB][1080P].mp4",
                isFolder: false,
                sizeBytes: 900 * 1024 * 1024,
                extension: "mp4",
                updatedAt: "2026-11-13",
                type: "video",
              },
            ],
            totalCount: 1,
          };
        }

        if (folderId === "cid_deep") {
          return {
            ...base,
            currentDirectoryId: "cid_deep",
            currentDirectoryName: "deep_dir",
            fileCount: 1,
            items: [
              {
                id: "f_ep3",
                name: "【高清剧集网发布 www PTH...】凡人修仙传.EP03.4K.mkv",
                isFolder: false,
                sizeBytes: 1500 * 1024 * 1024,
                extension: "mkv",
                updatedAt: "2026-11-13",
                type: "video",
              },
            ],
            totalCount: 1,
          };
        }

        return { ...base, currentDirectoryId: folderId, currentDirectoryName: "empty", items: [], totalCount: 0 };
      },
      createFolder: async () => ({ id: "f", name: "f" }),
      renameItem: async () => {},
      deleteItems: async () => ({ deletedCount: 0 }),
      moveItems: async () => ({ movedCount: 0 }),
      copyItems: async () => ({ copiedCount: 0 }),
    };

    let tmdbCallCount = 0;
    const scanner = new MediaLibraryScanner({
      repo,
      getFileManager: async () => mockFileManager,
      searchMetadata: async () => {
        tmdbCallCount++;
        return {
          tmdbId: 106449,
          doubanId: null,
          title: "凡人修仙传",
          originalTitle: "凡人修仙传",
          overview: "山村少年韩立，机缘巧合下踏入修仙之旅...",
          posterPath: "/poster_fanren.jpg",
          backdropPath: "/backdrop_fanren.jpg",
          rating: 8.8,
          genres: ["动画", "奇幻", "武侠"],
        };
      },
    });

    const result = await scanner.scanBinding(binding.id);
    expect(result.scannedFiles).toBe(4);
    expect(result.ingestedEpisodes).toBe(4);

    // 核心断言 1：整个动漫库只有 1 个权威的《凡人修仙传》主条目！绝不分裂出 [GM-Team] 或 【高清剧集网发布... 乱码卡片！
    const listResult = repo.listMediaItems({ libraryId: lib.id });
    expect(listResult.total).toBe(1);
    expect(listResult.items.length).toBe(1);

    const showItem = listResult.items[0]!;
    expect(showItem.title).toBe("凡人修仙传");
    expect(showItem.tmdbId).toBe(106449);
    expect(showItem.releaseYear).toBe(2020);

    // 核心断言 2：集数不是版本！
    // 4 个文件实际上对应 3 个独立集数 (EP01, EP02, EP03)，其中 EP01 拥有 1080p 与 4K 两个画质版本
    expect(showItem.totalEpisodes).toBe(3); // 准确展示为 3 集！
    expect(showItem.hasMultiVersion).toBe(true); // 准确识别出存在同集多版本！

    // 核心断言 3：TMDB 网络刮削调用次数极度节约 (只为一级剧集目录发起，内部多文件 0 次重复调用)
    expect(tmdbCallCount).toBeLessThanOrEqual(1);

    // 核心断言 4：单集版本分布
    const seasons = repo.listSeasons(showItem.id);
    expect(seasons.length).toBeGreaterThanOrEqual(1);

    const episodes = repo.listEpisodes(seasons[0]!.id);
    const ep1Versions = episodes.filter((e) => e.episodeNumber === 1);
    expect(ep1Versions.length).toBe(2); // EP01 包含 2 个版本文件
    expect(ep1Versions.some((v) => v.versionTag?.includes("1080p"))).toBe(true);
    expect(ep1Versions.some((v) => v.versionTag?.includes("4K"))).toBe(true);

    const ep2Versions = episodes.filter((e) => e.episodeNumber === 2);
    expect(ep2Versions.length).toBe(1);

    const ep3Versions = episodes.filter((e) => e.episodeNumber === 3);
    expect(ep3Versions.length).toBe(1);
  });
});

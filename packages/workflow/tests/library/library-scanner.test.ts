import Database from "better-sqlite3";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SQLITE_SCHEMA, upgradeMediaLibraryShape } from "../../src/persistence/sqlite/sqlite-schema.js";
import { SqliteMediaLibraryRepository } from "../../src/persistence/sqlite/sqlite-media-library.js";
import { MediaLibraryScanner } from "../../src/library/library-scanner.js";
import type { DriveFileManager, DriveDirectoryListing } from "../../src/storage/drive-file-manager-types.js";
import type { LibraryScanProgressEvent } from "@media-track/contracts";

describe("MediaLibraryScanner", () => {
  let db: Database.Database;
  let repo: SqliteMediaLibraryRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SQLITE_SCHEMA);
    upgradeMediaLibraryShape(db);

    repo = new SqliteMediaLibraryRepository({
      db,
      now: () => "2026-11-12T10:00:00.000Z",
      transaction: <T>(fn: () => T) => db.transaction(fn),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("should perform full scan, extract seasons/episodes and associate external subtitles", async () => {
    const lib = repo.createLibrary({
      accountId: "acct_default",
      name: "动画媒体库",
      libraryType: "anime",
    });

    const binding = repo.createPathBinding({
      libraryId: lib.id,
      storageId: "pan115_mock",
      remoteFolderId: "cid_root",
      remotePath: "/动漫",
      minFileSizeMb: 50,
      excludeKeywords: ["sample"],
    });

    // Mock DriveFileManager
    const baseListing = {
      storageId: "pan115_mock",
      provider: "pan115",
      currentDirectoryId: "cid_root",
      currentDirectoryName: "Root",
      folderCount: 1,
      fileCount: 0,
      totalSizeBytes: 0,
      breadcrumbs: [],
      rootCid: null,
      moviesCid: null,
      tvCid: null,
      animeCid: null,
    };

    const mockFileManager: DriveFileManager = {
      listDirectory: async (folderId?: string): Promise<DriveDirectoryListing> => {
        if (!folderId || folderId === "cid_root") {
          return {
            ...baseListing,
            items: [
              {
                id: "cid_frieren",
                name: "葬送的芙莉莲 (2023) {tmdb-209867}",
                isFolder: true,
                sizeBytes: 0,
                extension: "",
                updatedAt: "2026-10-01",
                type: "folder",
              },
            ],
            totalCount: 1,
          };
        }
        if (folderId === "cid_frieren") {
          return {
            ...baseListing,
            currentDirectoryId: "cid_frieren",
            items: [
              {
                id: "cid_s1",
                name: "Season 01",
                isFolder: true,
                sizeBytes: 0,
                extension: "",
                updatedAt: "2026-10-01",
                type: "folder",
              },
            ],
            totalCount: 1,
          };
        }
        if (folderId === "cid_s1") {
          return {
            ...baseListing,
            currentDirectoryId: "cid_s1",
            items: [
              {
                id: "file_ep1",
                name: "Frieren - S01E01.1080p.mkv",
                isFolder: false,
                sizeBytes: 500 * 1024 * 1024,
                extension: ".mkv",
                updatedAt: "2026-10-01",
                type: "video",
              },
              {
                id: "sub_ep1",
                name: "Frieren - S01E01.1080p.zh-CN.ass",
                isFolder: false,
                sizeBytes: 100 * 1024,
                extension: ".ass",
                updatedAt: "2026-10-01",
                type: "subtitle",
              },
              {
                id: "file_sample",
                name: "Frieren - sample.mp4",
                isFolder: false,
                sizeBytes: 10 * 1024 * 1024,
                extension: ".mp4",
                updatedAt: "2026-10-01",
                type: "video",
              },
            ],
            totalCount: 3,
          };
        }
        return { ...baseListing, items: [], totalCount: 0 };
      },
      renameItem: async () => {},
      moveItems: async () => ({ movedCount: 1 }),
      copyItems: async () => ({ copiedCount: 1 }),
      deleteItems: async () => ({ deletedCount: 1 }),
      createFolder: async () => ({ id: "cid_new", name: "new" }),
    };

    const events: LibraryScanProgressEvent[] = [];
    const scanner = new MediaLibraryScanner({
      repo,
      getFileManager: async () => mockFileManager,
      searchMetadata: async () => ({
        tmdbId: 209867,
        title: "葬送的芙莉莲",
        rating: 9.0,
        overview: "魔王打倒后，精灵芙莉莲的旅途...",
        genres: ["动画", "奇幻"],
      }),
    });

    const result = await scanner.scanBinding(binding.id, {
      onProgress: (ev) => events.push(ev),
    });

    // 验证结果
    expect(result.ingestedEpisodes).toBe(1);
    expect(events.length).toBeGreaterThan(3);
    expect(events[events.length - 1]?.stage).toBe("COMPLETED");

    // 检查 DB 数据
    const items = repo.listMediaItems({ libraryId: lib.id });
    expect(items.total).toBe(1);
    const frieren = items.items[0]!;
    expect(frieren.title).toBe("葬送的芙莉莲");
    expect(frieren.tmdbId).toBe(209867);

    const seasons = repo.listSeasons(frieren.id);
    expect(seasons.length).toBe(1);
    expect(seasons[0]?.seasonNumber).toBe(1);

    const episodes = repo.listEpisodes(seasons[0]!.id);
    expect(episodes.length).toBe(1);
    expect(episodes[0]?.episodeNumber).toBe(1);
    expect(episodes[0]?.fileName).toBe("Frieren - S01E01.1080p.mkv");
    // 验证字幕关联
    expect(episodes[0]?.subtitles.length).toBe(1);
    expect(episodes[0]?.subtitles[0]?.format).toBe("ass");
    expect(episodes[0]?.subtitles[0]?.type).toBe("external");

    // 验证重入保护
    expect(scanner.isBindingRunning(binding.id)).toBe(false);
  });
});

import Database from "better-sqlite3";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SQLITE_SCHEMA, upgradeMediaLibraryShape } from "../../src/persistence/sqlite/sqlite-schema.js";
import { SqliteMediaLibraryRepository } from "../../src/persistence/sqlite/sqlite-media-library.js";
import { MediaLibraryScanner } from "../../src/library/library-scanner.js";
import type { DriveFileManager, DriveDirectoryListing, DriveFileItem } from "../../src/storage/drive-file-manager-types.js";

describe("Library Orphan Cleanup & Reconciliation", () => {
  let db: Database.Database;
  let repo: SqliteMediaLibraryRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SQLITE_SCHEMA);
    upgradeMediaLibraryShape(db);

    repo = new SqliteMediaLibraryRepository({
      db,
      now: () => "2026-11-20T12:00:00.000Z",
      transaction: <T>(fn: () => T) => db.transaction(fn),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("test_prune_orphans_on_file_deleted: 网盘删除单集后，扫描自动清理孤儿分集并保留存活分集", async () => {
    const lib = repo.createLibrary({
      accountId: "acct_test",
      name: "动漫库",
      libraryType: "anime",
    });

    const binding = repo.createPathBinding({
      libraryId: lib.id,
      storageId: "storage_pan115",
      remoteFolderId: "cid_root",
      remotePath: "/动漫",
      minFileSizeMb: 10,
    });

    // 初始状态：网盘有 EP01 与 EP02
    let remoteItems: DriveFileItem[] = [
      {
        id: "fid_ep01",
        name: "葬送的芙莉莲.S01E01.1080p.mkv",
        isFolder: false,
        sizeBytes: 500 * 1024 * 1024,
        extension: "mkv",
        updatedAt: "2026-10-01",
        type: "video" as const,
      },
      {
        id: "fid_ep02",
        name: "葬送的芙莉莲.S01E02.1080p.mkv",
        isFolder: false,
        sizeBytes: 500 * 1024 * 1024,
        extension: "mkv",
        updatedAt: "2026-10-01",
        type: "video" as const,
      },
    ];

    const mockFileManager = {
      listDirectory: async (_folderId?: string): Promise<DriveDirectoryListing> => ({
        storageId: "storage_pan115",
        provider: "pan115",
        currentDirectoryId: "cid_root",
        currentDirectoryName: "Root",
        folderCount: 0,
        fileCount: remoteItems.length,
        totalSizeBytes: 1000 * 1024 * 1024,
        breadcrumbs: [],
        rootCid: null,
        moviesCid: null,
        tvCid: null,
        animeCid: null,
        items: remoteItems,
        totalCount: remoteItems.length,
      }),
    } as unknown as DriveFileManager;

    const scanner = new MediaLibraryScanner({
      repo,
      getFileManager: async () => mockFileManager,
    });

    // 首次扫描：成功入库 2 集
    const firstResult = await scanner.scanBinding(binding.id);
    expect(firstResult.scannedFiles).toBe(2);
    expect(firstResult.ingestedEpisodes).toBe(2);
    expect(firstResult.removedEpisodes).toBe(0);

    const epsAfterFirst = repo.listEpisodesByBinding(binding.id);
    expect(epsAfterFirst).toHaveLength(2);

    // 模拟网盘删除了 EP02
    remoteItems = [remoteItems[0]!];

    // 第二次扫描：比对清理
    const secondResult = await scanner.scanBinding(binding.id);
    expect(secondResult.scannedFiles).toBe(1);
    expect(secondResult.removedEpisodes).toBe(1);

    const epsAfterSecond = repo.listEpisodesByBinding(binding.id);
    expect(epsAfterSecond).toHaveLength(1);
    expect(epsAfterSecond[0]!.fileId).toBe("fid_ep01");
  });

  it("test_prune_movie_cascades_to_media_item: 电影单文件删除后，级联修剪空季度与空海报墙卡片", async () => {
    const lib = repo.createLibrary({
      accountId: "acct_test",
      name: "电影库",
      libraryType: "movie",
    });

    const binding = repo.createPathBinding({
      libraryId: lib.id,
      storageId: "storage_pan115",
      remoteFolderId: "cid_movies",
      remotePath: "/电影",
      minFileSizeMb: 10,
    });

    let remoteItems: DriveFileItem[] = [
      {
        id: "fid_oppenheimer",
        name: "奥本海默 (2023) 4K.mkv",
        isFolder: false,
        sizeBytes: 15 * 1024 * 1024 * 1024,
        extension: "mkv",
        updatedAt: "2026-10-01",
        type: "video" as const,
      },
    ];

    const mockFileManager = {
      listDirectory: async (): Promise<DriveDirectoryListing> => ({
        storageId: "storage_pan115",
        provider: "pan115",
        currentDirectoryId: "cid_movies",
        currentDirectoryName: "Movies",
        folderCount: 0,
        fileCount: remoteItems.length,
        totalSizeBytes: 0,
        breadcrumbs: [],
        rootCid: null,
        moviesCid: null,
        tvCid: null,
        animeCid: null,
        items: remoteItems,
        totalCount: remoteItems.length,
      }),
    } as unknown as DriveFileManager;

    const scanner = new MediaLibraryScanner({
      repo,
      getFileManager: async () => mockFileManager,
    });

    // 首次扫描：奥本海默入库
    await scanner.scanBinding(binding.id);
    const mediaItemsBefore = repo.listMediaItems({ libraryId: lib.id });
    expect(mediaItemsBefore.items).toHaveLength(1);
    expect(mediaItemsBefore.items[0]!.title).toContain("奥本海默");

    // 模拟网盘把奥本海默删了
    remoteItems = [];

    // 第二次扫描：触发空盘保护（因为只有 1 个文件，变为 0 个，必须触发空盘保护拒绝误清空）
    const protectedResult = await scanner.scanBinding(binding.id);
    expect(protectedResult.cleanupSkippedReason).toContain("EMPTY_DISCOVERY_BLOCKED");
    expect(protectedResult.removedEpisodes).toBe(0);
    expect(repo.listMediaItems({ libraryId: lib.id }).items).toHaveLength(1);

    // 用户显式允许空盘清理（forceAllowEmptyCleanup: true）
    const forceResult = await scanner.scanBinding(binding.id, { forceAllowEmptyCleanup: true });
    expect(forceResult.removedEpisodes).toBe(1);
    expect(forceResult.prunedItems).toBe(1);

    // 验证级联修剪结果：分集没了，季度没了，电影条目也彻底从数据库消失
    expect(repo.listEpisodesByBinding(binding.id)).toHaveLength(0);
    expect(repo.listMediaItems({ libraryId: lib.id }).items).toHaveLength(0);
  });

  it("test_empty_remote_triggers_circuit_breaker: 远端返回 0 个文件时，空盘熔断绝对保护数据库资产", async () => {
    const lib = repo.createLibrary({
      accountId: "acct_test",
      name: "剧集库",
      libraryType: "tv",
    });

    const binding = repo.createPathBinding({
      libraryId: lib.id,
      storageId: "storage_pan115",
      remoteFolderId: "cid_tv",
      remotePath: "/剧集",
      minFileSizeMb: 10,
    });

    // 预先插入 5 个分集
    for (let i = 1; i <= 5; i++) {
      repo.upsertEpisode({
        id: `ep_${i}`,
        seasonId: "season_breaking_bad_s1",
        bindingId: binding.id,
        episodeNumber: i,
        storageId: binding.storageId,
        fileId: `fid_bb_s01e0${i}`,
        fileName: `Breaking.Bad.S01E0${i}.mkv`,
        sizeBytes: 1024 * 1024 * 500,
      });
    }

    const mockFileManager = {
      listDirectory: async (): Promise<DriveDirectoryListing> => ({
        storageId: "storage_pan115",
        provider: "pan115",
        currentDirectoryId: "cid_tv",
        currentDirectoryName: "TV",
        folderCount: 0,
        fileCount: 0,
        totalSizeBytes: 0,
        breadcrumbs: [],
        rootCid: null,
        moviesCid: null,
        tvCid: null,
        animeCid: null,
        items: [], // 空盘响应
        totalCount: 0,
      }),
    } as unknown as DriveFileManager;

    const scanner = new MediaLibraryScanner({
      repo,
      getFileManager: async () => mockFileManager,
    });

    const result = await scanner.scanBinding(binding.id);
    expect(result.cleanupSkippedReason).toContain("EMPTY_DISCOVERY_BLOCKED");
    expect(result.removedEpisodes).toBe(0);

    // 数据库现有 5 个分集毫发无损
    const remaining = repo.listEpisodesByBinding(binding.id);
    expect(remaining).toHaveLength(5);
  });

  it("test_high_delete_rate_aborts_cleanup: 待清理比例超过 30% 安全阈值时触发熔断，拒绝物理删除", async () => {
    const lib = repo.createLibrary({
      accountId: "acct_test",
      name: "电视剧",
      libraryType: "tv",
    });

    const binding = repo.createPathBinding({
      libraryId: lib.id,
      storageId: "storage_pan115",
      remoteFolderId: "cid_tv",
      remotePath: "/电视剧",
      minFileSizeMb: 10,
    });

    // 预先插入 10 个有效分集
    for (let i = 1; i <= 10; i++) {
      repo.upsertEpisode({
        id: `ep_got_${i}`,
        seasonId: "season_got_s1",
        bindingId: binding.id,
        episodeNumber: i,
        storageId: binding.storageId,
        fileId: `fid_got_${i}`,
        fileName: `GOT.S01E0${i}.mkv`,
        sizeBytes: 1024 * 1024 * 500,
      });
    }

    // 模拟网盘删除了 5 个（待清理比例 50% > 30% 阈值）
    const remoteItems: DriveFileItem[] = [];
    for (let i = 1; i <= 5; i++) {
      remoteItems.push({
        id: `fid_got_${i}`,
        name: `GOT.S01E0${i}.mkv`,
        isFolder: false,
        sizeBytes: 500 * 1024 * 1024,
        extension: "mkv",
        updatedAt: "2026-10-01",
        type: "video" as const,
      });
    }

    const mockFileManager = {
      listDirectory: async (): Promise<DriveDirectoryListing> => ({
        storageId: "storage_pan115",
        provider: "pan115",
        currentDirectoryId: "cid_tv",
        currentDirectoryName: "TV",
        folderCount: 0,
        fileCount: remoteItems.length,
        totalSizeBytes: 0,
        breadcrumbs: [],
        rootCid: null,
        moviesCid: null,
        tvCid: null,
        animeCid: null,
        items: remoteItems,
        totalCount: remoteItems.length,
      }),
    } as unknown as DriveFileManager;

    const scanner = new MediaLibraryScanner({
      repo,
      getFileManager: async () => mockFileManager,
    });

    const result = await scanner.scanBinding(binding.id);
    expect(result.cleanupSkippedReason).toContain("HIGH_PRUNE_RATE_BLOCKED");
    expect(result.removedEpisodes).toBe(0);

    // 数据库 10 个条目均未被误删
    expect(repo.listEpisodesByBinding(binding.id)).toHaveLength(10);
  });

  it("test_file_rename_updates_path_without_duplicate: 网盘文件重命名时原地更新，不产生重复幽灵卡片", async () => {
    const lib = repo.createLibrary({
      accountId: "acct_test",
      name: "动漫库",
      libraryType: "anime",
    });

    const binding = repo.createPathBinding({
      libraryId: lib.id,
      storageId: "storage_pan115",
      remoteFolderId: "cid_anime",
      remotePath: "/动漫",
      minFileSizeMb: 10,
    });

    let remoteItems: DriveFileItem[] = [
      {
        id: "fid_jjk_01",
        name: "咒术回战.第一季.01.mkv",
        isFolder: false,
        sizeBytes: 800 * 1024 * 1024,
        extension: "mkv",
        updatedAt: "2026-10-01",
        type: "video" as const,
      },
    ];

    const mockFileManager = {
      listDirectory: async (): Promise<DriveDirectoryListing> => ({
        storageId: "storage_pan115",
        provider: "pan115",
        currentDirectoryId: "cid_anime",
        currentDirectoryName: "Anime",
        folderCount: 0,
        fileCount: remoteItems.length,
        totalSizeBytes: 0,
        breadcrumbs: [],
        rootCid: null,
        moviesCid: null,
        tvCid: null,
        animeCid: null,
        items: remoteItems,
        totalCount: remoteItems.length,
      }),
    } as unknown as DriveFileManager;

    const scanner = new MediaLibraryScanner({
      repo,
      getFileManager: async () => mockFileManager,
    });

    await scanner.scanBinding(binding.id);
    const eps1 = repo.listEpisodesByBinding(binding.id);
    expect(eps1).toHaveLength(1);
    expect(eps1[0]!.fileName).toBe("咒术回战.第一季.01.mkv");

    // 用户在网盘把文件名重命名为标准化格式
    remoteItems = [
      {
        id: "fid_jjk_01", // 相同的 fileId 指纹
        name: "Jujutsu Kaisen.S01E01.1080p.mkv",
        isFolder: false,
        sizeBytes: 800 * 1024 * 1024,
        extension: "mkv",
        updatedAt: "2026-10-02",
        type: "video" as const,
      },
    ];

    await scanner.scanBinding(binding.id);
    const eps2 = repo.listEpisodesByBinding(binding.id);
    // 不会新增第二张卡片，依然只有 1 集，且文件名已平滑更新
    expect(eps2).toHaveLength(1);
    expect(eps2[0]!.fileName).toBe("Jujutsu Kaisen.S01E01.1080p.mkv");
    expect(eps2[0]!.id).toBe(eps1[0]!.id);
  });

  it("test_soft_delete_and_rediscover: 软删除策略标记 missing，重新发现后自动恢复 active", async () => {
    const lib = repo.createLibrary({
      accountId: "acct_test",
      name: "软删除测试库",
      libraryType: "tv",
    });

    const binding = repo.createPathBinding({
      libraryId: lib.id,
      storageId: "storage_pan115",
      remoteFolderId: "cid_soft",
      remotePath: "/软删除",
      minFileSizeMb: 10,
    });

    // 预先插入 1 个分集
    repo.upsertEpisode({
      id: "ep_soft_01",
      seasonId: "season_soft_s1",
      bindingId: binding.id,
      episodeNumber: 1,
      storageId: binding.storageId,
      fileId: "fid_soft_01",
      fileName: "Demo.S01E01.mkv",
      sizeBytes: 1024 * 1024 * 500,
      status: "active",
    });

    // 1. 软删除比对：远端未返回 fid_soft_01（允许空盘清理以便测试单集变化）
    const pruneRes = repo.reconcileBindingEpisodes({
      bindingId: binding.id,
      libraryId: lib.id,
      discoveredFileIds: [],
      strategy: "soft_delete",
      forceAllowEmptyCleanup: true,
    });
    expect(pruneRes.status).toBe("reconciled");
    expect(pruneRes.markedMissingCount).toBe(1);

    const epMissing = repo.getEpisode("ep_soft_01");
    expect(epMissing?.status).toBe("missing");
    expect(epMissing?.missingSince).toBeTruthy();

    // 2. 重新发现：远端再次出现 fid_soft_01
    const restoreRes = repo.reconcileBindingEpisodes({
      bindingId: binding.id,
      libraryId: lib.id,
      discoveredFileIds: ["fid_soft_01"],
      strategy: "soft_delete",
    });
    expect(restoreRes.status).toBe("reconciled");
    expect(restoreRes.restoredCount).toBe(1);

    const epActive = repo.getEpisode("ep_soft_01");
    expect(epActive?.status).toBe("active");
    expect(epActive?.missingSince).toBeNull();
  });
});

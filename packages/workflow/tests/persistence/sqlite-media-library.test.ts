import Database from "better-sqlite3";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SQLITE_SCHEMA, upgradeMediaLibraryShape } from "../../src/persistence/sqlite/sqlite-schema.js";
import { SqliteMediaLibraryRepository } from "../../src/persistence/sqlite/sqlite-media-library.js";
import type { SqliteDbContext } from "../../src/persistence/sqlite-context.js";

describe("SqliteMediaLibraryRepository", () => {
  let db: Database.Database;
  let repo: SqliteMediaLibraryRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SQLITE_SCHEMA);
    upgradeMediaLibraryShape(db);

    const ctx: SqliteDbContext = {
      db,
      now: () => "2026-11-12T10:00:00.000Z",
      transaction: <T>(fn: () => T) => db.transaction(fn),
    };
    repo = new SqliteMediaLibraryRepository(ctx);
  });

  afterEach(() => {
    db.close();
  });

  it("should create, list, update and delete media libraries", () => {
    const lib1 = repo.createLibrary({
      accountId: "acct_default",
      name: "精选电影",
      libraryType: "movie",
      defaultDeliveryMode: "redirect",
    });

    expect(lib1.id).toMatch(/^lib_/);
    expect(lib1.name).toBe("精选电影");
    expect(lib1.libraryType).toBe("movie");
    expect(lib1.defaultDeliveryMode).toBe("redirect");

    const lib2 = repo.createLibrary({
      accountId: "acct_default",
      name: "追番动漫",
      libraryType: "anime",
      defaultDeliveryMode: "proxy",
      isPinned: true,
    });

    const list = repo.listLibraries("acct_default");
    expect(list.length).toBe(2);
    // 置顶项优先
    expect(list[0]?.id).toBe(lib2.id);

    // 更新库
    const updated = repo.updateLibrary(lib1.id, {
      name: "华语电影精选",
      posterStyle: "backdrop",
    });
    expect(updated?.name).toBe("华语电影精选");
    expect(updated?.posterStyle).toBe("backdrop");

    // 删除库
    const deleted = repo.deleteLibrary(lib1.id);
    expect(deleted).toBe(true);
    expect(repo.getLibrary(lib1.id)).toBeNull();
  });

  it("should create, list, update and delete path bindings with independent scan configs", () => {
    const lib = repo.createLibrary({
      accountId: "acct_default",
      name: "剧集中心",
      libraryType: "tv",
    });

    const binding = repo.createPathBinding({
      libraryId: lib.id,
      storageId: "storage_pan115_01",
      remoteFolderId: "cid_123456",
      remotePath: "/影视/欧美剧",
      scheduledScanEnabled: true,
      scanIntervalMinutes: 180,
      scanCron: "0 2 * * *",
      scanMode: "incremental_missing",
      minFileSizeMb: 200,
      excludeKeywords: ["sample", "trailer"],
      deliveryMode: "redirect",
    });

    expect(binding.id).toMatch(/^bind_/);
    expect(binding.scheduledScanEnabled).toBe(true);
    expect(binding.scanIntervalMinutes).toBe(180);
    expect(binding.excludeKeywords).toEqual(["sample", "trailer"]);
    expect(binding.deliveryMode).toBe("redirect");

    const bindings = repo.listPathBindings(lib.id);
    expect(bindings.length).toBe(1);
    expect(bindings[0]?.id).toBe(binding.id);

    // 更新路径绑定
    const updated = repo.updatePathBinding(binding.id, {
      scanIntervalMinutes: 720,
      deliveryMode: "proxy",
      lastScanStatus: "success",
    });
    expect(updated?.scanIntervalMinutes).toBe(720);
    expect(updated?.deliveryMode).toBe("proxy");
    expect(updated?.lastScanStatus).toBe("success");

    // 删除路径绑定
    expect(repo.deletePathBinding(binding.id).success).toBe(true);
    expect(repo.getPathBinding(binding.id)).toBeNull();
  });

  it("should manage media items, seasons, episodes and protect locked metadata", () => {
    const lib = repo.createLibrary({
      accountId: "acct_default",
      name: "动漫专区",
      libraryType: "anime",
    });

    // 1. 录入影视条目
    const item = repo.upsertMediaItem({
      id: "item_frieren",
      libraryId: lib.id,
      tmdbId: 209867,
      mediaType: "tv",
      title: "葬送的芙莉莲",
      releaseYear: 2023,
      rating: 8.9,
      genres: ["动画", "奇幻", "冒险"],
      isMetadataLocked: false,
      reviewStatus: "auto_accepted",
    });

    expect(item.title).toBe("葬送的芙莉莲");
    expect(item.genres).toEqual(["动画", "奇幻", "冒险"]);

    // 查找测试
    const foundByTmdb = repo.findMediaItemByTmdb(lib.id, 209867);
    expect(foundByTmdb?.id).toBe("item_frieren");

    const foundByTitle = repo.findMediaItemByTitleYear(lib.id, "葬送的芙莉莲", 2023);
    expect(foundByTitle?.id).toBe("item_frieren");

    // 2. 元数据锁定测试
    // 用户手动改名并锁定
    repo.upsertMediaItem({
      id: "item_frieren",
      libraryId: lib.id,
      title: "【锁定片名】葬送的芙莉莲 特别珍藏版",
      isMetadataLocked: true,
      mediaType: "tv",
    });

    // 模拟自动扫描器尝试覆盖片名
    const afterScan = repo.upsertMediaItem({
      id: "item_frieren",
      libraryId: lib.id,
      title: "葬送的芙莉莲（自动抓取原名）",
      mediaType: "tv",
    });
    // 验证锁定字段未被破坏
    expect(afterScan.title).toBe("【锁定片名】葬送的芙莉莲 特别珍藏版");
    expect(afterScan.isMetadataLocked).toBe(true);

    // 3. 季与集维护
    const season = repo.upsertSeason({
      id: "season_frieren_s1",
      mediaItemId: item.id,
      seasonNumber: 1,
      name: "第 1 季",
      totalEpisodes: 28,
    });
    expect(season.seasonNumber).toBe(1);

    const episode = repo.upsertEpisode({
      id: "ep_frieren_s01e01",
      seasonId: season.id,
      episodeNumber: 1,
      episodeName: "冒险的终结",
      storageId: "storage_pan115_01",
      fileId: "file_115_998877",
      fileName: "葬送的芙莉莲 - S01E01 [1080P].mkv",
      sizeBytes: 1024 * 1024 * 650,
      resolution: "1080p",
      subtitles: [
        {
          id: "sub_1",
          language: "chi",
          title: "简日双语 (ASS)",
          format: "ass",
          type: "embedded",
        },
      ],
    });

    expect(episode.episodeNumber).toBe(1);
    expect(episode.subtitles.length).toBe(1);
    expect(episode.subtitles[0]?.format).toBe("ass");

    // 根据 storageId + fileId 反查集数
    const foundEp = repo.findEpisodeByStorageFile("storage_pan115_01", "file_115_998877");
    expect(foundEp?.id).toBe(episode.id);

    // 网盘端重命名同步更新
    repo.updateEpisodeFileName(episode.id, "葬送的芙莉莲 - S01E01 [Baha 1080P].mp4");
    const updatedEp = repo.getEpisode(episode.id);
    expect(updatedEp?.fileName).toBe("葬送的芙莉莲 - S01E01 [Baha 1080P].mp4");

    // 列表与分页查询
    const listResult = repo.listMediaItems({ libraryId: lib.id, query: "芙莉莲" });
    expect(listResult.total).toBe(1);
    expect(listResult.items[0]?.id).toBe("item_frieren");
  });

  it("should record and retrieve incremental scan snapshots", () => {
    repo.saveScanSnapshot({
      id: "snap_dir_001",
      bindingId: "bind_test",
      dirId: "cid_root",
      dirName: "动漫",
      dirPath: "/影视/动漫",
      fileCount: 42,
      lastModifiedHash: "hash_abcdef123456",
      checkedAt: "2026-11-12T10:00:00.000Z",
    });

    const snapshot = repo.getScanSnapshot("bind_test", "cid_root");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.fileCount).toBe(42);
    expect(snapshot?.lastModifiedHash).toBe("hash_abcdef123456");

    // 更新快照
    repo.saveScanSnapshot({
      id: "snap_dir_001",
      bindingId: "bind_test",
      dirId: "cid_root",
      dirName: "动漫",
      dirPath: "/影视/动漫",
      fileCount: 45,
      lastModifiedHash: "hash_new_modified",
      checkedAt: "2026-11-12T10:15:00.000Z",
    });

    const updatedSnap = repo.getScanSnapshot("bind_test", "cid_root");
    expect(updatedSnap?.fileCount).toBe(45);
    expect(updatedSnap?.lastModifiedHash).toBe("hash_new_modified");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaTitle } from "../../src/domain.js";
import { FakeStorageExecutor } from "../../src/domain/fakes.js";
import { InMemoryWorkflowRepository } from "../../src/persistence/repository.js";
import {
  triggerPostIngestSync,
  triggerPostIngestSyncIfSucceeded,
} from "../../src/strm/pinpoint-ingest-sync.js";

describe("Post-Ingest Automation", () => {
  const dirs: string[] = [];
  const makeTempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "post-ingest-test-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  it("电影入库成功：精准生成规范 STRM 路径并触发媒体库防抖刷新", async () => {
    const repo = new InMemoryWorkflowRepository();
    const tempDir = makeTempDir();

    await repo.upsertConnectedStorage({
      id: "cs_1",
      accountId: "acct_1",
      provider: "pan115",
      providerUid: "uid_1",
      payload: { cookie: "mock" },
      createdAt: new Date().toISOString(),
    });

    const task = await repo.createStrmTask({
      accountId: "acct_1",
      name: "Movies Task",
      storageId: "cs_1",
      remoteFolderId: "root_1",
      remotePath: "/Movies",
      localOutputDir: tempDir,
      scanIntervalMinutes: 120,
      scanMode: "incremental_missing",
      extensions: "mkv;mp4",
      deliveryMode: "redirect",
      isActive: true,
    });

    const storage = new FakeStorageExecutor();
    // 创建电影媒体库根目录
    const categoryParentId = await storage.createDirectory({
      name: "Movies",
      parentId: "root_1",
    });

    const movieTitle: MediaTitle = {
      id: "tmdb_movie_100",
      tmdbId: 100,
      type: "movie",
      title: "流浪地球",
      originalTitle: "The Wandering Earth",
      year: 2019,
      aliases: [],
    };

    // 预建电影媒体库目录并在其下存入视频文件
    const movieDirId = await storage.createDirectory({
      name: "流浪地球 (2019) {tmdb-100}",
      parentId: categoryParentId,
    });
    storage.seedDirectoryFiles(movieDirId, [
      {
        id: "f_movie_1",
        storageDirectoryId: movieDirId,
        name: "The.Wandering.Earth.2019.2160p.mkv",
        sizeBytes: 80 * 1024 * 1024,
        episodeCode: null,
        providerFileId: "f_movie_1",
      },
    ]);

    const mockCoordinator = {
      notifyFilesChanged: vi.fn(),
    };

    await triggerPostIngestSyncIfSucceeded("succeeded", {
      accountId: "acct_1",
      connectedStorageId: "cs_1",
      repository: repo,
      storage,
      title: movieTitle,
      categoryParentId,
      baseUrl: "http://127.0.0.1:3000",
      mediaServerCoordinator: mockCoordinator as any,
    });

    expect(mockCoordinator.notifyFilesChanged).toHaveBeenCalledTimes(1);
    const [accountId, filePaths] = mockCoordinator.notifyFilesChanged.mock.calls[0]!;
    expect(accountId).toBe("acct_1");
    expect(filePaths).toHaveLength(1);

    const generatedStrm = filePaths[0]!;
    expect(generatedStrm).toContain("流浪地球 (2019) {tmdb-100}");
    expect(generatedStrm.endsWith(".strm")).toBe(true);
    expect(fs.existsSync(generatedStrm)).toBe(true);

    const content = fs.readFileSync(generatedStrm, "utf8").trim();
    expect(content).toContain(`/api/strm/play/${task.id}/`);
    expect(content).toContain("The.Wandering.Earth.2019.2160p.mkv");
  });

  it("剧集入库成功：规范归入 Season 文件夹并生成 STRM", async () => {
    const repo = new InMemoryWorkflowRepository();
    const tempDir = makeTempDir();

    await repo.upsertConnectedStorage({
      id: "cs_1",
      accountId: "acct_1",
      provider: "pan115",
      providerUid: "uid_1",
      payload: { cookie: "mock" },
      createdAt: new Date().toISOString(),
    });

    await repo.createStrmTask({
      accountId: "acct_1",
      name: "TV Task",
      storageId: "cs_1",
      remoteFolderId: "root_tv",
      remotePath: "/TV",
      localOutputDir: tempDir,
      scanIntervalMinutes: 120,
      scanMode: "incremental_missing",
      extensions: "mkv;mp4",
      deliveryMode: "proxy",
      isActive: true,
    });

    const storage = new FakeStorageExecutor();
    const categoryParentId = await storage.createDirectory({
      name: "TV",
      parentId: "root_tv",
    });

    const tvTitle: MediaTitle = {
      id: "tmdb_tv_200",
      tmdbId: 200,
      type: "tv",
      title: "三体",
      originalTitle: "Three Body",
      year: 2023,
      aliases: [],
    };

    const tvDirId = await storage.createDirectory({
      name: "三体 (2023) {tmdb-200}",
      parentId: categoryParentId,
    });
    const seasonDirId = await storage.createDirectory({
      name: "Season 1",
      parentId: tvDirId,
    });
    storage.seedDirectoryFiles(seasonDirId, [
      {
        id: "f_tv_1",
        storageDirectoryId: seasonDirId,
        name: "Three.Body.S01E01.1080p.mkv",
        sizeBytes: 50 * 1024 * 1024,
        episodeCode: "S01E01",
        providerFileId: "f_tv_1",
      },
    ]);

    const mockCoordinator = {
      notifyFilesChanged: vi.fn(),
    };

    await triggerPostIngestSync({
      accountId: "acct_1",
      connectedStorageId: "cs_1",
      repository: repo,
      storage,
      title: tvTitle,
      categoryParentId,
      baseUrl: "http://127.0.0.1:3000",
      mediaServerCoordinator: mockCoordinator as any,
    });

    expect(mockCoordinator.notifyFilesChanged).toHaveBeenCalledTimes(1);
    const [, filePaths] = mockCoordinator.notifyFilesChanged.mock.calls[0]!;
    expect(filePaths).toHaveLength(1);
    const generatedStrm = filePaths[0]!;
    expect(generatedStrm).toContain("三体 (2023) {tmdb-200}");
    expect(generatedStrm).toContain("Season 1");
  });

  it("未传 connectedStorageId 时自动回退查询账号活跃存储", async () => {
    const repo = new InMemoryWorkflowRepository();
    const tempDir = makeTempDir();

    await repo.upsertConnectedStorage({
      id: "cs_auto",
      accountId: "acct_1",
      provider: "pan115",
      providerUid: "uid_auto",
      payload: { cookie: "mock" },
      createdAt: new Date().toISOString(),
    });

    await repo.createStrmTask({
      accountId: "acct_1",
      name: "Auto Task",
      storageId: "cs_auto",
      remoteFolderId: "root_1",
      remotePath: "/Movies",
      localOutputDir: tempDir,
      scanIntervalMinutes: 120,
      scanMode: "incremental_missing",
      extensions: "mkv",
      deliveryMode: "redirect",
      isActive: true,
    });

    const storage = new FakeStorageExecutor();
    const categoryParentId = await storage.createDirectory({
      name: "Movies",
      parentId: "root_1",
    });

    const movieTitle: MediaTitle = {
      id: "tmdb_movie_300",
      tmdbId: 300,
      type: "movie",
      title: "流浪地球 2",
      originalTitle: "The Wandering Earth 2",
      year: 2023,
      aliases: [],
    };

    const movieDirId = await storage.createDirectory({
      name: "流浪地球 2 (2023) {tmdb-300}",
      parentId: categoryParentId,
    });
    storage.seedDirectoryFiles(movieDirId, [
      {
        id: "f_movie_2",
        storageDirectoryId: movieDirId,
        name: "The.Wandering.Earth.2.2023.mkv",
        sizeBytes: 100 * 1024 * 1024,
        episodeCode: null,
        providerFileId: "f_movie_2",
      },
    ]);

    const mockCoordinator = {
      notifyFilesChanged: vi.fn(),
    };

    // 不传 connectedStorageId
    await triggerPostIngestSync({
      accountId: "acct_1",
      repository: repo,
      storage,
      title: movieTitle,
      categoryParentId,
      baseUrl: "http://127.0.0.1:3000",
      mediaServerCoordinator: mockCoordinator as any,
    });

    expect(mockCoordinator.notifyFilesChanged).toHaveBeenCalledTimes(1);
  });

  it("当状态不是 succeeded 时，triggerPostIngestSyncIfSucceeded 不会执行", async () => {
    const repo = new InMemoryWorkflowRepository();
    const storage = new FakeStorageExecutor();
    const mockCoordinator = {
      notifyFilesChanged: vi.fn(),
    };

    await triggerPostIngestSyncIfSucceeded("failed", {
      accountId: "acct_1",
      connectedStorageId: "cs_1",
      repository: repo,
      storage,
      title: {
        id: "m1",
        tmdbId: 1,
        type: "movie",
        title: "Test",
        originalTitle: "Test",
        year: 2024,
        aliases: [],
      },
      categoryParentId: "cat_1",
      baseUrl: "http://127.0.0.1:3000",
      mediaServerCoordinator: mockCoordinator as any,
    });

    expect(mockCoordinator.notifyFilesChanged).not.toHaveBeenCalled();
  });

  it("外部影视库通知或 STRM 异常绝不向外抛出（故障隔离）", async () => {
    const repo = new InMemoryWorkflowRepository();
    const storage = new FakeStorageExecutor();
    const brokenCoordinator = {
      notifyFilesChanged: vi.fn().mockImplementation(() => {
        throw new Error("Emby connection timeout");
      }),
    };

    // 即使内部抛异常，也不会中断或抛出
    await expect(
      triggerPostIngestSync({
        accountId: "acct_1",
        connectedStorageId: "cs_1",
        repository: repo,
        storage,
        title: {
          id: "m2",
          tmdbId: 2,
          type: "movie",
          title: "Test",
          originalTitle: "Test",
          year: 2024,
          aliases: [],
        },
        categoryParentId: "cat_1",
        baseUrl: "http://127.0.0.1:3000",
        mediaServerCoordinator: brokenCoordinator as any,
      }),
    ).resolves.not.toThrow();
  });

  it("远程媒体库支持 1 对多 STRM 任务：多个 STRM 任务绑定同一媒体库，入库生成落盘后精准传递任务绑定的媒体库信息", async () => {
    const repo = new InMemoryWorkflowRepository();
    const tempDir1 = makeTempDir();
    const tempDir2 = makeTempDir();

    await repo.upsertConnectedStorage({
      id: "cs_115",
      accountId: "acct_user",
      provider: "pan115",
      providerUid: "uid_115",
      payload: { cookie: "mock" },
      createdAt: new Date().toISOString(),
    });

    await repo.upsertConnectedStorage({
      id: "cs_quark",
      accountId: "acct_user",
      provider: "quark",
      providerUid: "uid_quark",
      payload: { cookie: "mock" },
      createdAt: new Date().toISOString(),
    });

    // 任务 1 (115 电影) -> 绑定客厅 Plex 的电影库 (sec_movie_10)
    await repo.createStrmTask({
      id: "task_115",
      accountId: "acct_user",
      name: "115 电影",
      storageId: "cs_115",
      remoteFolderId: "cid_115_movies",
      remotePath: "/Media/115/Movies",
      localOutputDir: tempDir1,
      mediaServerId: "srv_plex",
      mediaLibraryId: "sec_movie_10",
      mediaLibraryName: "电影",
      scanIntervalMinutes: 120,
      scanMode: "incremental_missing",
      extensions: "mkv;mp4",
      deliveryMode: "proxy",
      isActive: true,
    });

    // 任务 2 (夸克 电影) -> 同样绑定客厅 Plex 的电影库 (sec_movie_10) (1对多关系!)
    await repo.createStrmTask({
      id: "task_quark",
      accountId: "acct_user",
      name: "夸克 电影",
      storageId: "cs_quark",
      remoteFolderId: "cid_quark_movies",
      remotePath: "/Media/Quark/Movies",
      localOutputDir: tempDir2,
      mediaServerId: "srv_plex",
      mediaLibraryId: "sec_movie_10",
      mediaLibraryName: "电影",
      scanIntervalMinutes: 120,
      scanMode: "incremental_missing",
      extensions: "mkv;mp4",
      deliveryMode: "redirect",
      isActive: true,
    });

    const storage = new FakeStorageExecutor();
    const movieDirId = await storage.createDirectory({
      name: "流浪地球 (2019) {tmdb-100}",
      parentId: "cid_115_movies",
    });
    storage.seedDirectoryFiles(movieDirId, [
      {
        id: "f_115_1",
        storageDirectoryId: movieDirId,
        name: "The.Wandering.Earth.2019.mkv",
        sizeBytes: 100 * 1024 * 1024,
        episodeCode: null,
        providerFileId: "f_115_1",
      },
    ]);

    const notifiedContexts: any[] = [];
    const mockCoordinator = {
      notifyTaskFilesChanged: vi.fn().mockImplementation((ctx) => {
        notifiedContexts.push(ctx);
      }),
      notifyFilesChanged: vi.fn(),
    };

    // 触发 115 电影入库
    await triggerPostIngestSyncIfSucceeded("succeeded", {
      accountId: "acct_user",
      connectedStorageId: "cs_115",
      repository: repo,
      storage,
      title: {
        id: "tmdb_100",
        tmdbId: 100,
        type: "movie",
        title: "流浪地球",
        originalTitle: "The Wandering Earth",
        year: 2019,
        aliases: [],
      },
      categoryParentId: "cid_115_movies",
      baseUrl: "http://127.0.0.1:3000",
      mediaServerCoordinator: mockCoordinator as any,
    });

    // 1. 验证 .strm 文件在本地 tempDir1 正确生成落盘
    const generatedStrm = path.join(
      tempDir1,
      "流浪地球 (2019) {tmdb-100}",
      "The.Wandering.Earth.2019.strm",
    );
    expect(fs.existsSync(generatedStrm)).toBe(true);

    // 2. 验证落盘后协调器收到精准上下文，且带上了绑定的 mediaServerId 和 mediaLibraryId
    expect(mockCoordinator.notifyTaskFilesChanged).toHaveBeenCalledTimes(1);
    expect(notifiedContexts[0].mediaServerId).toBe("srv_plex");
    expect(notifiedContexts[0].mediaLibraryId).toBe("sec_movie_10");
    expect(notifiedContexts[0].mediaLibraryName).toBe("电影");
    expect(notifiedContexts[0].taskId).toBe("task_115");
  });
});

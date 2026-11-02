import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowRepository } from "../persistence/repository.js";
import { matchStrmTasksForIngest, syncPinpointIngestedFiles } from "./pinpoint-ingest-sync.js";
import type { StrmTask } from "./strm-types.js";

describe("matchStrmTasksForIngest", () => {
  it("同网盘下电影与剧集任务精准隔离，防止交叉污染", () => {
    const tasks: StrmTask[] = [
      {
        id: "task_movie",
        accountId: "acct_1",
        name: "115 电影 STRM",
        storageId: "cs_115",
        remoteFolderId: "cid_movie_100",
        remotePath: "/Media/Movies",
        localOutputDir: "D:/strm/movies",
        scanIntervalMinutes: 60,
        scanMode: "incremental_missing",
        extensions: "mkv;mp4",
        minFileSizeMb: 50,
        excludeKeywords: null,
        scheduleMode: "interval",
        status: "idle",
        isActive: true,
        lastScanAt: null,
        lastScanStatus: null,
        lastErrorMessage: null,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "task_tv",
        accountId: "acct_1",
        name: "115 电视剧 STRM",
        storageId: "cs_115",
        remoteFolderId: "cid_tv_200",
        remotePath: "/Media/TV",
        localOutputDir: "D:/strm/tv",
        scanIntervalMinutes: 60,
        scanMode: "incremental_missing",
        extensions: "mkv;mp4",
        minFileSizeMb: 10,
        excludeKeywords: null,
        scheduleMode: "interval",
        status: "idle",
        isActive: true,
        lastScanAt: null,
        lastScanStatus: null,
        lastErrorMessage: null,
        createdAt: "",
        updatedAt: "",
      },
    ];

    // 电影入库（命中 cid_movie_100）
    const matchedMovie = matchStrmTasksForIngest(tasks, {
      storageId: "cs_115",
      categoryParentId: "cid_movie_100",
      mediaType: "movie",
      title: "流浪地球",
    });
    expect(matchedMovie.map((t) => t.id)).toEqual(["task_movie"]);

    // 电视剧入库（命中 cid_tv_200）
    const matchedTv = matchStrmTasksForIngest(tasks, {
      storageId: "cs_115",
      categoryParentId: "cid_tv_200",
      mediaType: "tv",
      title: "三体",
    });
    expect(matchedTv.map((t) => t.id)).toEqual(["task_tv"]);

    // 即使未传 categoryParentId，通过 mediaType 语义也能精准隔离
    const matchedBySemantic = matchStrmTasksForIngest(tasks, {
      storageId: "cs_115",
      mediaType: "movie",
      title: "奥本海默",
    });
    expect(matchedBySemantic.map((t) => t.id)).toEqual(["task_movie"]);
  });
});

describe("syncPinpointIngestedFiles", () => {
  const dirs: string[] = [];
  const makeTempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinpoint-test-"));
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

  it("精准为入库文件生成 STRM 并调用 coordinator 防抖刷新", async () => {
    const repo = new InMemoryWorkflowRepository();
    const tempDir = makeTempDir();

    const task = await repo.createStrmTask({
      accountId: "acct_1",
      name: "115 Movies",
      storageId: "cs_115",
      remoteFolderId: "root_1",
      remotePath: "/Media/Movies",
      localOutputDir: tempDir,
      scanIntervalMinutes: 360,
      scanMode: "incremental_missing",
      extensions: "mkv;mp4",
      minFileSizeMb: 10,
      deliveryMode: "redirect",
      isActive: true,
    });

    const mockCoordinator = {
      notifyFilesChanged: vi.fn(),
    };

    const files = [
      {
        id: "file_101",
        name: "Oppenheimer.2023.2160p.mkv",
        sizeBytes: 50 * 1024 * 1024,
        subPath: "Oppenheimer (2023)",
      },
      {
        id: "file_sample",
        name: "sample.mp4",
        sizeBytes: 1 * 1024 * 1024, // 过滤掉：小于 10MB
        subPath: "Oppenheimer (2023)",
      },
    ];

    const result = await syncPinpointIngestedFiles({
      accountId: "acct_1",
      storageId: "cs_115",
      files,
      repository: repo,
      baseUrl: "http://192.168.1.100:3000",
      mediaServerCoordinator: mockCoordinator as any,
    });

    expect(result.refreshed).toBe(true);
    expect(result.generatedPaths).toHaveLength(1);

    const generatedPath = result.generatedPaths[0]!;
    expect(fs.existsSync(generatedPath)).toBe(true);
    const content = fs.readFileSync(generatedPath, "utf8").trim();
    expect(content).toBe(
      `http://192.168.1.100:3000/api/strm/play/${task.id}/file_101?name=Oppenheimer.2023.2160p.mkv`,
    );

    expect(mockCoordinator.notifyFilesChanged).toHaveBeenCalledWith("acct_1", [
      generatedPath,
    ]);
  });

  it("同盘多任务环境下：剧集入库仅写入剧集输出目录，并向 coordinator 发送结构化通知", async () => {
    const repo = new InMemoryWorkflowRepository();
    const movieDir = makeTempDir();
    const tvDir = makeTempDir();

    await repo.createStrmTask({
      accountId: "acct_1",
      name: "115 Movies",
      storageId: "cs_115",
      remoteFolderId: "cid_movie",
      remotePath: "/Media/Movies",
      localOutputDir: movieDir,
      scanIntervalMinutes: 360,
      scanMode: "incremental_missing",
      extensions: "mkv;mp4",
      minFileSizeMb: 50,
      deliveryMode: "redirect",
      isActive: true,
    });

    const tvTask = await repo.createStrmTask({
      accountId: "acct_1",
      name: "115 TV",
      storageId: "cs_115",
      remoteFolderId: "cid_tv",
      remotePath: "/Media/TV",
      localOutputDir: tvDir,
      scanIntervalMinutes: 360,
      scanMode: "incremental_missing",
      extensions: "mkv;mp4",
      minFileSizeMb: 10,
      deliveryMode: "proxy",
      isActive: true,
    });

    const mockCoordinator = {
      notifyTaskFilesChanged: vi.fn(),
      notifyFilesChanged: vi.fn(),
    };

    const files = [
      {
        id: "file_tv_1",
        name: "Three.Body.S01E01.mkv",
        sizeBytes: 25 * 1024 * 1024,
        subPath: "Three Body (2023)/Season 1",
      },
    ];

    const result = await syncPinpointIngestedFiles({
      accountId: "acct_1",
      storageId: "cs_115",
      files,
      repository: repo,
      categoryParentId: "cid_tv",
      mediaType: "tv",
      title: "三体",
      baseUrl: "http://192.168.1.100:3000",
      mediaServerCoordinator: mockCoordinator as any,
    });

    expect(result.refreshed).toBe(true);
    expect(result.generatedPaths).toHaveLength(1);

    // 严密断言：仅在 tvDir 中生成，movieDir 绝对保持为空！
    expect(fs.readdirSync(movieDir)).toHaveLength(0);
    const tvGeneratedPath = result.generatedPaths[0]!;
    expect(tvGeneratedPath.startsWith(tvDir)).toBe(true);
    expect(fs.existsSync(tvGeneratedPath)).toBe(true);

    // 严密断言：调用 notifyTaskFilesChanged 并携带结构化上下文
    expect(mockCoordinator.notifyTaskFilesChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_1",
        taskId: tvTask.id,
        taskName: "115 TV",
        mediaType: "show",
        relativeSubPaths: ["Three Body (2023)/Season 1/Three.Body.S01E01.strm"],
      }),
    );
  });
});

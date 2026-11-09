import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StrmScanner, type StrmScanProgress } from "../../src/strm/strm-scanner.js";
import type { StrmTask } from "../../src/strm/strm-types.js";
import type { StorageExecutor } from "../../src/domain/ports.js";

describe("StrmScanner with Progress Tracking", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = path.join(
      process.cwd(),
      "data",
      `strm-scanner-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    configPath = path.relative(process.cwd(), tmpDir).replace(/\\/g, "/");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function createMockTask(overrides: Partial<StrmTask> = {}): StrmTask {
    return {
      id: "task-test-1",
      accountId: "acc-1",
      name: "测试STRM任务",
      storageId: "storage-115-test",
      remoteFolderId: "remote-root",
      remotePath: "/movies",
      localOutputDir: configPath,
      scanIntervalMinutes: 60,
      status: "idle",
      scanMode: "incremental_missing",
      extensions: "mkv;mp4",
      minFileSizeMb: 10,
      excludeKeywords: null,
      scheduleMode: "interval",
      isActive: true,
      lastScanAt: null,
      lastScanStatus: null,
      lastErrorMessage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function createMockStorage(files: Array<{ id: string; name: string; sizeBytes: number }>): StorageExecutor {
    return {
      listVideoFiles: async () =>
        files.map((f) => ({
          id: f.id,
          storageDirectoryId: "remote-root",
          name: f.name,
          sizeBytes: f.sizeBytes,
          episodeCode: null,
          providerFileId: f.id,
        })),
    } as unknown as StorageExecutor;
  }

  it("should track progress across phases during incremental scan", async () => {
    const scanner = new StrmScanner();
    const task = createMockTask();
    const storage = createMockStorage([
      { id: "f1", name: "Movie.A.2024.1080p.mkv", sizeBytes: 50 * 1024 * 1024 },
      { id: "f2", name: "Movie.B.2024.1080p.mp4", sizeBytes: 100 * 1024 * 1024 },
      { id: "f3", name: "small.sample.mp4", sizeBytes: 2 * 1024 * 1024 }, // filtered by minFileSizeMb
    ]);

    const progressReports: StrmScanProgress[] = [];
    const result = await scanner.runScan({
      task,
      storage,
      baseUrl: "http://127.0.0.1:3000",
      onProgress: (p) => {
        progressReports.push({ ...p });
      },
    });

    expect(result.scannedCount).toBe(2);
    expect(result.generatedCount).toBe(2);
    expect(result.protected).toBe(false);

    // Verify progress tracking
    expect(progressReports.length).toBeGreaterThanOrEqual(4);
    const phases = progressReports.map((p) => p.phase);
    expect(phases).toContain("scanning_remote");
    expect(phases).toContain("filtering");
    expect(phases).toContain("scanning_local");
    expect(phases).toContain("generating");
    expect(phases).toContain("completed");

    const lastProgress = progressReports[progressReports.length - 1];
    expect(lastProgress?.phase).toBe("completed");
    expect(lastProgress?.percent).toBe(100);
    expect(lastProgress?.generatedCount).toBe(2);

    // Check generated files on disk
    const localFiles = fs.readdirSync(tmpDir);
    expect(localFiles).toHaveLength(2);
    expect(localFiles.some((f) => f.includes("Movie.A"))).toBe(true);
    expect(localFiles.some((f) => f.includes("Movie.B"))).toBe(true);
  });

  it("should trigger empty protection guard and report completed with reason", async () => {
    const scanner = new StrmScanner();
    const task = createMockTask({ scanMode: "full_sync" });

    // Simulate existing local STRM file
    fs.writeFileSync(path.join(tmpDir, "Existing.Movie.strm"), "http://some-url");

    // Empty remote files
    const storage = createMockStorage([]);

    const progressReports: StrmScanProgress[] = [];
    const result = await scanner.runScan({
      task,
      storage,
      baseUrl: "http://127.0.0.1:3000",
      forceAllowEmptyCleanup: false,
      onProgress: (p) => {
        progressReports.push({ ...p });
      },
    });

    expect(result.protected).toBe(true);
    expect(result.protectReason).toContain("空保护已触发");
    // File must NOT be deleted
    expect(fs.existsSync(path.join(tmpDir, "Existing.Movie.strm"))).toBe(true);

    const last = progressReports[progressReports.length - 1];
    expect(last?.phase).toBe("completed");
    expect(last?.percent).toBe(100);
  });

  it("should clean orphans in full_sync mode and report removedCount", async () => {
    const scanner = new StrmScanner();
    const task = createMockTask({ scanMode: "full_sync" });

    // Existing local file that remote does not have
    fs.writeFileSync(path.join(tmpDir, "Orphan.Movie.strm"), "http://old-url");

    const storage = createMockStorage([
      { id: "f1", name: "Valid.Movie.2024.mkv", sizeBytes: 80 * 1024 * 1024 },
    ]);

    const progressReports: StrmScanProgress[] = [];
    const result = await scanner.runScan({
      task,
      storage,
      baseUrl: "http://127.0.0.1:3000",
      onProgress: (p) => {
        progressReports.push({ ...p });
      },
    });

    expect(result.generatedCount).toBe(1);
    expect(result.removedCount).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, "Orphan.Movie.strm"))).toBe(false);
    expect(fs.readdirSync(tmpDir)).toHaveLength(1);

    const cleaningPhase = progressReports.find((p) => p.phase === "cleaning_orphans");
    expect(cleaningPhase).toBeDefined();
  });

  it("normalizes anime episode files into canonical STRM names for Emby/Jellyfin scraping", async () => {
    const scanner = new StrmScanner();
    const task = createMockTask({ scanMode: "incremental_missing" });

    const storage = {
      listVideoFiles: async () => [],
      listTree: async () => [
        {
          providerFileId: "f_anime_02",
          path: "桃源暗鬼 (2025) {tmdb-253811}/Season 01/[ReleaseGroup] TOUGEN ANKI - 02 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv",
          sizeBytes: 596 * 1024 * 1024,
        },
      ],
      createDirectory: async () => "d1",
      deleteFiles: async () => ({ deleted: [] }),
      moveFiles: async () => ({ moved: [] }),
      listChildDirectories: async () => [],
      renameFile: async () => {},
      copyFiles: async () => {},
    } as unknown as StorageExecutor;

    const result = await scanner.runScan({
      task,
      storage,
      baseUrl: "http://127.0.0.1:3000",
    });

    expect(result.generatedCount).toBe(1);

    const generatedPath = path.join(
      tmpDir,
      "桃源暗鬼 (2025) {tmdb-253811}",
      "Season 01",
      "桃源暗鬼 - S01E02.strm",
    );
    expect(fs.existsSync(generatedPath)).toBe(true);
    const content = fs.readFileSync(generatedPath, "utf8");
    expect(content).toContain("/api/strm/play/");
    expect(content).toContain("f_anime_02");
  });
});

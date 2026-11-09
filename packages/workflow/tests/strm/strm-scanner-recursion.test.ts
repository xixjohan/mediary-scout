import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StrmScanner } from "../../src/strm/strm-scanner.js";
import type { StrmTask } from "../../src/strm/strm-types.js";
import type { DriveDirectoryListing, DriveFileManager } from "../../src/storage/drive-file-manager.js";

describe("StrmScanner Recursive Traversal & Hierarchy Preservation", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = path.join(
      process.cwd(),
      "data",
      `strm-recursion-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
      id: "task-rec-1",
      accountId: "acct_default",
      name: "115",
      storageId: "cs_115",
      remoteFolderId: "root_anime",
      remotePath: "/Mediary Scout/Anime",
      localOutputDir: configPath,
      scanIntervalMinutes: 360,
      scanMode: "incremental_missing",
      extensions: "mp4;mkv;ts;avi;mov;wmv;iso;flv",
      minFileSizeMb: 100,
      excludeKeywords: "",
      scheduleMode: "interval",
      status: "idle",
      deliveryMode: "redirect",
      isActive: true,
      lastScanAt: null,
      lastScanStatus: null,
      lastErrorMessage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function createMockDriveFileManager(
    directoryStructure: Record<string, Array<{ id: string; name: string; isFolder: boolean; sizeBytes: number }>>,
  ): DriveFileManager {
    return {
      listDirectory: async (directoryId?: string): Promise<DriveDirectoryListing> => {
        const targetId = directoryId || "root_anime";
        const items = (directoryStructure[targetId] || []).map((it) => ({
          id: it.id,
          name: it.name,
          isFolder: it.isFolder,
          type: (it.isFolder ? "folder" : "video") as any,
          sizeBytes: it.sizeBytes,
          updatedAt: null,
          extension: it.isFolder ? "" : path.extname(it.name).replace(".", ""),
        }));
        return {
          storageId: "cs_115",
          provider: "pan115",
          currentDirectoryId: targetId,
          currentDirectoryName: targetId,
          items,
          totalCount: items.length,
          folderCount: items.filter((i) => i.isFolder).length,
          fileCount: items.filter((i) => !i.isFolder).length,
          totalSizeBytes: items.reduce((acc, i) => acc + i.sizeBytes, 0),
          breadcrumbs: [],
          rootCid: null,
          moviesCid: null,
          tvCid: null,
          animeCid: null,
        };
      },
      createFolder: async () => ({ id: "new_dir", name: "new" }),
      renameItem: async () => {},
      deleteItems: async () => ({ deletedCount: 0 }),
      moveItems: async () => ({ movedCount: 0 }),
      copyItems: async () => ({ copiedCount: 0 }),
    };
  }

  it("recursively traverses nested subdirectories and outputs matching folder structure", async () => {
    // Mimic 115 structure:
    // root_anime:
    //   -> [DIR] 龙珠超：比鲁斯 (2026) {tmdb-312359} (id: dir_dragon_ball)
    // dir_dragon_ball:
    //   -> [DIR] Season 01 (id: dir_season_1)
    // dir_season_1:
    //   -> [FILE] DragonBall_S01E01.mkv (7.4GB)
    //   -> [FILE] DragonBall_S01E01.ass (35KB) -> should be filtered (< 100MB, not video)
    //   -> [FILE] DragonBall_S01E02.mkv (7.4GB)
    //   -> [FILE] DragonBall_S01E03.mkv (7.4GB)
    const structure = {
      root_anime: [
        { id: "dir_dragon_ball", name: "龙珠超：比鲁斯 (2026)", isFolder: true, sizeBytes: 0 },
      ],
      dir_dragon_ball: [
        { id: "dir_season_1", name: "Season 01", isFolder: true, sizeBytes: 0 },
      ],
      dir_season_1: [
        { id: "f1", name: "DragonBall_S01E01.mkv", isFolder: false, sizeBytes: 7421489033 },
        { id: "s1", name: "DragonBall_S01E01.ass", isFolder: false, sizeBytes: 35495 },
        { id: "f2", name: "DragonBall_S01E02.mkv", isFolder: false, sizeBytes: 7436607665 },
        { id: "f3", name: "DragonBall_S01E03.mkv", isFolder: false, sizeBytes: 7387493008 },
      ],
    };

    const mockFileManager = createMockDriveFileManager(structure);
    const scanner = new StrmScanner();
    const task = createMockTask();

    const result = await scanner.runScan({
      task,
      storage: mockFileManager,
      baseUrl: "http://192.168.1.50:3000",
    });

    expect(result.scannedCount).toBe(3);
    expect(result.generatedCount).toBe(3);
    expect(result.protected).toBe(false);

    // Verify hierarchical files created on local disk (with canonical naming: CleanTitle - SxxExx.strm)
    const expectedE01 = path.join(tmpDir, "龙珠超：比鲁斯 (2026)", "Season 01", "龙珠超：比鲁斯 - S01E01.strm");
    const expectedE02 = path.join(tmpDir, "龙珠超：比鲁斯 (2026)", "Season 01", "龙珠超：比鲁斯 - S01E02.strm");
    const expectedE03 = path.join(tmpDir, "龙珠超：比鲁斯 (2026)", "Season 01", "龙珠超：比鲁斯 - S01E03.strm");

    expect(fs.existsSync(expectedE01)).toBe(true);
    expect(fs.existsSync(expectedE02)).toBe(true);
    expect(fs.existsSync(expectedE03)).toBe(true);

    // Verify .strm file content
    const e01Content = fs.readFileSync(expectedE01, "utf8");
    expect(e01Content).toContain("http://192.168.1.50:3000/api/strm/play/task-rec-1/f1?name=DragonBall_S01E01.mkv");
    expect(e01Content).toContain("token=");

    // Second run with incremental_missing should skip existing files
    const secondResult = await scanner.runScan({
      task,
      storage: mockFileManager,
      baseUrl: "http://192.168.1.50:3000",
    });

    expect(secondResult.scannedCount).toBe(3);
    expect(secondResult.generatedCount).toBe(0); // All 3 skipped!
    expect(secondResult.updatedCount).toBe(0);
  });

  it("handles full_sync orphan removal and cleans up empty parent directories", async () => {
    // Initially has 2 episodes
    const seasonDir = path.join(tmpDir, "AnimeShow", "Season 01");
    fs.mkdirSync(seasonDir, { recursive: true });
    fs.writeFileSync(path.join(seasonDir, "Episode_1.strm"), "http://localhost:3000/api/strm/play/cs_115/1\n");
    fs.writeFileSync(path.join(seasonDir, "Episode_Deleted.strm"), "http://localhost:3000/api/strm/play/cs_115/old\n");

    // Remote only has Episode_1 now
    const structure = {
      root_anime: [
        { id: "dir_show", name: "AnimeShow", isFolder: true, sizeBytes: 0 },
      ],
      dir_show: [
        { id: "dir_s1", name: "Season 01", isFolder: true, sizeBytes: 0 },
      ],
      dir_s1: [
        { id: "f1", name: "Episode_1.mkv", isFolder: false, sizeBytes: 500 * 1024 * 1024 },
      ],
    };

    const mockFileManager = createMockDriveFileManager(structure);
    const scanner = new StrmScanner();
    const task = createMockTask({ scanMode: "full_sync" });

    const result = await scanner.runScan({
      task,
      storage: mockFileManager,
      baseUrl: "http://localhost:3000",
    });

    expect(result.removedCount).toBe(1);
    expect(fs.existsSync(path.join(seasonDir, "Episode_1.strm"))).toBe(true);
    expect(fs.existsSync(path.join(seasonDir, "Episode_Deleted.strm"))).toBe(false);
  });
});

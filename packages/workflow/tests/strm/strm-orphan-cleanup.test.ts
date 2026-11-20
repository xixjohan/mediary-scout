import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StrmScanner, type StrmScanProgress } from "../../src/strm/strm-scanner.js";
import type { StrmTask } from "../../src/strm/strm-types.js";
import type { StorageExecutor } from "../../src/domain/ports.js";

/**
 * 孤儿清理的语义与安全闸。
 *
 * 缺陷原型（2026-11-19 生产实测）：清理只挂在 `full_sync` 上，而线上三个任务全是
 * 默认的 `incremental_missing` —— 远端 38 个 / 本地 955 个，最近 12 次扫描的
 * `removed_count` 全是 0（不是没有孤儿，是这条路径从未执行）。
 *
 * 但直接放开就是另一个极端：一次令牌过期或目录改名就能清空整库。所以放开的同时
 * 必须补齐三道闸。**本文件里最重要的两条是「遍历失败必须保留文件」与「空盘必须
 * 拦截」——它们坏掉就是数据丢失。**
 */
describe("STRM 孤儿清理", () => {
  let tmpDir: string;
  let outputDir: string;

  beforeEach(() => {
    tmpDir = path.join(process.cwd(), "data", `strm-orphan-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    outputDir = path.relative(process.cwd(), tmpDir).replace(/\\/g, "/");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function task(overrides: Partial<StrmTask> = {}): StrmTask {
    return {
      id: "task-orphan",
      accountId: "acc-1",
      name: "孤儿清理测试",
      storageId: "storage-1",
      remoteFolderId: "remote-root",
      remotePath: "/movies",
      localOutputDir: outputDir,
      scanIntervalMinutes: 60,
      status: "idle",
      scanMode: "incremental_missing",
      extensions: "mkv",
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
    } as StrmTask;
  }

  function storageListing(files: Array<{ id: string; name: string; sizeBytes?: number }>): StorageExecutor {
    return {
      listVideoFiles: async () =>
        files.map((f) => ({
          id: f.id,
          storageDirectoryId: "remote-root",
          name: f.name,
          sizeBytes: f.sizeBytes ?? 200 * 1024 * 1024,
          episodeCode: null,
          providerFileId: f.id,
        })),
    } as unknown as StorageExecutor;
  }

  function failingStorage(message = "EACCES: permission denied"): StorageExecutor {
    return {
      listVideoFiles: async () => {
        throw new Error(message);
      },
    } as unknown as StorageExecutor;
  }

  /** 预置本地孤儿（远端已经没有这条）。 */
  function seedLocalStrm(fileName: string): string {
    const full = path.join(tmpDir, fileName);
    fs.writeFileSync(full, "http://stale/api/strm/play/x/y", "utf8");
    return full;
  }

  function localStrmFiles(): string[] {
    return fs.existsSync(tmpDir)
      ? fs.readdirSync(tmpDir).filter((name) => name.toLowerCase().endsWith(".strm"))
      : [];
  }

  const validRemote = [
    { id: "f1", name: "Keep.Me.2024.1080p.mkv" },
    // 远端有 10 个文件、本地只有 2 个 → 删除比例 0%，不触发上限
    ...Array.from({ length: 9 }, (_, index) => ({ id: `k${index}`, name: `Keep.${index}.2024.1080p.mkv` })),
  ];

  it("incremental_missing 也会清理孤儿（默认模式不再「只增不删」）", async () => {
    const orphan = seedLocalStrm("Gone.Movie.strm");
    const result = await new StrmScanner().runScan({
      task: task({ scanMode: "incremental_missing" }),
      storage: storageListing(validRemote),
      baseUrl: "http://127.0.0.1:3000",
    });

    expect(result.removedCount).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
    // 平台路径分隔符不同（Windows 反斜杠），按归一化后的形式比较
    expect(result.removedPaths.map((p) => p.replace(/\\/g, "/"))).toContain(
      orphan.replace(/\\/g, "/"),
    );
  });

  it("incremental_update 同样清理孤儿", async () => {
    const orphan = seedLocalStrm("Gone.Movie.strm");
    const result = await new StrmScanner().runScan({
      task: task({ scanMode: "incremental_update" }),
      storage: storageListing(validRemote),
      baseUrl: "http://127.0.0.1:3000",
    });

    expect(result.removedCount).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("full_sync 行为不回归", async () => {
    const orphan = seedLocalStrm("Gone.Movie.strm");
    const result = await new StrmScanner().runScan({
      task: task({ scanMode: "full_sync" }),
      storage: storageListing(validRemote),
      baseUrl: "http://127.0.0.1:3000",
    });

    expect(result.removedCount).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("**远端遍历失败 → 一个文件都不删**（把「没看到」当成「已删除」是数据丢失）", async () => {
    seedLocalStrm("Gone.A.strm");
    seedLocalStrm("Gone.B.strm");
    const before = localStrmFiles().sort();

    const result = await new StrmScanner().runScan({
      task: task({ scanMode: "incremental_missing" }),
      storage: failingStorage(),
      baseUrl: "http://127.0.0.1:3000",
    });

    expect(result.removedCount).toBe(0);
    expect(result.traversalError).toContain("EACCES");
    expect(localStrmFiles().sort()).toEqual(before);
    expect(result.cleanupSkippedReason).toContain("遍历失败");
  });

  it("**远端返回 0 个 → 空盘保护拦截，不删任何文件**", async () => {
    seedLocalStrm("Gone.A.strm");
    seedLocalStrm("Gone.B.strm");
    const before = localStrmFiles().sort();

    const result = await new StrmScanner().runScan({
      task: task({ scanMode: "incremental_missing" }),
      storage: storageListing([]),
      baseUrl: "http://127.0.0.1:3000",
    });

    expect(result.protected).toBe(true);
    expect(result.removedCount).toBe(0);
    expect(localStrmFiles().sort()).toEqual(before);
    expect(result.protectReason).toContain("空盘保护");
  });

  it("远端空 + 显式强制 → 允许清空（用户已确认）", async () => {
    seedLocalStrm("Gone.A.strm");
    seedLocalStrm("Gone.B.strm");

    const result = await new StrmScanner().runScan({
      task: task({ scanMode: "incremental_missing" }),
      storage: storageListing([]),
      baseUrl: "http://127.0.0.1:3000",
      forceAllowEmptyCleanup: true,
    });

    expect(result.protected).toBe(false);
    expect(result.removedCount).toBe(2);
    expect(localStrmFiles()).toEqual([]);
  });

  it("大幅删除照常执行（远端真的没了就该删），但留下审计说明", async () => {
    // 本地 4 个、远端 1 个 → 删 3/4 = 75%。
    // ⚠️ 这里刻意**不设删除比例上限**：生产实测「远端 38 / 本地 955」（96%）
    // 正是本缺陷要修的场景，用 50% 阈值挡掉等于修了个寂寞。
    // 真正的两道硬闸是「遍历失败不删」与「空盘不删」。
    seedLocalStrm("Gone.A.strm");
    seedLocalStrm("Gone.B.strm");
    seedLocalStrm("Gone.C.strm");
    seedLocalStrm("Keep.Me.2024.1080p.strm");

    const result = await new StrmScanner().runScan({
      task: task({ scanMode: "incremental_missing" }),
      storage: storageListing([{ id: "f1", name: "Keep.Me.2024.1080p.mkv" }]),
      baseUrl: "http://127.0.0.1:3000",
    });

    expect(result.removedCount).toBe(3);
    expect(result.cleanupSkippedReason).toContain("大幅变动");
    expect(localStrmFiles()).toEqual(["Keep.Me.2024.1080p.strm"]);
  });

  it("本地没有文件时不报错、不清理", async () => {
    const result = await new StrmScanner().runScan({
      task: task({ scanMode: "incremental_missing" }),
      storage: storageListing(validRemote),
      baseUrl: "http://127.0.0.1:3000",
    });

    expect(result.removedCount).toBe(0);
    expect(result.generatedCount).toBe(10);
    expect(result.cleanupSkippedReason).toBeUndefined();
  });

  it("清理进度消息给出可读说明（0 个必须可解释）", async () => {
    seedLocalStrm("Gone.A.strm");
    seedLocalStrm("Gone.B.strm");
    seedLocalStrm("Gone.C.strm");
    seedLocalStrm("Keep.Me.2024.1080p.strm");
    const reports: StrmScanProgress[] = [];

    await new StrmScanner().runScan({
      task: task({ scanMode: "incremental_missing" }),
      storage: storageListing([{ id: "f1", name: "Keep.Me.2024.1080p.mkv" }]),
      baseUrl: "http://127.0.0.1:3000",
      onProgress: (p) => {
        reports.push({ ...p });
      },
    });

    const cleaning = reports.find((p) => p.phase === "cleaning_orphans");
    expect(cleaning?.message).toContain("大幅变动");
  });
});

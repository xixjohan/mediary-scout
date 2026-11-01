import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StorageExecutor } from "../domain/ports.js";
import type { VerifiedFile } from "../domain/domain.js";
import { StrmScanner } from "./strm-scanner.js";
import type { StrmTask } from "./strm-types.js";

describe("strm-scanner", () => {
  const dirs: string[] = [];
  const makeTempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strm-scanner-test-"));
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

  const makeMockStorage = (files: VerifiedFile[]): StorageExecutor => ({
    listVideoFiles: async () => files,
    listUnparsedVideoFiles: async () => [],
    renameFile: async () => {},
    transfer: async () => { throw new Error("not implemented"); },
    flattenDirectory: async () => ({ moved: [], removed: [] }),
    deleteFiles: async () => ({ deleted: [] }),
    removeDirectory: async () => ({ removed: true }),
    listTree: async () => [],
    listSubdirectories: async () => [],
    listChildDirectories: async () => [],
    createDirectory: async () => "dir_1",
    moveFiles: async () => ({ moved: [] }),
  });

  const baseTask = (outputDir: string, mode: StrmTask["scanMode"] = "incremental_missing"): StrmTask => ({
    id: "task_1",
    accountId: "acct_1",
    name: "Test Scan",
    storageId: "cs_115",
    remoteFolderId: "remote_root",
    remotePath: "/Media/Movies",
    localOutputDir: outputDir,
    scanIntervalMinutes: 360,
    scanMode: mode,
    extensions: "mp4;mkv",
    minFileSizeMb: 10,
    excludeKeywords: "sample",
    scheduleMode: "interval",
    status: "idle",
    lastScanAt: null,
    lastScanStatus: null,
    lastErrorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it("filters out disallowed extensions, small files and excluded keywords", async () => {
    const outDir = makeTempDir();
    const remoteFiles: VerifiedFile[] = [
      { id: "f1", name: "Movie.1080p.mp4", sizeBytes: 100 * 1024 * 1024, storageDirectoryId: "r1", episodeCode: null, providerFileId: "f1" },
      { id: "f2", name: "Sample.mp4", sizeBytes: 20 * 1024 * 1024, storageDirectoryId: "r1", episodeCode: null, providerFileId: "f2" }, // excluded
      { id: "f3", name: "Tiny.mkv", sizeBytes: 1024, storageDirectoryId: "r1", episodeCode: null, providerFileId: "f3" }, // < 10MB
      { id: "f4", name: "Text.txt", sizeBytes: 50 * 1024 * 1024, storageDirectoryId: "r1", episodeCode: null, providerFileId: "f4" }, // not video
    ];

    const scanner = new StrmScanner();
    const result = await scanner.runScan({
      task: baseTask(outDir, "incremental_missing"),
      storage: makeMockStorage(remoteFiles),
      baseUrl: "http://localhost:3000",
    });

    expect(result.scannedCount).toBe(1);
    expect(result.generatedCount).toBe(1);
    expect(fs.existsSync(path.join(outDir, "Movie.1080p.strm"))).toBe(true);
  });

  it("triggers empty cloud protection guard when remote has 0 files but local has files", async () => {
    const outDir = makeTempDir();
    // Create an existing local strm file
    fs.writeFileSync(path.join(outDir, "ExistingMovie.strm"), "http://localhost:3000/api/strm/play/1\n");

    const scanner = new StrmScanner();
    const result = await scanner.runScan({
      task: baseTask(outDir, "full_sync"),
      storage: makeMockStorage([]), // Remote empty
      baseUrl: "http://localhost:3000",
    });

    expect(result.protected).toBe(true);
    expect(result.removedCount).toBe(0);
    expect(fs.existsSync(path.join(outDir, "ExistingMovie.strm"))).toBe(true); // NOT deleted!
  });

  it("cleans up orphans in full_sync mode when remote is not empty", async () => {
    const outDir = makeTempDir();
    fs.writeFileSync(path.join(outDir, "OldDeletedMovie.strm"), "http://localhost:3000/api/old\n");

    const remoteFiles: VerifiedFile[] = [
      { id: "f1", name: "ActiveMovie.mkv", sizeBytes: 50 * 1024 * 1024, storageDirectoryId: "r1", episodeCode: null, providerFileId: "f1" },
    ];

    const scanner = new StrmScanner();
    const result = await scanner.runScan({
      task: baseTask(outDir, "full_sync"),
      storage: makeMockStorage(remoteFiles),
      baseUrl: "http://localhost:3000",
    });

    expect(result.generatedCount).toBe(1);
    expect(result.removedCount).toBe(1);
    expect(fs.existsSync(path.join(outDir, "OldDeletedMovie.strm"))).toBe(false); // Deleted
    expect(fs.existsSync(path.join(outDir, "ActiveMovie.strm"))).toBe(true);
  });
});

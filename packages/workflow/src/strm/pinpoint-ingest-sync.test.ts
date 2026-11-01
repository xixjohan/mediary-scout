import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowRepository } from "../persistence/repository.js";
import { syncPinpointIngestedFiles } from "./pinpoint-ingest-sync.js";

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

    await repo.createStrmTask({
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
      "http://192.168.1.100:3000/api/strm/play/cs_115/file_101?name=Oppenheimer.2023.2160p.mkv",
    );

    expect(mockCoordinator.notifyFilesChanged).toHaveBeenCalledWith("acct_1", [
      generatedPath,
    ]);
  });
});

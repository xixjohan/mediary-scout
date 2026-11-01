import { describe, expect, it, vi } from "vitest";
import { MediaServerCoordinator } from "../../src/mediaserver/coordinator.js";
import { InMemoryWorkflowRepository } from "../../src/persistence/repository.js";
import { syncPinpointIngestedFiles } from "../../src/strm/pinpoint-ingest-sync.js";
import type { MediaServerConfig } from "../../src/mediaserver/mediaserver-types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("MediaServerCoordinator & Execution Tracking", () => {
  it("should record refresh record on manualRefresh", async () => {
    const repo = new InMemoryWorkflowRepository();
    const config = await repo.createMediaServerConfig({
      id: "ms-config-1",
      accountId: "acc-1",
      name: "My Plex",
      serverType: "plex",
      hostUrl: "http://plex.local:32400",
      apiToken: "plex-token-xyz",
      pathMappings: [{ id: "pm-1", localPath: "/mnt/strm", remotePath: "/data" }],
      isActive: true,
    });

    // Mock fetch for PlexAdapter
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          MediaContainer: {
            Directory: [
              {
                key: "1",
                title: "Movies",
                type: "movie",
                Location: [{ path: "/data" }],
              },
            ],
          },
        }),
        text: async () => "",
      };
    });

    const coordinator = new MediaServerCoordinator({
      store: repo,
      fetchFn: mockFetch as any,
    });

    const result = await coordinator.manualRefresh("ms-config-1", "acc-1", "/mnt/strm/movies");
    expect(result.ok).toBe(true);

    // Check refresh record
    const records = await repo.listMediaServerRefreshRecords("ms-config-1", "acc-1");
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("succeeded");
    expect(records[0]?.triggerSource).toBe("manual");
    expect(records[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should debounce notifications and record refresh record on flush", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.createMediaServerConfig({
      id: "ms-config-2",
      accountId: "acc-1",
      name: "My Emby",
      serverType: "emby",
      hostUrl: "http://emby.local:8096",
      apiToken: "emby-token-xyz",
      pathMappings: [],
      isActive: true,
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => "",
    });

    const coordinator = new MediaServerCoordinator({
      store: repo,
      debounceMs: 50,
      maxWaitMs: 150,
      fetchFn: mockFetch as any,
    });

    coordinator.notifyFilesChanged("acc-1", ["/strm/movie1.strm", "/strm/movie2.strm"]);

    // Wait for debounce queue to flush
    await new Promise((resolve) => setTimeout(resolve, 100));

    const records = await repo.listMediaServerRefreshRecords("ms-config-2", "acc-1");
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("succeeded");
    expect(records[0]?.triggerSource).toBe("debounced_queue");

    coordinator.dispose();
  });

  it("should link pinpoint ingest with strm execution records and mediaserver notify", async () => {
    const repo = new InMemoryWorkflowRepository();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinpoint-test-"));

    try {
      await repo.createStrmTask({
        accountId: "acc-1",
        name: "Auto STRM",
        storageId: "storage-115",
        remoteFolderId: "root",
        remotePath: "/",
        localOutputDir: tmpDir,
        scanMode: "incremental_missing",
        extensions: "mkv;mp4",
        minFileSizeMb: 1,
        isActive: true,
      });

      const notifyMock = vi.fn();
      const mockCoordinator = {
        notifyFilesChanged: notifyMock,
      } as unknown as MediaServerCoordinator;

      const result = await syncPinpointIngestedFiles({
        accountId: "acc-1",
        storageId: "storage-115",
        files: [
          {
            id: "file-101",
            name: "Dune.Part.Two.2024.mkv",
            sizeBytes: 10 * 1024 * 1024 * 1024,
          },
        ],
        repository: repo,
        baseUrl: "http://127.0.0.1:3000",
        mediaServerCoordinator: mockCoordinator,
      });

      expect(result.generatedPaths).toHaveLength(1);
      expect(result.refreshed).toBe(true);
      expect(notifyMock).toHaveBeenCalledTimes(1);

      // Verify execution record created
      const tasks = await repo.listStrmTasks("acc-1");
      const records = await repo.listStrmExecutionRecords(tasks[0]?.id ?? "", "acc-1");
      expect(records).toHaveLength(1);
      expect(records[0]?.triggerSource).toBe("pinpoint_ingest");
      expect(records[0]?.status).toBe("succeeded");
      expect(records[0]?.scannedCount).toBe(1);
      expect(records[0]?.generatedCount).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

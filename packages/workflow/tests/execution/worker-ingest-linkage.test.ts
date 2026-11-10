import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  FakeResourceProvider,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  queueMovieAcquisition,
  runQueuedMovieAcquisition,
  type MediaTitle,
  type MediaServerCoordinator,
} from "../../src/index.js";

const fixedNow = () => "2026-11-01T00:00:00.000Z";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function inspectAndMarkModel() {
  const steps = [
    { tool: "inspectTargetDir", input: {} },
    { tool: "markObtained", input: { codes: ["MOVIE"] } },
    { tool: "finish", input: {} },
  ];
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      if (i < steps.length) {
        const s = steps[i]!;
        i += 1;
        return {
          content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: s.tool, input: JSON.stringify(s.input) }],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
          usage: USAGE,
          warnings: [],
        };
      }
      return { content: [{ type: "text" as const, text: "已在库" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
    },
  });
}

function testMovieTitle(): MediaTitle {
  return {
    id: "movie_dune2",
    title: "沙丘2",
    originalTitle: "Dune: Part Two",
    aliases: ["沙丘 2", "Dune 2"],
    year: 2024,
    type: "movie",
    tmdbId: 693134,
    posterPath: "/dune2.jpg",
    overview: "保罗·厄崔迪与契妮联手...",
  };
}

describe("Worker Post-Ingest Linkage with STRM & MediaServer", () => {
  let tmpOutputDir: string;

  beforeEach(() => {
    tmpOutputDir = path.join(process.cwd(), "data", `post-ingest-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(tmpOutputDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpOutputDir, { recursive: true, force: true });
    } catch {}
  });

  it("triggers pinpoint STRM generation and media server notification on successful acquisition", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title = testMovieTitle();
    const accountId = "acc-worker-test";
    const storageId = "pan115-drive-1";

    // 1. Configure an active STRM task for this drive
    const strmTask = await repository.createStrmTask({
      accountId,
      name: "电影STRM同步",
      storageId,
      remoteFolderId: "movies_root",
      remotePath: "/movies",
      localOutputDir: path.relative(process.cwd(), tmpOutputDir).replace(/\\/g, "/"),
      scanMode: "incremental_missing",
      extensions: "mkv;mp4",
      minFileSizeMb: 1,
      isActive: true,
    });

    // 2. Queue movie acquisition bound to this account and drive
    await queueMovieAcquisition({
      title,
      keyword: "沙丘2 4K",
      repository,
      accountId,
      connectedStorageId: storageId,
      createWorkflowRunId: () => "run_dune2",
      now: fixedNow,
    });

    const storage = new FakeStorageExecutor();
    // Seed directory with the landed movie
    const movieDir = await storage.createDirectory({
      name: `${title.title} (${title.year}) {tmdb-${title.tmdbId}}`,
      parentId: "movies_root",
    });
    storage.seedDirectoryFiles(movieDir, [
      {
        id: "dune2_fid",
        storageDirectoryId: movieDir,
        name: "Dune.Part.Two.2024.2160p.mkv",
        sizeBytes: 15_000_000_000,
        episodeCode: null,
        providerFileId: "dune2_fid",
      },
    ]);

    const notifyMock = vi.fn();
    const mockCoordinator = {
      notifyFilesChanged: notifyMock,
    } as unknown as MediaServerCoordinator;

    // 3. Execute worker
    const result = await runQueuedMovieAcquisition({
      repository,
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage,
      model: inspectAndMarkModel(),
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
      resolveAccountContext: async () => ({
        storage,
        resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
        model: inspectAndMarkModel(),
        baseUrl: "http://127.0.0.1:3000",
        mediaServerCoordinator: mockCoordinator,
      }),
    });

    expect(result.status).toBe("ran");
    if (result.status !== "ran") throw new Error("Expected status ran");
    expect(result.workflowStatus).toBe("succeeded");

    // 4. Verify STRM file is generated in the output directory
    const outputFiles = fs.readdirSync(tmpOutputDir, { recursive: true }).map(String);
    expect(outputFiles.length).toBeGreaterThan(0);
    expect(outputFiles.some((f) => f.endsWith(".strm"))).toBe(true);

    // 5. Verify STRM execution record is created
    const execRecords = await repository.listStrmExecutionRecords(strmTask.id, accountId);
    expect(execRecords).toHaveLength(1);
    expect(execRecords[0]?.triggerSource).toBe("pinpoint_ingest");
    expect(execRecords[0]?.status).toBe("succeeded");
    expect(execRecords[0]?.generatedCount).toBe(1);

    // 6. Verify Media Server Coordinator was notified
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      accountId,
      expect.arrayContaining([expect.stringContaining(".strm")]),
    );
  });
});

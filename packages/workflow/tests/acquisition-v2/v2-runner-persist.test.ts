import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  runMovieAcquisitionV2AndPersist,
  runSeriesInitializationV2AndPersist,
  runType2InitializationV2AndPersist,
  runType3MonitoringV2AndPersist,
} from "../../src/execution/runner-v2.js";
import { FakeStorageExecutor } from "../../src/domain/fakes.js";
import { InMemoryWorkflowRepository } from "../../src/persistence/repository.js";
import { createEpisodeStates, type MediaTitle, type ResourceSnapshot, type TrackedSeason } from "../../src/domain.js";
import type { ResourceProvider } from "../../src/domain/ports.js";
import { handleWorkflowRunFailure } from "../../src/execution/workflow-failure-handler.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function emptyProvider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: "snap_empty",
      provider: "pansou",
      keyword,
      candidates: [],
      createdAt: "2026-06-15T00:00:00.000Z",
    }),
  };
}

function searchThenReportModel() {
  let i = 0;
  const tool = (name: string, input: unknown) => ({
    content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
    usage: USAGE,
    warnings: [],
  });
  return new MockLanguageModelV3({
    doGenerate: async () => {
      i += 1;
      if (i === 1) return tool("searchResources", { keyword: "show" });
      if (i === 2) return tool("reportNoCoverage", { reason: "no candidates" });
      return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
    },
  });
}

const tvTitle = {
  id: "tmdb_tv_100",
  tmdbId: 100,
  type: "tv",
  title: "示例剧",
  year: 2024,
  aliases: ["Example Show"],
} as unknown as MediaTitle;

const movieTitle = {
  id: "tmdb_movie_27205",
  tmdbId: 27205,
  type: "movie",
  title: "盗梦空间",
  year: 2010,
  aliases: ["Inception"],
} as unknown as MediaTitle;

function trackedSeason(): TrackedSeason {
  return {
    id: "tmdb_tv_100_s1",
    mediaTitleId: "tmdb_tv_100",
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "",
    totalEpisodes: 3,
    latestAiredEpisode: 3,
    latestAiredSource: "metadata",
  };
}

const workflowRun = { id: "run-x", startedAt: "2026-06-15T00:00:00.000Z", finishedAt: "2026-06-15T00:01:00.000Z" };

async function reserveQueuedRun(
  repository: InMemoryWorkflowRepository,
  title: MediaTitle,
  season: TrackedSeason,
  kind: "type1_package_init" | "type2_init" | "type3_monitor" | "movie_init",
  episodes = createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: season.seasonNumber,
    totalEpisodes: season.totalEpisodes,
    latestAiredEpisode: season.latestAiredEpisode,
  }),
) {
  const reserved = await repository.reserveWorkflowRun({
    title,
    season,
    workflowRun: {
      ...workflowRun,
      id: workflowRun.id,
      kind,
      status: "queued",
      trackedSeasonId: season.id,
      finishedAt: null,
      auditEvents: [],
    },
    episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    ...(kind === "type3_monitor" ? { keepCurrentEpisodes: true, requireTrackedSeason: true } : {}),
  });
  if (reserved.status !== "reserved") throw new Error(`expected reservation; got ${reserved.status}`);
}

describe("runner-v2 persist wrappers — V2 engine results persisted in the existing record shapes", () => {
  it("keeps a newly moved episode when the model fails before markObtained or finish", async () => {
    const repository = new InMemoryWorkflowRepository();
    const season = trackedSeason();
    await reserveQueuedRun(repository, tvTitle, season, "type2_init");
    const claimed = (await repository.getWorkflowRunSnapshot(workflowRun.id))!;
    const file = { id: "new_1", providerFileId: "new_1", storageDirectoryId: "unused", name: "示例剧 - S01E01.mp4", sizeBytes: 1000, episodeCode: "S01E01" };
    const storage = new FakeStorageExecutor({ transferOutcomes: { new_candidate: { status: "succeeded", providerMessage: "ok", files: [file] } } });
    const provider: ResourceProvider = { search: async ({ keyword }) => ({ id: "snap_new", provider: "fake", keyword,
      createdAt: workflowRun.startedAt, candidates: [{ id: "new_candidate", snapshotId: "snap_new", index: 0,
        title: "示例剧 S01E01", type: "115", source: "fake", providerPayload: { url: "https://115.com/s/testfixture" } }],
    }) };
    let step = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => {
      step++;
      if (step > 2) throw new Error("model failed after move");
      const toolName = step === 1 ? "transferCandidate" : "moveToSeason";
      const input = step === 1 ? { snapshotId: "s1", candidateId: "s1-1" } : { moves: [{ season: 1, fileIds: ["new_1"] }] };
      return { content: [{ type: "tool-call" as const, toolCallId: `move_${step}`, toolName, input: JSON.stringify(input) }],
        finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const }, usage: USAGE, warnings: [] };
    } });
    await expect(runType2InitializationV2AndPersist({ title: tvTitle, season, categoryParentId: "tv_root", resourceProvider: provider,
      storage, model, repository, workflowRun })).rejects.toThrow("model failed after move");
    await handleWorkflowRunFailure({ repository, claimed, error: new Error("model failed after move"), now: () => "2026-11-14T00:00:00Z" });
    const episodes = await repository.listEpisodeStates(season.id);
    expect(episodes.find((ep) => ep.episodeCode === "S01E01")).toMatchObject({ obtained: true, verifiedFileIds: ["new_1"] });
    expect(episodes.filter((ep) => ep.obtained)).toHaveLength(1);
    expect((await repository.getWorkflowRunSnapshot(workflowRun.id))?.workflowRun.status).toBe("failed");
  });

  it("checkpoints 198 existing files before a later model failure (only E197 remains missing)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const season = { ...trackedSeason(), totalEpisodes: 210, latestAiredEpisode: 199 };
    await reserveQueuedRun(repository, tvTitle, season, "type2_init");
    const storage = new FakeStorageExecutor();
    const showId = await storage.createDirectory({ parentId: "tv_root", name: "示例剧 (2024) {tmdb-100}" });
    const dirId = await storage.createDirectory({ parentId: showId, name: "Season 01" });
    storage.seedDirectoryFiles(dirId, Array.from({ length: 199 }, (_, i) => i + 1).filter((n) => n !== 197).map((n) => ({
      id: `file_${n}`, providerFileId: `file_${n}`, storageDirectoryId: dirId,
      name: `示例剧 - S01E${String(n).padStart(2, "0")}.mp4`, sizeBytes: 1000,
      episodeCode: `S01E${String(n).padStart(2, "0")}`,
    })));
    storage.seedDirectoryFiles(dirId, [
      { id: "empty_197", providerFileId: "empty_197", storageDirectoryId: dirId, name: "示例剧 - S01E197.mp4", sizeBytes: 0, episodeCode: "S01E197" },
      { id: "other_season", providerFileId: "other_season", storageDirectoryId: dirId, name: "示例剧 - S02E01.mp4", sizeBytes: 1000, episodeCode: "S02E01" },
    ]);
    await expect(runType2InitializationV2AndPersist({
      title: tvTitle, season, categoryParentId: "tv_root", resourceProvider: emptyProvider(), storage,
      model: new MockLanguageModelV3({ doGenerate: async () => { throw new Error("model unavailable"); } }),
      repository, workflowRun,
    })).rejects.toThrow("model unavailable");
    const episodes = await repository.listEpisodeStates(season.id);
    expect(episodes.filter((ep) => ep.obtained)).toHaveLength(198);
    expect(episodes.filter((ep) => ep.airStatus === "aired" && !ep.obtained).map((ep) => ep.episodeCode)).toEqual(["S01E197"]);
    expect(episodes.find((ep) => ep.episodeCode === "S01E198")?.verifiedFileIds).toEqual(["file_198"]);
    expect((await repository.listTrackedSeasonStates())[0]?.season.storageDirectoryId).toBe(dirId);
  });

  it("type2 init: persists one type2_init snapshot with the tracked season and episodes", async () => {
    const repository = new InMemoryWorkflowRepository();
    await reserveQueuedRun(repository, tvTitle, trackedSeason(), "type2_init");
    const result = await runType2InitializationV2AndPersist({
      title: tvTitle,
      season: trackedSeason(),
      categoryParentId: "tv_root",
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: searchThenReportModel(),
      repository,
      workflowRun,
    });

    expect(result.status).toBe("no_coverage");
    const snapshot = await repository.getWorkflowRunSnapshot("run-x");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.workflowRun.kind).toBe("type2_init");
    expect(snapshot!.workflowRun.trackedSeasonId).toBe("tmdb_tv_100_s1");
    expect(snapshot!.episodes).toHaveLength(3);
    const tracked = await repository.listTrackedSeasonStates();
    expect(tracked.map((state) => state.season.id)).toContain("tmdb_tv_100_s1");
  });

  it("type3 patrol: persists a type3_monitor snapshot, scheduled-trigger notification", async () => {
    const repository = new InMemoryWorkflowRepository();
    const season = trackedSeason();
    const episodes = createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 3, latestAiredEpisode: 3 });
    await repository.saveWorkflowRunSnapshot({
      title: tvTitle,
      season,
      episodes,
      workflowRun: {
        id: "seed_type3",
        kind: "type2_init",
        status: "succeeded",
        trackedSeasonId: season.id,
        startedAt: workflowRun.startedAt,
        finishedAt: workflowRun.finishedAt,
        auditEvents: [],
      },
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    await reserveQueuedRun(repository, tvTitle, season, "type3_monitor", episodes);
    await runType3MonitoringV2AndPersist({
      title: tvTitle,
      season,
      episodes,
      categoryParentId: "tv_root",
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: searchThenReportModel(),
      repository,
      workflowRun,
    });

    const snapshot = await repository.getWorkflowRunSnapshot("run-x");
    expect(snapshot!.workflowRun.kind).toBe("type3_monitor");
    const notifications = await repository.listNotifications();
    expect(notifications.some((notification) => notification.trigger === "scheduled")).toBe(true);
  });

  it("series init: persists one type1_package_init record per season under _s{n} ids", async () => {
    const repository = new InMemoryWorkflowRepository();
    await reserveQueuedRun(repository, tvTitle, trackedSeason(), "type1_package_init");
    await runSeriesInitializationV2AndPersist({
      title: tvTitle,
      seasons: [
        { seasonNumber: 1, totalEpisodes: 3, latestAiredEpisode: 3 },
        { seasonNumber: 2, totalEpisodes: 3, latestAiredEpisode: 3 },
      ],
      categoryParentId: "tv_root",
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: searchThenReportModel(),
      repository,
      workflowRun,
      seasonQualityRecord: "4K",
    });

    const s1 = await repository.getWorkflowRunSnapshot("run-x_s1");
    const s2 = await repository.getWorkflowRunSnapshot("run-x_s2");
    expect(s1!.workflowRun.kind).toBe("type1_package_init");
    expect(s2!.workflowRun.kind).toBe("type1_package_init");
    // Resource evidence rides on the first season only.
    expect(s2!.resourceSnapshots).toEqual([]);
    const tracked = await repository.listTrackedSeasonStates();
    expect(tracked.map((state) => state.season.id).sort()).toEqual(["tmdb_tv_100_s1", "tmdb_tv_100_s2"]);
  });

  it("movie init: persists a movie_init snapshot via the V2 movie engine", async () => {
    const repository = new InMemoryWorkflowRepository();
    await reserveQueuedRun(repository, movieTitle, {
      id: "tmdb_movie_27205_movie",
      mediaTitleId: movieTitle.id,
      seasonNumber: 1,
      status: "completed",
      qualityPreference: "4K",
      storageDirectoryId: "",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "manual",
    }, "movie_init");
    const result = await runMovieAcquisitionV2AndPersist({
      title: movieTitle,
      categoryParentId: "movies_root",
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: searchThenReportModel(),
      repository,
      workflowRun,
    });

    expect(result.status).toBe("no_coverage");
    const snapshot = await repository.getWorkflowRunSnapshot("run-x");
    expect(snapshot!.workflowRun.kind).toBe("movie_init");
  });
});

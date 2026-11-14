import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createEpisodeStates, type WorkflowKind } from "../../src/domain.js";
import { InMemoryWorkflowRepository, mergeSeasonPreservingCurrent, type PersistWorkflowRunSnapshotInput } from "../../src/persistence/repository.js";
import { SqliteWorkflowRepository } from "../../src/persistence/sqlite.js";
import { handleWorkflowRunFailure } from "../../src/execution/workflow-failure-handler.js";
import { inventoryCheckpoint } from "../../src/execution/inventory-checkpoint.js";

const scope = { accountId: "acct_default", connectedStorageId: "test_drive" };
const now = () => "2026-11-14T06:00:00.000Z";

it("reopens a previously completed season when fresh metadata introduces a real gap", () => {
  const current = { ...snapshot("type2_init").season, status: "completed" as const, totalEpisodes: 1, latestAiredEpisode: 1 };
  const incoming = { ...current, status: "active" as const, totalEpisodes: 2, latestAiredEpisode: 2 };
  const episodes = createEpisodeStates({ trackedSeasonId: current.id, seasonNumber: 1, totalEpisodes: 2, latestAiredEpisode: 2 });
  episodes[0]!.obtained = true;
  expect(mergeSeasonPreservingCurrent(current, incoming, episodes)).toMatchObject({ status: "active", totalEpisodes: 2, latestAiredEpisode: 2 });
});

function snapshot(kind: WorkflowKind): PersistWorkflowRunSnapshotInput {
  const season = { id: "tmdb_tv_106449_s1", mediaTitleId: "tmdb_tv_106449", seasonNumber: 1,
    status: "active" as const, qualityPreference: "1080p", storageDirectoryId: "season_1",
    totalEpisodes: 210, latestAiredEpisode: 199, latestAiredSource: "metadata" as const };
  return { ...scope,
    title: { id: season.mediaTitleId, tmdbId: 106449, type: "anime", title: "测试动画", originalTitle: "Test Anime", year: 2020, aliases: [] },
    season, workflowRun: { id: "acquire_test", kind, status: "running", trackedSeasonId: season.id,
      startedAt: now(), finishedAt: null, auditEvents: [] },
    episodes: createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 210, latestAiredEpisode: 199 }),
    resourceSnapshots: [], decisions: [], transferAttempts: [], notifications: [],
  };
}

describe.each([
  ["memory", () => new InMemoryWorkflowRepository()],
  ["sqlite", () => new SqliteWorkflowRepository(new Database(":memory:"))],
] as const)("acquisition failure preserves current inventory (%s)", (_name, makeRepo) => {
  it("checkpoints file associations idempotently on one drive and repairs only its binding", async () => {
    const repository = makeRepo();
    const input = snapshot("type2_init");
    input.workflowRun.status = "succeeded";
    await repository.saveWorkflowRunSnapshot(input);
    await repository.saveWorkflowRunSnapshot({ ...input, connectedStorageId: "other_drive", workflowRun: { ...input.workflowRun, id: "other_run" } });
    const files = Array.from({ length: 199 }, (_, i) => i + 1).filter((n) => n !== 197).map((n) => ({
      id: `verified_${n}`, providerFileId: `verified_${n}`, storageDirectoryId: "actual_season",
      name: `测试动画 - S01E${String(n).padStart(2, "0")}.mp4`, sizeBytes: 1000,
      episodeCode: `S01E${String(n).padStart(2, "0")}`,
    }));
    const checkpoint = inventoryCheckpoint({ ...scope, repository, title: input.title, workflowRun: input.workflowRun, now });
    await checkpoint({ seasonNumber: 1, directoryId: "actual_season", files });
    await checkpoint({ seasonNumber: 1, directoryId: "actual_season", files });
    const [state] = await repository.listTrackedSeasonStates(scope);
    expect(state?.episodes.filter((ep) => ep.obtained)).toHaveLength(198);
    expect(state?.episodes.find((ep) => ep.episodeCode === "S01E198")?.verifiedFileIds).toEqual(["verified_198"]);
    expect(state?.season.storageDirectoryId).toBe("actual_season");
    expect(state?.season.totalEpisodes).toBe(210);
    expect((await repository.listEpisodeStates(input.season.id, { ...scope, connectedStorageId: "other_drive" })).some((ep) => ep.obtained)).toBe(false);
    await repository.untrackTitle(input.title.tmdbId, scope, "tv");
    await checkpoint({ seasonNumber: 1, directoryId: "actual_season", files });
    expect(await repository.listTrackedSeasonStates(scope)).toEqual([]);
  });

  for (const kind of ["type2_init", "type1_package_init", "type3_monitor"] as const) {
    it.each(["terminal", "retry_exhausted", "retry"] as const)(`${kind}: %s keeps 198 obtained episodes even with a stale claimed snapshot`, async (failure) => {
      const repository = makeRepo();
      const input = snapshot(kind);
      if (failure === "retry_exhausted") input.workflowRun.autoRequeueCount = 3;
      await repository.saveWorkflowRunSnapshot(input);
      const claimed = (await repository.getWorkflowRunSnapshot(input.workflowRun.id, scope))!;
      // Another writer discovers existing files after this run was claimed.
      const current = { ...input, episodes: input.episodes.map((episode) => ({ ...episode,
        obtained: Number(episode.episodeCode.slice(4)) <= 199 && episode.episodeCode !== "S01E197",
        verifiedFileIds: episode.episodeCode === "S01E197" ? [] : [`file_${episode.episodeCode}`],
      })) };
      await repository.saveWorkflowRunSnapshot(current);
      await handleWorkflowRunFailure({ repository, claimed, now,
        error: new Error(failure === "terminal" ? "PAN115_RATE_LIMIT: operation budget exhausted" : "fetch failed"),
      });
      const episodes = await repository.listEpisodeStates(input.season.id, scope);
      expect(episodes).toHaveLength(210);
      expect(episodes.filter((episode) => episode.obtained)).toHaveLength(198);
      expect(episodes.filter((episode) => episode.airStatus === "aired" && !episode.obtained).map((episode) => episode.episodeCode)).toEqual(["S01E197"]);
      expect(episodes.find((episode) => episode.episodeCode === "S01E198")?.verifiedFileIds).toEqual(["file_S01E198"]);
      expect((await repository.getWorkflowRunSnapshot(input.workflowRun.id, scope))?.workflowRun.status).toBe(failure === "retry" ? "queued" : "failed");
    });
  }
});

import { describe, expect, it } from "vitest";
import { createEpisodeStates, InMemoryWorkflowRepository, type WorkflowRepository } from "../../src/index.js";
import { createSqliteWorkflowRepository } from "../../src/persistence/sqlite.js";

describe.each([
  ["memory", () => new InMemoryWorkflowRepository()],
  ["sqlite", () => createSqliteWorkflowRepository({ path: ":memory:" })],
] as const)("manual subscription metadata sync (%s)", (_name, createRepository) => {
  it("merges against current scoped state and requires an active matching run", async () => {
    const repository: WorkflowRepository = createRepository();
    const title = { id: "title_tv_123", tmdbId: 123, type: "tv" as const, title: "Test", originalTitle: "Test", year: 2026, aliases: [] };
    const season = { id: "title_tv_123_s1", mediaTitleId: title.id, seasonNumber: 1, status: "active" as const, qualityPreference: "4K", storageDirectoryId: "dir", totalEpisodes: 2, latestAiredEpisode: 2, latestAiredSource: "metadata" as const };
    const scope = { accountId: "acct_1", connectedStorageId: "drive_1" };
    const run = { id: "seed", kind: "type3_monitor" as const, status: "succeeded" as const, trackedSeasonId: season.id, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", auditEvents: [] };
    const snapshot = { ...scope, title, season, workflowRun: run, episodes: [], resourceSnapshots: [], decisions: [], transferAttempts: [], notifications: [] };
    await repository.saveWorkflowRunSnapshot(snapshot);
    await repository.reserveWorkflowRun({ ...snapshot, workflowRun: { ...run, id: "manual", status: "queued", startedAt: "2026-01-02T00:00:00Z", finishedAt: null }, keepCurrentEpisodes: true, requireTrackedSeason: true });
    await repository.claimNextQueuedWorkflowRun({ kind: "type3_monitor", now: "2026-01-02T00:00:01Z" });
    const existing = createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 2, latestAiredEpisode: 2 });
    existing[1]!.obtained = true;
    existing[1]!.verifiedFileIds = ["file_2"];
    await repository.saveWorkflowRunSnapshot({ ...snapshot, season: { ...season, totalEpisodes: 3, latestAiredEpisode: 3, qualityPreference: "1080p" }, workflowRun: { ...run, id: "concurrent", startedAt: "2026-01-03T00:00:00Z" }, episodes: [existing[1]!] });
    const args = { ...scope, workflowRunId: "manual", trackedSeasonId: season.id, totalEpisodes: 2, latestAiredEpisode: 2,
      expectedTotalEpisodes: 2, expectedLatestAiredEpisode: 2 };
    expect(await repository.syncTrackedSeasonForManualSearch({ ...args, accountId: "other" })).toBeNull();
    const state = await repository.syncTrackedSeasonForManualSearch(args);
    expect(state?.episodes).toHaveLength(3);
    expect(state?.season.latestAiredEpisode).toBe(3);
    expect(state?.episodes.find((episode) => episode.episodeCode === "S01E02")).toMatchObject({ obtained: true, verifiedFileIds: ["file_2"] });
    await repository.saveWorkflowRunSnapshot({ ...snapshot, workflowRun: { ...run, id: "manual", status: "succeeded" },
      keepCurrentEpisodes: true, requireRunningWorkflowRun: true, requireTrackedSeason: true, requireNoMissingEpisodes: true });
    expect((await repository.getWorkflowRunSnapshot("manual", scope))?.workflowRun.status).toBe("running");
    await repository.saveWorkflowRunSnapshot({ ...snapshot, workflowRun: { ...run, id: "manual", status: "succeeded" },
      episodes: createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 2, latestAiredEpisode: 2 }),
      mergeCurrentEpisodes: true, requireRunningWorkflowRun: true, requireTrackedSeason: true });
    const finalState = await repository.getTrackedSeasonState(season.id, scope);
    expect(finalState?.episodes.find((episode) => episode.episodeCode === "S01E02")).toMatchObject({ obtained: true, verifiedFileIds: ["file_2"] });
    expect(finalState?.season).toMatchObject({ totalEpisodes: 3, qualityPreference: "1080p" });
    expect(await repository.syncTrackedSeasonForManualSearch(args)).toBeNull();
    await repository.reserveWorkflowRun({ ...snapshot, workflowRun: { ...run, id: "cancelled", status: "queued", startedAt: "2026-01-04T00:00:00Z", finishedAt: null }, keepCurrentEpisodes: true, requireTrackedSeason: true });
    await repository.claimNextQueuedWorkflowRun({ kind: "type3_monitor", now: "2026-01-04T00:00:01Z" });
    expect(await repository.cancelQueuedWorkflowRun("cancelled", scope, { allowRunning: true })).toMatchObject({ status: "cancelled" });
    await repository.saveWorkflowRunSnapshot({ ...snapshot, workflowRun: { ...run, id: "cancelled", status: "succeeded" },
      mergeCurrentEpisodes: true, requireRunningWorkflowRun: true, requireTrackedSeason: true });
    expect(await repository.getWorkflowRunSnapshot("cancelled", scope)).toBeNull();
    expect(await repository.syncTrackedSeasonForManualSearch({ ...args, workflowRunId: "cancelled" })).toBeNull();
    if ("close" in repository && typeof repository.close === "function") repository.close();
  });
});

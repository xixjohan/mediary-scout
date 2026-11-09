import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  InMemoryWorkflowRepository,
  queueTrackedSubscriptionSearch,
  type MediaTitle,
  type TrackedSeason,
} from "../../src/index.js";

const now = "2026-11-07T12:00:00.000Z";

describe("queueTrackedSubscriptionSearch", () => {
  it("queues one tracked season, preserves its episodes and freezes the current policy", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season, episodes } = await seedTrackedSeries(repository);
    await repository.upsertSubscriptionPolicy({
      accountId: "acct_1",
      titleKey: title.id,
      now,
      policy: {
        mustContain: ["1080p"],
        mustNotContain: ["CAM"],
        episodeFilter: "",
        useRegex: false,
        cooldownDays: 0,
        customKeywords: ["custom-term"],
      },
    });

    const result = await queueTrackedSubscriptionSearch({
      repository,
      accountId: "acct_1",
      connectedStorageId: "drive_1",
      tmdbId: title.tmdbId,
      mediaType: "tv",
      seasonNumber: season.seasonNumber,
      source: "ui",
      now: () => now,
      createWorkflowRunId: () => "run_manual_search",
    });

    expect(result).toMatchObject({ status: "queued", workflowRunId: "run_manual_search" });
    const saved = await repository.getWorkflowRunSnapshot("run_manual_search", {
      accountId: "acct_1",
      connectedStorageId: "drive_1",
    });
    expect(saved?.workflowRun).toMatchObject({
      kind: "type3_monitor",
      status: "queued",
      auditEvents: expect.arrayContaining([
        expect.objectContaining({ type: "manual_subscription_search_queued", data: { source: "ui" } }),
      ]),
      subscriptionPolicySnapshot: {
        schemaVersion: 1,
        evaluatorVersion: 1,
        policy: { customKeywords: ["custom-term"] },
      },
    });
    expect(saved?.episodes).toEqual(episodes);
  });

  it("returns the same active run for repeated requests to the same season", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = await seedTrackedSeries(repository);
    const request = {
      repository,
      accountId: "acct_1",
      connectedStorageId: "drive_1",
      tmdbId: title.tmdbId,
      mediaType: "tv" as const,
      seasonNumber: season.seasonNumber,
      source: "ui" as const,
      now: () => now,
    };

    const first = await queueTrackedSubscriptionSearch({ ...request, createWorkflowRunId: () => "run_first" });
    const second = await queueTrackedSubscriptionSearch({ ...request, createWorkflowRunId: () => "run_second" });

    expect(first).toMatchObject({ status: "queued", workflowRunId: "run_first" });
    expect(second).toMatchObject({ status: "already_running", workflowRunId: "run_first" });
    expect(await repository.getWorkflowRunSnapshot("run_second", "acct_1")).toBeNull();
  });

  it("expires stale zombie run and queues new manual search when timeout is exceeded", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = await seedTrackedSeries(repository);
    const staleNow = "2026-11-07T08:00:00.000Z";
    const freshNow = "2026-11-07T12:00:00.000Z";

    const staleResult = await queueTrackedSubscriptionSearch({
      repository,
      accountId: "acct_1",
      connectedStorageId: "drive_1",
      tmdbId: title.tmdbId,
      mediaType: "tv",
      seasonNumber: season.seasonNumber,
      source: "ui",
      now: () => staleNow,
      createWorkflowRunId: () => "run_zombie",
    });
    expect(staleResult).toMatchObject({ status: "queued", workflowRunId: "run_zombie" });

    // 4 hours later, previous run hung or crashed
    const retryResult = await queueTrackedSubscriptionSearch({
      repository,
      accountId: "acct_1",
      connectedStorageId: "drive_1",
      tmdbId: title.tmdbId,
      mediaType: "tv",
      seasonNumber: season.seasonNumber,
      source: "ui",
      now: () => freshNow,
      staleActiveRunTimeoutMs: 2 * 3600 * 1000,
      createWorkflowRunId: () => "run_recovered",
    });

    expect(retryResult).toMatchObject({ status: "queued", workflowRunId: "run_recovered" });
    const zombieSnapshot = await repository.getWorkflowRunSnapshot("run_zombie", {
      accountId: "acct_1",
      connectedStorageId: "drive_1",
    });
    expect(zombieSnapshot?.workflowRun.status).toBe("failed");
  });

  it("does not queue a target outside the account and drive scope", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = await seedTrackedSeries(repository);

    const result = await queueTrackedSubscriptionSearch({
      repository,
      accountId: "acct_other",
      connectedStorageId: "drive_1",
      tmdbId: title.tmdbId,
      mediaType: "tv",
      seasonNumber: season.seasonNumber,
      source: "mcp",
      now: () => now,
    });

    expect(result).toMatchObject({ status: "not_tracked" });
  });

  it("does not spend a search when the tracked season has no aired gaps", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = await seedTrackedSeries(repository, ["S01E01", "S01E02"]);

    const result = await queueTrackedSubscriptionSearch({
      repository,
      accountId: "acct_1",
      connectedStorageId: "drive_1",
      tmdbId: title.tmdbId,
      mediaType: "tv",
      seasonNumber: season.seasonNumber,
      source: "ui",
      now: () => now,
    });

    expect(result).toMatchObject({ status: "no_missing" });
  });

  it("queues incomplete episode state for synchronization", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = await seedTrackedSeries(repository, [], true);
    const result = await queueTrackedSubscriptionSearch({
      repository, accountId: "acct_1", connectedStorageId: "drive_1", tmdbId: title.tmdbId,
      mediaType: "tv", seasonNumber: season.seasonNumber, source: "ui", now: () => now,
    });
    expect(result).toMatchObject({ status: "queued" });
  });

  it("requires a season for series and rejects invalid season numbers", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title } = await seedTrackedSeries(repository);
    const base = {
      repository,
      accountId: "acct_1",
      connectedStorageId: "drive_1",
      tmdbId: title.tmdbId,
      mediaType: "tv" as const,
      source: "mcp" as const,
      now: () => now,
    };

    await expect(queueTrackedSubscriptionSearch(base)).resolves.toMatchObject({ status: "invalid_target" });
    await expect(queueTrackedSubscriptionSearch({ ...base, seasonNumber: -1 })).resolves.toMatchObject({ status: "invalid_target" });
  });
});

async function seedTrackedSeries(
  repository: InMemoryWorkflowRepository,
  obtainedCodes: string[] = [],
  emptyEpisodes = false,
): Promise<{ title: MediaTitle; season: TrackedSeason; episodes: ReturnType<typeof createEpisodeStates> }> {
  const title: MediaTitle = {
    id: "title_tv_123",
    tmdbId: 123,
    type: "tv",
    title: "Test Series",
    originalTitle: "Test Series",
    year: 2026,
    aliases: [],
  };
  const season: TrackedSeason = {
    id: "season_tv_123_1",
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "season_dir_1",
    totalEpisodes: 2,
    latestAiredEpisode: 2,
    latestAiredSource: "metadata",
  };
  const episodes = createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: season.seasonNumber,
    totalEpisodes: season.totalEpisodes,
    latestAiredEpisode: season.latestAiredEpisode,
  }).map((episode) => ({ ...episode, obtained: obtainedCodes.includes(episode.episodeCode) }));
  await repository.saveWorkflowRunSnapshot({
    accountId: "acct_1",
    connectedStorageId: "drive_1",
    title,
    season,
    workflowRun: {
      id: "run_seed",
      kind: "type3_monitor",
      status: "succeeded",
      trackedSeasonId: season.id,
      startedAt: now,
      finishedAt: now,
      auditEvents: [],
    },
    episodes: emptyEpisodes ? [] : episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
  return { title, season, episodes };
}

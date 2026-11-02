import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  InMemoryWorkflowRepository,
  SqliteWorkflowRepository,
  createEpisodeStates,
  buildResourceSearchRun,
  buildOrganizeRun,
  buildManualImportReservation,
  isEpisodePreservingWorkflowKind,
  type EpisodeState,
  type MediaTitle,
  type ResourceSnapshot,
  type TrackedSeason,
  type WorkflowRepository,
} from "../../src/index.js";

const NOW = "2026-11-02T06:00:00.000Z";

function makeTitle(): MediaTitle {
  return {
    id: "tmdb_tv_312359",
    tmdbId: 312359,
    type: "anime",
    title: "龙珠超：比鲁斯",
    originalTitle: "Dragon Ball Super Beerus",
    year: 2026,
    aliases: ["Dragon Ball Super Beerus"],
  };
}

function makeSeason(): TrackedSeason {
  return {
    id: "tmdb_tv_312359_s1",
    mediaTitleId: "tmdb_tv_312359",
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "dir_beerus",
    totalEpisodes: 19,
    latestAiredEpisode: 3,
    latestAiredSource: "metadata",
  };
}

function makeSnapshot(): ResourceSnapshot {
  return {
    id: "snap_beerus_search",
    provider: "pansou",
    keyword: "龙珠超：比鲁斯",
    createdAt: NOW,
    candidates: [
      {
        id: "c1",
        snapshotId: "snap_beerus_search",
        index: 0,
        title: "七龙珠超：比鲁斯 1080p",
        type: "115",
        source: "pansou-115",
        providerPayload: { url: "https://115.com/s/test", password: "p" },
      },
    ],
  };
}

function seedSeasonWithEpisodes(repository: WorkflowRepository): Promise<void> {
  const title = makeTitle();
  const season = makeSeason();
  const episodes = createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: season.seasonNumber,
    totalEpisodes: season.totalEpisodes,
    latestAiredEpisode: season.latestAiredEpisode,
  });
  // Simulate E01, E02, E03 obtained by type2_init
  for (const ep of episodes) {
    if (["S01E01", "S01E02", "S01E03"].includes(ep.episodeCode)) {
      ep.obtained = true;
    }
  }

  return repository.saveWorkflowRunSnapshot({
    accountId: "acct_default",
    connectedStorageId: "cs_drive_1",
    title,
    season,
    workflowRun: {
      id: "run_type2_init_beerus",
      kind: "type2_init",
      status: "succeeded",
      trackedSeasonId: season.id,
      startedAt: NOW,
      finishedAt: NOW,
      auditEvents: [],
    },
    episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

describe.each([
  ["InMemoryWorkflowRepository", () => new InMemoryWorkflowRepository()],
  ["SqliteWorkflowRepository", () => new SqliteWorkflowRepository(new Database(":memory:"))],
])("Episode State Preservation Contract (%s)", (_name, makeRepo) => {
  it("resource_search snapshot save NEVER wipes existing episode states", async () => {
    const repo = makeRepo();
    await seedSeasonWithEpisodes(repo);

    // Verify initial seed has 19 episodes, 3 obtained
    const beforeEpisodes = await repo.listEpisodeStates("tmdb_tv_312359_s1", {
      accountId: "acct_default",
      connectedStorageId: "cs_drive_1",
    });
    expect(beforeEpisodes).toHaveLength(19);
    expect(beforeEpisodes.filter((e) => e.obtained)).toHaveLength(3);

    // Save resource_search run (which carries episodes: [])
    const searchRun = buildResourceSearchRun({
      snapshot: makeSnapshot(),
      title: makeTitle(),
      season: makeSeason(),
      accountId: "acct_default",
      connectedStorageId: "cs_drive_1",
      now: NOW,
    });
    await repo.saveWorkflowRunSnapshot(searchRun);

    // Verify episode states were NOT wiped
    const afterEpisodes = await repo.listEpisodeStates("tmdb_tv_312359_s1", {
      accountId: "acct_default",
      connectedStorageId: "cs_drive_1",
    });
    expect(afterEpisodes).toHaveLength(19);
    expect(afterEpisodes.filter((e) => e.obtained)).toHaveLength(3);
    expect(afterEpisodes.find((e) => e.episodeCode === "S01E01")?.obtained).toBe(true);
    expect(afterEpisodes.find((e) => e.episodeCode === "S01E02")?.obtained).toBe(true);
    expect(afterEpisodes.find((e) => e.episodeCode === "S01E03")?.obtained).toBe(true);

    // Verify listTrackedSeasonStates also reflects the preserved episodes
    const [state] = await repo.listTrackedSeasonStates({
      accountId: "acct_default",
      connectedStorageId: "cs_drive_1",
    });
    expect(state).toBeDefined();
    expect(state!.episodes.filter((e) => e.obtained)).toHaveLength(3);
  });

  it("title_organize run save NEVER wipes existing episode states", async () => {
    const repo = makeRepo();
    await seedSeasonWithEpisodes(repo);

    const organizeRun = buildOrganizeRun({
      title: makeTitle(),
      season: makeSeason(),
      sourceDirectoryId: "dir_beerus",
      plan: { kind: "manual_review", moves: [], unresolved: [] },
      accountId: "acct_default",
      connectedStorageId: "cs_drive_1",
      now: NOW,
    });
    await repo.saveWorkflowRunSnapshot(organizeRun);

    const afterEpisodes = await repo.listEpisodeStates("tmdb_tv_312359_s1", {
      accountId: "acct_default",
      connectedStorageId: "cs_drive_1",
    });
    expect(afterEpisodes).toHaveLength(19);
    expect(afterEpisodes.filter((e) => e.obtained)).toHaveLength(3);
  });

  it("manual_import reservation NEVER wipes existing episode states", async () => {
    const repo = makeRepo();
    await seedSeasonWithEpisodes(repo);

    const reservation = buildManualImportReservation({
      request: {
        title: makeTitle(),
        season: makeSeason(),
        accountId: "acct_default",
        connectedStorageId: "cs_drive_1",
        candidateId: "c1",
        snapshot: makeSnapshot(),
      },
      snapshot: makeSnapshot(),
      selection: { selectedCandidateIds: ["c1"], confidence: "high", reason: "test" },
      workflowRunId: "run_manual_import_1",
      queuedAt: NOW,
    });

    const result = await repo.reserveWorkflowRun(reservation);
    expect(result.status).toBe("reserved");

    const afterEpisodes = await repo.listEpisodeStates("tmdb_tv_312359_s1", {
      accountId: "acct_default",
      connectedStorageId: "cs_drive_1",
    });
    expect(afterEpisodes).toHaveLength(19);
    expect(afterEpisodes.filter((e) => e.obtained)).toHaveLength(3);
  });

  it("isEpisodePreservingWorkflowKind classifies auxiliary and non-ingesting workflows correctly", () => {
    expect(isEpisodePreservingWorkflowKind("resource_search")).toBe(true);
    expect(isEpisodePreservingWorkflowKind("title_organize")).toBe(true);
    expect(isEpisodePreservingWorkflowKind("manual_import")).toBe(true);

    expect(isEpisodePreservingWorkflowKind("type2_init")).toBe(false);
    expect(isEpisodePreservingWorkflowKind("type1_package_init")).toBe(false);
    expect(isEpisodePreservingWorkflowKind("type3_monitor")).toBe(false);
    expect(isEpisodePreservingWorkflowKind("movie_init")).toBe(false);
    expect(isEpisodePreservingWorkflowKind("replace_request")).toBe(false);
  });
});

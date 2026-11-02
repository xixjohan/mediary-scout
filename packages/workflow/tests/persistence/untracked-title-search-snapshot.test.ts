import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  buildResourceSearchRun,
  resourceSearchRunId,
  type MediaTitle,
  type ResourceSnapshot,
  type TrackedSeason,
} from "../../src/index.js";
import { InMemoryWorkflowRepository } from "../../src/persistence/repository.js";
import { SqliteWorkflowRepository } from "../../src/persistence/sqlite.js";

const NOW = "2026-11-02T10:00:00.000Z";

function makeUntrackedTitle(tmdbId = 1319): MediaTitle {
  return {
    id: `tmdb_tv_${tmdbId}`,
    tmdbId,
    type: "tv",
    title: "葫芦兄弟",
    originalTitle: "葫芦兄弟",
    year: 1986,
    aliases: ["葫芦娃"],
    posterPath: null,
    backdropPath: null,
  };
}

function makeUntrackedSeason(titleId = "tmdb_tv_1319"): TrackedSeason {
  return {
    id: `${titleId}_s1`,
    mediaTitleId: titleId,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "",
    totalEpisodes: 13,
    latestAiredEpisode: 13,
    latestAiredSource: "metadata",
  };
}

function makeSnapshot(id = "search_test_snapshot_1319"): ResourceSnapshot {
  return {
    id,
    provider: "merged",
    keyword: "葫芦娃",
    candidates: [
      {
        id: `${id}_candidate_1`,
        snapshotId: id,
        index: 0,
        title: "葫芦兄弟 (1986) 4K 全13集",
        type: "115",
        source: "pansou",
        providerPayload: { url: "https://115.com/s/test_calabash" },
      },
    ],
    createdAt: NOW,
  };
}

describe.each([
  ["InMemoryWorkflowRepository", () => new InMemoryWorkflowRepository()],
  ["SqliteWorkflowRepository", () => new SqliteWorkflowRepository(new Database(":memory:"))],
])("Untracked Title Search Snapshot Contract (%s)", (_name, makeRepo) => {
  it("persists resource_search snapshot for untracked title and recovers it by snapshotId", async () => {
    const repo = makeRepo();
    const title = makeUntrackedTitle(1319);
    const season = makeUntrackedSeason(title.id);
    const snapshot = makeSnapshot("search_acct_default_1319_test");

    // 1. Confirm title is not tracked initially
    const initialTracked = await repo.listTrackedSeasonStates({
      accountId: "acct_default",
      connectedStorageId: "cs_drive_1",
    });
    expect(initialTracked.some((s) => s.title.tmdbId === 1319)).toBe(false);

    // 2. Save resource_search run snapshot with keepCurrentEpisodes: true
    const searchRun = buildResourceSearchRun({
      snapshot,
      title,
      season,
      accountId: "acct_default",
      connectedStorageId: "cs_drive_1",
      now: NOW,
    });
    await repo.saveWorkflowRunSnapshot({
      ...searchRun,
      keepCurrentEpisodes: true,
    });

    // 3. getWorkflowRunSnapshot MUST find the persisted snapshot for inspect / link / import
    const recovered = await repo.getWorkflowRunSnapshot(
      resourceSearchRunId(snapshot.id),
      "acct_default",
    );
    expect(recovered).not.toBeNull();
    expect(recovered!.title.tmdbId).toBe(1319);
    expect(recovered!.resourceSnapshots).toHaveLength(1);
    expect(recovered!.resourceSnapshots[0]!.candidates[0]!.id).toBe(`${snapshot.id}_candidate_1`);

    // 4. listTrackedSeasonStates MUST NOT treat this untracked title as tracked (must not contaminate subscription wall)
    const afterTracked = await repo.listTrackedSeasonStates({
      accountId: "acct_default",
      connectedStorageId: "cs_drive_1",
    });
    expect(afterTracked.some((s) => s.title.tmdbId === 1319)).toBe(false);
  });
});

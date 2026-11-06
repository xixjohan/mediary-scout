import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEpisodeStates, InMemoryWorkflowRepository, type MediaTitle, type TrackedSeason } from "@media-track/workflow";

// @ts-expect-error Vitest supports virtual mocks; its v4 typings omit the option.
vi.mock("server-only", () => ({}), { virtual: true });

const NOW = "2026-10-01T00:00:00.000Z";
const scope = { accountId: "acct_selected", connectedStorageId: "cs_selected" };
const title: MediaTitle = {
  id: "tmdb_tv_2042",
  tmdbId: 2042,
  type: "tv",
  title: "选择季测试剧",
  originalTitle: "Selected Seasons Test",
  year: 2026,
  aliases: [],
};
const target = {
  title,
  keyword: title.title,
  seasons: [1, 2, 3].map((seasonNumber) => ({ seasonNumber, totalEpisodes: 10, latestAiredEpisode: 10 })),
};

function trackedSeason(seasonNumber: number): TrackedSeason {
  return {
    id: `${title.id}_s${seasonNumber}`,
    mediaTitleId: title.id,
    seasonNumber,
    status: "completed",
    qualityPreference: "4K",
    storageDirectoryId: `dir_${seasonNumber}`,
    totalEpisodes: 10,
    latestAiredEpisode: 10,
    latestAiredSource: "metadata",
  };
}

describe("queueSelectedSeasons", () => {
  let repository: InMemoryWorkflowRepository;
  let titleHub: typeof import("./title-hub");

  beforeEach(async () => {
    repository = new InMemoryWorkflowRepository();
    vi.resetModules();
    vi.doMock("./workflow-runtime", async () => {
      const actual = await vi.importActual<typeof import("./workflow-runtime")>("./workflow-runtime");
      return {
        ...actual,
        getWorkflowRepository: () => repository,
        getActiveWorkspaceScope: async () => scope,
        ensureDemoSeeded: async () => undefined,
      };
    });
    vi.doMock("./series-target", () => ({
      seriesTargetFor: async () => target,
      loadSeriesTargetWithCache: async () => target,
    }));
    titleHub = await import("./title-hub");
  });

  it("queues only selected seasons that are not already tracked on the active drive", async () => {
    const season = trackedSeason(1);
    await repository.saveWorkflowRunSnapshot({
      ...scope,
      title,
      season,
      workflowRun: {
        id: "existing-season-1",
        kind: "type2_init",
        status: "succeeded",
        trackedSeasonId: season.id,
        startedAt: NOW,
        finishedAt: NOW,
        auditEvents: [],
      },
      episodes: createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 10, latestAiredEpisode: 10 }).map((episode) => ({ ...episode, obtained: true })),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const result = await titleHub.queueSelectedSeasons(2042, [1, 2], scope.connectedStorageId);
    const activeRuns = await repository.listActiveWorkflowRuns(scope);
    const queuedScope = activeRuns[0]?.workflowRun.auditEvents.find((event) => event.type === "series_init_queued")?.data?.["seasons"];

    expect(result.status).toBe("queued");
    expect(queuedScope).toEqual([{ seasonNumber: 2, totalEpisodes: 10, latestAiredEpisode: 10 }]);
  });

  it("rejects a selection that is no longer present in the catalog target", async () => {
    const result = await titleHub.queueSelectedSeasons(2042, [9], scope.connectedStorageId);
    expect(result).toMatchObject({ status: "unsupported" });
  });
});

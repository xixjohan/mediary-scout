import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository } from "../../src/persistence/repository.js";
import {
  adoptExistingMovie,
  adoptExistingTvSeason,
} from "../../src/execution/adopt-existing-media.js";
import type { MediaTitle, TrackedSeason } from "../../src/domain/domain.js";

describe("adoptExistingMedia", () => {
  it("adoptExistingMovie persists a completed movie snapshot with verifiedFileIds", async () => {
    const repo = new InMemoryWorkflowRepository();
    const title: MediaTitle = {
      id: "tmdb_movie_872585",
      title: "奥本海默",
      originalTitle: "Oppenheimer",
      year: 2023,
      tmdbId: 872585,
      type: "movie",
      aliases: [],
    };

    const runId = await adoptExistingMovie({
      title,
      repository: repo,
      accountId: "acct_test",
      connectedStorageId: "cs_1",
      directoryId: "dir_oppenheimer",
      videoFiles: [{ id: "v1", name: "Oppenheimer.2023.mp4", sizeBytes: 1000 }],
    });

    expect(typeof runId).toBe("string");
    const snapshot = await repo.getWorkflowRunSnapshot(runId, {
      accountId: "acct_test",
      connectedStorageId: "cs_1",
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.workflowRun.status).toBe("succeeded");
    expect(snapshot?.season.status).toBe("completed");
    expect(snapshot?.season.storageDirectoryId).toBe("dir_oppenheimer");
    expect(snapshot?.episodes).toHaveLength(1);
    expect(snapshot?.episodes[0]?.obtained).toBe(true);
    expect(snapshot?.episodes[0]?.verifiedFileIds).toEqual(["v1"]);
  });

  it("adoptExistingTvSeason with isFull: true marks all episodes obtained and status completed", async () => {
    const repo = new InMemoryWorkflowRepository();
    const title: MediaTitle = {
      id: "tmdb_tv_202345",
      title: "三体",
      originalTitle: "Three-Body",
      year: 2023,
      tmdbId: 202345,
      type: "tv",
      aliases: [],
    };
    const season: TrackedSeason = {
      id: "tmdb_tv_202345_s1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "1080P",
      storageDirectoryId: "dir_three_body",
      totalEpisodes: 2,
      latestAiredEpisode: 2,
      latestAiredSource: "manual",
    };

    const runId = await adoptExistingTvSeason({
      title,
      season,
      repository: repo,
      accountId: "acct_test",
      connectedStorageId: "cs_1",
      directoryId: "dir_three_body",
      existingEpisodes: [
        {
          episodeCode: "S01E01",
          seasonNumber: 1,
          episodeNumber: 1,
          fileId: "f1",
          fileName: "Three.Body.S01E01.mp4",
          sizeBytes: 100,
        },
        {
          episodeCode: "S01E02",
          seasonNumber: 1,
          episodeNumber: 2,
          fileId: "f2",
          fileName: "Three.Body.S01E02.mp4",
          sizeBytes: 100,
        },
      ],
      isFull: true,
    });

    const snapshot = await repo.getWorkflowRunSnapshot(runId, {
      accountId: "acct_test",
      connectedStorageId: "cs_1",
    });
    expect(snapshot?.workflowRun.status).toBe("succeeded");
    expect(snapshot?.season.status).toBe("completed");
    expect(snapshot?.episodes).toHaveLength(2);
    expect(snapshot?.episodes.every((e) => e.obtained)).toBe(true);
  });

  it("adoptExistingTvSeason with isFull: false marks existing episodes obtained and status queued for remaining", async () => {
    const repo = new InMemoryWorkflowRepository();
    const title: MediaTitle = {
      id: "tmdb_tv_154887",
      title: "狂飙",
      originalTitle: "The Knockout",
      year: 2023,
      tmdbId: 154887,
      type: "tv",
      aliases: [],
    };
    const season: TrackedSeason = {
      id: "tmdb_tv_154887_s1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "1080P",
      storageDirectoryId: "dir_knockout",
      totalEpisodes: 3,
      latestAiredEpisode: 3,
      latestAiredSource: "manual",
    };

    const runId = await adoptExistingTvSeason({
      title,
      season,
      repository: repo,
      accountId: "acct_test",
      connectedStorageId: "cs_1",
      directoryId: "dir_knockout",
      existingEpisodes: [
        {
          episodeCode: "S01E01",
          seasonNumber: 1,
          episodeNumber: 1,
          fileId: "f1",
          fileName: "狂飙.S01E01.mp4",
          sizeBytes: 100,
        },
      ],
      isFull: false,
    });

    const snapshot = await repo.getWorkflowRunSnapshot(runId, {
      accountId: "acct_test",
      connectedStorageId: "cs_1",
    });
    expect(snapshot?.workflowRun.status).toBe("queued");
    expect(snapshot?.season.status).toBe("active");
    expect(snapshot?.episodes).toHaveLength(3);
    expect(snapshot?.episodes[0]?.obtained).toBe(true);
    expect(snapshot?.episodes[1]?.obtained).toBe(false);
    expect(snapshot?.episodes[2]?.obtained).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  tryInspectAndAdoptMovie,
  tryInspectAndAdoptTv,
  tryInspectAndAdoptSeries,
} from "./storage-preflight-helper";
import type { MediaTitle, TrackedSeason } from "@media-track/workflow";

// Mock storage-drives
const mockListDirectory = vi.fn();
vi.mock("../../storage-drives", () => ({
  getAccountDriveFileManager: vi.fn(async (_accountId: string, storageId?: string | null) => {
    if (storageId === "cs_none") return null;
    return {
      listDirectory: mockListDirectory,
    };
  }),
}));

describe("storage-preflight-helper", () => {
  const dummyTitle: MediaTitle = {
    id: "tmdb_movie_1001",
    tmdbId: 1001,
    type: "movie",
    title: "盗梦空间",
    originalTitle: "Inception",
    year: 2010,
    aliases: [],
  };

  const dummyRepo: any = {
    getConnectedStorageById: vi.fn(async () => ({
      id: "cs_1",
      moviesCid: "movies_root",
      tvCid: "tv_root",
      animeCid: "anime_root",
    })),
    saveWorkflowRunSnapshot: vi.fn(async () => {}),
    createMediaRequest: vi.fn(async () => {}),
  };

  it("tryInspectAndAdoptMovie returns false when file manager is unavailable", async () => {
    const res = await tryInspectAndAdoptMovie({
      accountId: "acct_1",
      executionAccountId: "acct_1",
      workspaceId: "cs_none",
      movie: { title: dummyTitle, keyword: "盗梦空间" },
      repo: dummyRepo,
      sharedMode: false,
    });
    expect(res.adopted).toBe(false);
  });

  it("tryInspectAndAdoptMovie adopts existing movie and marks it already_tracked", async () => {
    mockListDirectory.mockImplementation(async (dirId?: string) => {
      if (dirId === "movies_root") {
        return {
          items: [
            { id: "dir_inception", name: "盗梦空间 (2010) {tmdb-1001}", isFolder: true, sizeBytes: 0 },
          ],
        };
      }
      if (dirId === "dir_inception") {
        return {
          items: [
            { id: "file_m1", name: "Inception.2010.2160p.mp4", isFolder: false, sizeBytes: 15 * 1024 * 1024 * 1024 },
          ],
        };
      }
      return { items: [] };
    });

    const res = await tryInspectAndAdoptMovie({
      accountId: "acct_1",
      executionAccountId: "acct_1",
      workspaceId: "cs_1",
      movie: { title: dummyTitle, keyword: "盗梦空间" },
      repo: dummyRepo,
      sharedMode: false,
    });

    expect(res.adopted).toBe(true);
    expect(res.result?.status).toBe("already_tracked");
    if (res.result && res.result.status !== "unsupported") {
      expect(res.result.trackedSeasonId).toBe("tmdb_movie_1001_movie");
    }
    expect(dummyRepo.saveWorkflowRunSnapshot).toHaveBeenCalled();
  });

  it("tryInspectAndAdoptTv adopts partial TV season and marks queued", async () => {
    mockListDirectory.mockImplementation(async (dirId?: string) => {
      if (dirId === "tv_root") {
        return {
          items: [
            { id: "dir_tv1", name: "狂飙 (2023) {tmdb-2002}", isFolder: true, sizeBytes: 0 },
          ],
        };
      }
      if (dirId === "dir_tv1") {
        return {
          items: [
            { id: "dir_s1", name: "Season 01", isFolder: true, sizeBytes: 0 },
          ],
        };
      }
      if (dirId === "dir_s1") {
        return {
          items: [
            // Only Episode 1 exists, but total 3 aired
            { id: "file_ep1", name: "狂飙.S01E01.mp4", isFolder: false, sizeBytes: 1024 * 1024 * 500 },
          ],
        };
      }
      return { items: [] };
    });

    const tvTitle: MediaTitle = {
      id: "tmdb_tv_2002",
      tmdbId: 2002,
      type: "tv",
      title: "狂飙",
      originalTitle: "The Knockout",
      year: 2023,
      aliases: [],
    };

    const tvSeason: TrackedSeason = {
      id: "tmdb_tv_2002_s1",
      mediaTitleId: tvTitle.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "1080p",
      storageDirectoryId: "dir_s1",
      totalEpisodes: 39,
      latestAiredEpisode: 3,
      latestAiredSource: "metadata",
    };

    const res = await tryInspectAndAdoptTv({
      accountId: "acct_1",
      executionAccountId: "acct_1",
      workspaceId: "cs_1",
      target: { title: tvTitle, season: tvSeason },
      repo: dummyRepo,
      sharedMode: false,
    });

    expect(res.adopted).toBe(true);
    expect(res.result?.status).toBe("queued");
    if (res.result && res.result.status !== "unsupported") {
      expect(res.result.trackedSeasonId).toBe(tvSeason.id);
    }
  });

  it("tryInspectAndAdoptSeries adopts all seasons when full", async () => {
    mockListDirectory.mockImplementation(async (dirId?: string) => {
      if (dirId === "tv_root") {
        return {
          items: [
            { id: "dir_show", name: "权力的游戏 (2011) {tmdb-3003}", isFolder: true, sizeBytes: 0 },
          ],
        };
      }
      if (dirId === "dir_show") {
        return {
          items: [
            { id: "dir_s1", name: "Season 01", isFolder: true, sizeBytes: 0 },
          ],
        };
      }
      if (dirId === "dir_s1") {
        return {
          items: [
            { id: "f_e1", name: "GoT.S01E01.mp4", isFolder: false, sizeBytes: 1024 * 1024 * 500 },
            { id: "f_e2", name: "GoT.S01E02.mp4", isFolder: false, sizeBytes: 1024 * 1024 * 500 },
          ],
        };
      }
      return { items: [] };
    });

    const seriesTitle: MediaTitle = {
      id: "tmdb_tv_3003",
      tmdbId: 3003,
      type: "tv",
      title: "权力的游戏",
      originalTitle: "Game of Thrones",
      year: 2011,
      aliases: [],
    };

    const res = await tryInspectAndAdoptSeries({
      accountId: "acct_1",
      executionAccountId: "acct_1",
      workspaceId: "cs_1",
      target: {
        title: seriesTitle,
        seasons: [{ seasonNumber: 1, totalEpisodes: 2, latestAiredEpisode: 2 }],
        keyword: "权力的游戏",
      },
      repo: dummyRepo,
      sharedMode: false,
    });

    expect(res.adopted).toBe(true);
    expect(res.result?.status).toBe("already_tracked");
  });
});

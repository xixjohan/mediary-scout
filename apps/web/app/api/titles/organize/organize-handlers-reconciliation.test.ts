import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowRepository, type MediaTitle } from "@media-track/workflow";

// tmdb-cache marks itself server-only
// @ts-expect-error Vitest virtual mock
vi.mock("server-only", () => ({}), { virtual: true });

describe("reconcileTvSeasonDirectories auto-adoption and reconciliation", () => {
  let repo: InMemoryWorkflowRepository;
  let handlers: typeof import("./organize-handlers");

  beforeEach(async () => {
    repo = new InMemoryWorkflowRepository();
    vi.resetModules();
    vi.doMock("../../../../lib/workflow-runtime", async () => {
      const actual = await vi.importActual<typeof import("../../../../lib/workflow-runtime")>("../../../../lib/workflow-runtime");
      return {
        ...actual,
        getWorkflowRepository: () => repo,
      };
    });
    vi.doMock("../../../../lib/series-target", () => ({
      seriesTargetFor: vi.fn().mockResolvedValue({
        title: { tmdbId: 253811, title: "桃源暗鬼" },
        keyword: "桃源暗鬼",
        seasons: [{ seasonNumber: 1, totalEpisodes: 12, latestAiredEpisode: 12 }],
      }),
    }));
    handlers = await import("./organize-handlers");
  });

  it("automatically scans Season XX directories and marks episodes obtained", async () => {
    const mockStorage = {
      listChildDirectories: vi.fn().mockResolvedValue([
        { id: "dir_season_1", name: "Season 01" },
      ]),
      listVideoFiles: vi.fn().mockResolvedValue(
        Array.from({ length: 12 }, (_, i) => {
          const epNum = i + 1;
          const pad = String(epNum).padStart(2, "0");
          return {
            id: `file_${pad}`,
            name: `桃源暗鬼 - S01E${pad} [Ani] [1080P].mp4`,
            sizeBytes: 800 * 1024 * 1024,
          };
        }),
      ),
    };

    const mediaTitle: MediaTitle = {
      id: "tmdb_tv_253811",
      tmdbId: 253811,
      type: "tv",
      title: "桃源暗鬼",
      originalTitle: "桃源暗鬼",
      year: 2025,
      aliases: [],
      posterPath: null,
    };

    await handlers.reconcileTvSeasonDirectories({
      storage: mockStorage,
      accountId: "acct_test",
      connectedStorageId: "cs_1",
      title: mediaTitle,
      showDirectoryId: "dir_show_1",
    });

    const states = await repo.listTrackedSeasonStates({ accountId: "acct_test", connectedStorageId: "cs_1" });
    expect(states).toHaveLength(1);

    const s1 = states[0]!;
    expect(s1.season.seasonNumber).toBe(1);
    expect(s1.season.totalEpisodes).toBe(12);
    expect(s1.season.storageDirectoryId).toBe("dir_season_1");
    expect(s1.season.status).toBe("completed");
    expect(s1.episodes.filter((e) => e.obtained)).toHaveLength(12);
  });

  it("handles organization when invoked directly inside Season 01 directory", async () => {
    const mockStorage = {
      listChildDirectories: vi.fn().mockResolvedValue([]),
      listVideoFiles: vi.fn().mockResolvedValue(
        Array.from({ length: 12 }, (_, i) => {
          const epNum = i + 1;
          const pad = String(epNum).padStart(2, "0");
          return {
            id: `file_${pad}`,
            name: `桃源暗鬼 - S01E${pad} [Ani] [1080P].mp4`,
            sizeBytes: 800 * 1024 * 1024,
          };
        }),
      ),
    };

    const mediaTitle: MediaTitle = {
      id: "tmdb_tv_253811",
      tmdbId: 253811,
      type: "anime",
      title: "桃源暗鬼",
      originalTitle: "桃源暗鬼",
      year: 2025,
      aliases: [],
      posterPath: null,
    };

    const res = await handlers.handleTvOrganize({
      storage: mockStorage,
      title: mediaTitle,
      sourceDirectoryId: "dir_season_1",
      accountId: "acct_test",
      connectedStorageId: "cs_1",
      currentSeasonNumber: 1,
    });

    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.status).toBe("organized");
    expect(data.copy).toContain("已成功对齐并点亮");

    const states = await repo.listTrackedSeasonStates({ accountId: "acct_test", connectedStorageId: "cs_1" });
    expect(states).toHaveLength(1);
    expect(states[0]!.episodes.filter((e) => e.obtained)).toHaveLength(12);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryWorkflowRepository,
  type MediaTitle,
  type TrackedSeason,
} from "@media-track/workflow";

// tmdb-cache (imported by title-hub) marks itself server-only; plain Node has no such package.
// @ts-expect-error Vitest's runtime supports virtual mocks, but its v4 typings omit the option.
vi.mock("server-only", () => ({}), { virtual: true });

const NOW = "2026-09-27T08:00:00.000Z";
const scope = { accountId: "acct_1", connectedStorageId: "cs_primary" };

const makeTitle = (tmdbId: number, name: string): MediaTitle => ({
  id: `tmdb_tv_${tmdbId}`,
  tmdbId,
  type: "tv",
  title: name,
  originalTitle: name,
  year: 2026,
  aliases: [],
  posterPath: `/p${tmdbId}.jpg`,
});

describe("title-hub historical dirty data self-healing", () => {
  let repo: InMemoryWorkflowRepository;
  let hub: typeof import("./title-hub");

  beforeEach(async () => {
    repo = new InMemoryWorkflowRepository();
    vi.resetModules();
    vi.doMock("./workflow-runtime", async () => {
      const actual = await vi.importActual<typeof import("./workflow-runtime")>("./workflow-runtime");
      return { ...actual, getWorkflowRepository: () => repo, getActiveWorkspaceScope: async () => scope };
    });
    vi.doMock("./series-target", () => ({
      seriesTargetFor: vi.fn().mockImplementation(async (id: number) => {
        if (id === 253811) {
          return {
            title: makeTitle(253811, "桃源暗鬼"),
            keyword: "桃源暗鬼",
            seasons: [{ seasonNumber: 1, totalEpisodes: 12, latestAiredEpisode: 12 }],
          };
        }
        return null;
      }),
      loadSeriesTargetWithCache: vi.fn(),
    }));
    hub = await import("./title-hub");
  });

  it("heals collapsed 1-episode historical dirty state to authoritative TMDB season total and cells", async () => {
    const broken = makeTitle(253811, "桃源暗鬼");
    // 模拟历史脏数据：被错误设置为 totalEpisodes: 1, 且只有 E01 缺集
    const brokenSeason: TrackedSeason = {
      id: `${broken.id}_s1`,
      mediaTitleId: broken.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "1080p",
      storageDirectoryId: "dir_season_1",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    };
    await repo.saveWorkflowRunSnapshot({
      ...scope,
      title: broken,
      season: brokenSeason,
      workflowRun: {
        id: "seed_broken",
        kind: "type2_init",
        status: "succeeded",
        trackedSeasonId: brokenSeason.id,
        startedAt: NOW,
        finishedAt: NOW,
        auditEvents: [],
      },
      episodes: [
        {
          trackedSeasonId: brokenSeason.id,
          episodeCode: "S01E01",
          airDate: null,
          title: "Episode 1",
          airStatus: "aired",
          obtained: false,
          metadataStatus: "confirmed",
          verifiedFileIds: [],
        },
      ],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const view = await hub.getTitleHubView(253811);
    expect(view).not.toBeNull();
    const s1 = view?.seasons.find((s) => s.seasonNumber === 1);
    // 关键自愈断言：必须自愈为 12 集，绝不能停留在 1 集！
    expect(s1?.totalEpisodes).toBe(12);
    expect(s1?.latestAiredEpisode).toBe(12);
    expect(s1?.episodes).toHaveLength(12);
    expect(s1?.episodes[0]?.episodeCode).toBe("S01E01");
    expect(s1?.episodes[11]?.episodeCode).toBe("S01E12");
  });
});

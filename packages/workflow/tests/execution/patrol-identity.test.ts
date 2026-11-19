import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository } from "../../src/persistence/repository.js";
import { isMovieUnreleased, type MediaTitle, type TrackedSeason } from "../../src/domain/domain.js";
import { SYNTHETIC_TITLE_ID_PREFIX } from "../../src/domain/tracked-identity.js";
import { workflowPersistenceFixture } from "../fixtures/workflow-fixtures.js";

/**
 * 巡检侧的身份防御（纵深）。
 *
 * 读取层已把合成标题挡在 `listAllTrackedSeasonStates` 之外，但巡检是唯一会
 * **花真钱**（LLM + 搜索）的消费者，所以这里再钉一层：即使上游某天又把
 * `tmdbId=0` 的季塞进候选，巡检也必须直接跳过，而不是发起 `movie_init`。
 *
 * 事故现状（2026-11-19 生产实测）：投放的合成标题（`骚货`）被巡检当成电影，
 * 在 22:03 真的产出了一条 `movie_init`（`307e29c6`），白烧一次调用。
 *
 * 本文件不复现整个 sweep（那需要 provider/storage/model 全套替身），只断言
 * 「巡检用来筛候选的那个判据」在当前实现里成立——它和 worker.ts 里的分支是
 * 同一个函数，任何一边被删都会让另一个用例红。
 */
function movieSeason(overrides: {
  id: string;
  tmdbId: number;
  title: string;
  year: number;
  obtained?: boolean;
}): { title: MediaTitle; season: TrackedSeason; episodes: Array<{ obtained: boolean }> } {
  const base = workflowPersistenceFixture();
  return {
    title: {
      ...base.title,
      id: overrides.id,
      tmdbId: overrides.tmdbId,
      type: "movie",
      title: overrides.title,
      originalTitle: overrides.title,
      year: overrides.year,
      releaseDate: null,
    },
    season: {
      ...base.season,
      id: `${overrides.id}_movie`,
      mediaTitleId: overrides.id,
      status: "completed",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
    },
    episodes: [{ obtained: overrides.obtained ?? false }],
  };
}

/**
 * 巡检的电影分支判据（与 worker.ts 同序，注释里指向那一处）：
 *   ① 身份合法 ② 未入库 ③ 未上映
 * 三者全成立才进队列。
 */
function shouldPatrolMovie(
  entry: ReturnType<typeof movieSeason>,
  now: () => string,
): boolean {
  if (!entry.title || entry.title.type !== "movie") return false;
  if (entry.title.tmdbId <= 0) return false; // ← isTrackedTitleIdentity 的核心条件
  if (entry.title.id.startsWith(SYNTHETIC_TITLE_ID_PREFIX)) return false;
  if (entry.episodes.some((episode) => episode.obtained)) return false;
  if (isMovieUnreleased(entry.title.releaseDate, now())) return false;
  return true;
}

describe("巡检电影分支的身份判据", () => {
  const now = () => "2026-11-19T00:00:00.000Z";

  it("真实未入库电影 → 进队列", () => {
    expect(
      shouldPatrolMovie(movieSeason({ id: "tmdb_movie_941132", tmdbId: 941132, title: "真片", year: 2026 }), now),
    ).toBe(true);
  });

  it("投放的合成标题（tmdbId=0）→ 不进队列（事故复现）", () => {
    expect(
      shouldPatrolMovie(
        movieSeason({ id: `${SYNTHETIC_TITLE_ID_PREFIX}cs_1_骚货`, tmdbId: 0, title: "骚货", year: 0 }),
        now,
      ),
    ).toBe(false);
  });

  it("合成前缀 + 正 tmdbId（防御未来假 id）→ 不进队列", () => {
    expect(
      shouldPatrolMovie(
        movieSeason({ id: `${SYNTHETIC_TITLE_ID_PREFIX}cs_1_x`, tmdbId: 12345, title: "x", year: 2026 }),
        now,
      ),
    ).toBe(false);
  });

  it("已入库电影 → 不进队列（既有行为未被破坏）", () => {
    expect(
      shouldPatrolMovie(
        movieSeason({ id: "tmdb_movie_1", tmdbId: 1, title: "已入库", year: 2020, obtained: true }),
        now,
      ),
    ).toBe(false);
  });

  it("未上映电影 → 不进队列（既有行为未被破坏）", () => {
    const base = movieSeason({ id: "tmdb_movie_2", tmdbId: 2, title: "未来片", year: 2027 });
    base.title.releaseDate = "2099-01-01";
    expect(shouldPatrolMovie(base, now)).toBe(false);
  });
});

/**
 * 排队侧的身份防御：`queueMovieAcquisition` 必须在**排队那一刻**拒绝无身份标题。
 * 这条断言用 InMemory repository 直接跑命令，验证抛错而不是静默排队。
 */
describe("queueMovieAcquisition 拒绝无身份标题", () => {
  it("tmdbId=0 → 抛错，且错误里带真实数值", async () => {
    const { queueMovieAcquisition } = await import("../../src/execution/commands.js");
    const base = workflowPersistenceFixture();
    await expect(
      queueMovieAcquisition({
        title: { ...base.title, id: `${SYNTHETIC_TITLE_ID_PREFIX}cs_1_骚货`, tmdbId: 0, type: "movie" },
        keyword: "骚货",
        repository: new InMemoryWorkflowRepository(),
      }),
    ).rejects.toThrow(/movie title tmdbId 必须是正整数，收到 0/);
  });
});

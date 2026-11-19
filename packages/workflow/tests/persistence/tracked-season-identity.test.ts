import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository } from "../../src/persistence/repository.js";
import type { MediaTitle, TrackedSeason } from "../../src/domain/domain.js";
import { SYNTHETIC_TITLE_ID_PREFIX } from "../../src/domain/tracked-identity.js";
import { workflowPersistenceFixture } from "../fixtures/workflow-fixtures.js";

/**
 * 「已追踪季」读取层的身份收口。
 *
 * 事故原型（2026-11-19 生产实测）：投放的合成标题（tmdbId=0）混进
 * `listTrackedSeasonStates`，于是影视库海报墙出现了「骚货 · 0 已获 0/2 集」，
 * 点进去是 `/show/0` → 500；`listAllTrackedSeasonStates`（每日巡检的输入）
 * 同样包含它，巡检于是对一条没有作品的记录发起 `movie_init`。
 *
 * 修复把判据放在读取层（`isTrackedTitleIdentity`），因为至少 12 个调用点消费
 * 这两个方法——在 UI 逐处判等于制造 12 份不一致的机会。
 */

const ACCOUNT = "acct_1";
const DRIVE = "cs_1";

/** 真实电影季。 */
function realMovieSeason(id: string): { title: MediaTitle; season: TrackedSeason } {
  const base = workflowPersistenceFixture();
  return {
    title: { ...base.title, id, tmdbId: 941132, type: "movie", title: "A Real Movie" },
    season: { ...base.season, id: `${id}_movie`, mediaTitleId: id },
  };
}

/** 投放记录的合成标题季（tmdbId=0，id 带合成前缀）。 */
function syntheticSeason(keyword: string): { title: MediaTitle; season: TrackedSeason } {
  const base = workflowPersistenceFixture();
  const titleId = `${SYNTHETIC_TITLE_ID_PREFIX}${DRIVE}_${keyword}`;
  return {
    title: {
      ...base.title,
      id: titleId,
      tmdbId: 0,
      type: "movie",
      title: keyword,
      originalTitle: keyword,
      year: 0,
    },
    season: { ...base.season, id: `${titleId}_movie`, mediaTitleId: titleId },
  };
}

async function seed(
  repository: InMemoryWorkflowRepository,
  entry: { title: MediaTitle; season: TrackedSeason },
  runId: string,
): Promise<void> {
  const base = workflowPersistenceFixture();
  await repository.saveWorkflowRunSnapshot({
    accountId: ACCOUNT,
    connectedStorageId: DRIVE,
    title: entry.title,
    season: entry.season,
    workflowRun: {
      ...base.workflowRun,
      id: runId,
      kind: "movie_init",
      status: "succeeded",
      trackedSeasonId: entry.season.id,
    },
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

describe("已追踪季读取层的身份收口", () => {
  it("listTrackedSeasonStates 不返回合成标题（海报墙的输入）", async () => {
    const repository = new InMemoryWorkflowRepository();
    await seed(repository, realMovieSeason("tmdb_movie_941132"), "run_real");
    await seed(repository, syntheticSeason("骚货"), "run_synth");

    const states = await repository.listTrackedSeasonStates({
      accountId: ACCOUNT,
      connectedStorageId: DRIVE,
    });

    expect(states.map((state) => state.title.id)).toEqual(["tmdb_movie_941132"]);
    expect(states.every((state) => state.title.tmdbId > 0)).toBe(true);
  });

  it("listAllTrackedSeasonStates 不返回合成标题（每日巡检的输入）", async () => {
    const repository = new InMemoryWorkflowRepository();
    await seed(repository, realMovieSeason("tmdb_movie_941132"), "run_real");
    await seed(repository, syntheticSeason("骚货"), "run_synth");

    const all = await repository.listAllTrackedSeasonStates();

    expect(all.map((state) => state.title.id)).toEqual(["tmdb_movie_941132"]);
  });

  it("getTrackedSeasonState(合成季) → null（详情页/取消追踪按 tmdbId 语义取状态）", async () => {
    const repository = new InMemoryWorkflowRepository();
    const synth = syntheticSeason("骚货");
    await seed(repository, synth, "run_synth");

    expect(
      await repository.getTrackedSeasonState(synth.season.id, {
        accountId: ACCOUNT,
        connectedStorageId: DRIVE,
      }),
    ).toBeNull();
  });

  it("真实作品的三个读取入口都照常返回（没把闸门做成「全拒」）", async () => {
    const repository = new InMemoryWorkflowRepository();
    const real = realMovieSeason("tmdb_movie_941132");
    await seed(repository, real, "run_real");
    const scope = { accountId: ACCOUNT, connectedStorageId: DRIVE };

    expect((await repository.listTrackedSeasonStates(scope)).length).toBe(1);
    expect((await repository.listAllTrackedSeasonStates()).length).toBe(1);
    expect((await repository.getTrackedSeasonState(real.season.id, scope))?.title.id).toBe(
      "tmdb_movie_941132",
    );
  });

  it("只放合成标题时，三个入口全空（不是「漏一条」，而是「一条都不该有」）", async () => {
    const repository = new InMemoryWorkflowRepository();
    await seed(repository, syntheticSeason("骚货"), "run_synth");
    const scope = { accountId: ACCOUNT, connectedStorageId: DRIVE };

    expect(await repository.listTrackedSeasonStates(scope)).toEqual([]);
    expect(await repository.listAllTrackedSeasonStates()).toEqual([]);
    expect(
      await repository.getTrackedSeasonState(syntheticSeason("骚货").season.id, scope),
    ).toBeNull();
  });
});

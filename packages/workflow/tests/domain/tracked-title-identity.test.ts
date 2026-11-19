import { describe, expect, it } from "vitest";
import { isTrackedTitleIdentity, SYNTHETIC_TITLE_ID_PREFIX } from "../../src/domain/tracked-identity.js";

/**
 * 「这条记录的作品身份能否用于已追踪作品语义」的唯一判据。
 *
 * 事故原型（2026-11-19 生产实测）：站长「关键字投放」在只给关键字时写一条合成
 * `MediaTitle`（`tmdbId: 0`、id 形如 `owner_ingest_<storage>_<keyword>`）承载 run
 * 记录。读取层只排掉了 `resource_search`，于是它出现在影视库海报墙、被巡检当成
 * 电影去 `movie_init`、点进去落在 `/show/0` 并在 `buildMovieCandidateId` 抛错，
 * 整页 500。
 *
 * 本判据的两个条件缺一不可，下面的用例逐条钉死。
 */
describe("isTrackedTitleIdentity", () => {
  it("真实作品（tmdb_tv_95479）→ true", () => {
    expect(isTrackedTitleIdentity({ id: "tmdb_tv_95479", tmdbId: 95479 })).toBe(true);
  });

  it("真实电影（tmdb_movie_11308）→ true", () => {
    expect(isTrackedTitleIdentity({ id: "tmdb_movie_11308", tmdbId: 11308 })).toBe(true);
  });

  it("豆辨来源（douban_movie_123）→ true（来源前缀不影响判定）", () => {
    expect(isTrackedTitleIdentity({ id: "douban_movie_123", tmdbId: 123 })).toBe(true);
  });

  it("投放合成标题（owner_ingest_* + tmdbId=0）→ false", () => {
    expect(
      isTrackedTitleIdentity({ id: `${SYNTHETIC_TITLE_ID_PREFIX}cs_340802261_骚货`, tmdbId: 0 }),
    ).toBe(false);
  });

  it("tmdbId=0 即便 id 看起来像真实作品 → false（哨兵值本身就不能当作品）", () => {
    // 未来若有人给合成标题塞一个假 id，`> 0` 这一条仍要挡住。
    expect(isTrackedTitleIdentity({ id: "tmdb_movie_0", tmdbId: 0 })).toBe(false);
  });

  it("合成前缀 + 正 tmdbId → false（防止合成标题被塞入假 id 时静默放行）", () => {
    expect(
      isTrackedTitleIdentity({ id: `${SYNTHETIC_TITLE_ID_PREFIX}cs_x_whatever`, tmdbId: 12345 }),
    ).toBe(false);
  });

  it("负数 / 小数 / NaN / Infinity → false", () => {
    expect(isTrackedTitleIdentity({ id: "tmdb_movie_-1", tmdbId: -1 })).toBe(false);
    expect(isTrackedTitleIdentity({ id: "tmdb_movie_1", tmdbId: 1.5 })).toBe(false);
    expect(isTrackedTitleIdentity({ id: "tmdb_movie_1", tmdbId: Number.NaN })).toBe(false);
    expect(isTrackedTitleIdentity({ id: "tmdb_movie_1", tmdbId: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

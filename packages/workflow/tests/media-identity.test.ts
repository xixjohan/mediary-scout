import { describe, expect, it } from "vitest";
import {
  buildMovieCandidateId,
  buildTitleId,
  buildTrackedSeasonId,
  buildTvCandidateId,
  isMediaSource,
  MEDIA_SOURCES,
  assertExhaustive,
  parseMovieCandidateId,
  parseTitleId,
  parseTrackedSeasonId,
  parseTvCandidateId,
  type MediaSource,
  type MediaTitleId,
} from "../src/media-identity.js";

describe("MediaSource", () => {
  it("**今天只有 tmdb**——加第二个源是显式动作，不是顺手加个字符串", () => {
    expect(MEDIA_SOURCES).toEqual(["tmdb"]);
  });

  it("**isMediaSource 拒绝未知来源**（未来 douban_ 开头的旧行不会蒙对）", () => {
    expect(isMediaSource("tmdb")).toBe(true);
    expect(isMediaSource("douban")).toBe(false);
    expect(isMediaSource("")).toBe(false);
    expect(isMediaSource("TMDB")).toBe(false);
  });

  it("**联合类型收口在 never**：加第二个成员时编译报错", () => {
    expect(sourceLabel("tmdb")).toBe("tmdb");
  });
});

/**
 * 编译期穷尽性断言。
 *
 * `MediaSource` 若是窄联合，`default` 分支的 `source` 被收窄成 `never`，传给
 * `assertExhaustive(source: never)` 合法；一旦有人把它宽化成 `string`，或加了成员却
 * 没在这分支，`default` 收到 `string` ⇒ TS2345。
 *
 * **这条的证据来自 tsc，不是 vitest**——oxc/vitest 不做类型检查，跑得再绿也证明不了
 * 类型没收口。提交说明里记了对应变异：把 `MediaSource` 改成 `string` 后 vitest
 * 13 条全绿（假绿），而 `tsc --noEmit` 报 TS2345。
 */
function sourceLabel(source: MediaSource): string {
  switch (source) {
    case "tmdb":
      return "tmdb";
    default:
      return assertExhaustive(source);
  }
}

describe("builder", () => {
  it("**格式契约**（全仓只有这一处断言字面量格式，其余测试都用 builder 产出期望值）", () => {
    expect(buildTitleId({ source: "tmdb", mediaKind: "tv", id: 283428 })).toBe("tmdb_tv_283428");
    expect(buildTitleId({ source: "tmdb", mediaKind: "movie", id: 238 })).toBe("tmdb_movie_238");
    expect(buildMovieCandidateId({ source: "tmdb", id: 238 })).toBe("tmdb_movie_238");
    expect(buildTvCandidateId({ source: "tmdb", id: 283428, seasonNumber: 1 })).toBe(
      "tmdb_tv_283428_s1",
    );
    expect(buildTrackedSeasonId({ source: "tmdb", id: 283428, seasonNumber: 1 })).toBe(
      "tmdb_tv_283428_s1",
    );
  });

  it("**拒绝非法 id**：非整数、0、负数、NaN 都造不出来（造出来就是另一个 id）", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildTitleId({ source: "tmdb", mediaKind: "tv", id: bad })).toThrow();
      expect(() => buildTvCandidateId({ source: "tmdb", id: bad, seasonNumber: 1 })).toThrow();
    }
    for (const badSeason of [0, -3, 2.5, Number.NaN]) {
      expect(() =>
        buildTvCandidateId({ source: "tmdb", id: 283428, seasonNumber: badSeason }),
      ).toThrow();
    }
  });
});

describe("parser：失败必须是显式的判别联合，不是裸 null", () => {
  it("**合法 id 往返恒等**", () => {
    const title = buildTitleId({ source: "tmdb", mediaKind: "tv", id: 283428 });
    const parsedTitle = parseTitleId(title);
    expect(parsedTitle.ok).toBe(true);
    if (!parsedTitle.ok) return;
    expect(parsedTitle.value).toEqual({ source: "tmdb", mediaKind: "tv", id: 283428 });
    expect(buildTitleId(parsedTitle.value)).toBe(title);

    const season = buildTvCandidateId({ source: "tmdb", id: 283428, seasonNumber: 12 });
    const parsedSeason = parseTvCandidateId(season);
    expect(parsedSeason.ok).toBe(true);
    if (!parsedSeason.ok) return;
    expect(parsedSeason.value).toEqual({ source: "tmdb", id: 283428, seasonNumber: 12 });
    expect(buildTvCandidateId(parsedSeason.value)).toBe(season);
  });

  it("**核心防的静默误匹配**：trackedSeason id 喂给 parseTitleId 必须失败", () => {
    const season = buildTrackedSeasonId({ source: "tmdb", id: 283428, seasonNumber: 1 });
    const r = parseTitleId(season);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not_a_title_id");
  });

  it("**movie 与 tv 不混**：互相喂必须失败", () => {
    const movie = buildMovieCandidateId({ source: "tmdb", id: 238 });
    const r = parseTvCandidateId(movie);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not_a_tv_candidate_id");
  });

  it("**未知来源报 unknown_source**（不是 null，不会被当成「查无此片」）", () => {
    const r = parseTitleId("douban_1295644" as MediaTitleId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown_source");
  });

  it("**畸形输入报 malformed**：空串、非数字、只有前缀、前后空白", () => {
    for (const bad of ["", "tmdb_tv_", "tmdb_tv_abc", "tmdb_tv_28 3428", " tmdb_tv_283428 "]) {
      const r = parseTitleId(bad as MediaTitleId);
      expect(r.ok, bad).toBe(false);
      if (r.ok) continue;
      expect(["malformed", "not_a_title_id"], bad).toContain(r.reason);
    }
  });

  it("**数字形态边界**：00 / 1e3 / 超长串 不构成合法 id", () => {
    for (const bad of ["tmdb_tv_00", "tmdb_tv_1e3", "tmdb_tv_" + "9".repeat(40)]) {
      const r = parseTitleId(bad as MediaTitleId);
      expect(r.ok, bad).toBe(false);
    }
  });

  it("**每个失败都带原因字符串**（调用方要能记日志）", () => {
    const cases: Array<[string, string]> = [
      ["", "malformed"],
      ["douban_1", "unknown_source"],
      ["tmdb_tv_283428_s1", "not_a_title_id"],
    ];
    for (const [input, reason] of cases) {
      const r = parseTitleId(input as MediaTitleId);
      expect(r.ok, input).toBe(false);
      if (r.ok) continue;
      expect(r.reason, input).toBe(reason);
      expect(typeof r.reason).toBe("string");
    }
  });
});

describe("trackedSeasonId 与 tvCandidateId 同格式但语义不同", () => {
  it("**两者互相可解析**（今天格式相同，这是事实不是疏漏）", () => {
    const season = buildTrackedSeasonId({ source: "tmdb", id: 283428, seasonNumber: 3 });
    const asCandidate = parseTvCandidateId(season);
    expect(asCandidate.ok).toBe(true);
  });
});

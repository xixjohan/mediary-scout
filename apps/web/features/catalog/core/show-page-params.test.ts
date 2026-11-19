import { describe, expect, it } from "vitest";
import { parseTmdbIdParam, resolveShowPageParams } from "./show-page-params";

/**
 * `/show/[tmdbId]` 的查询参数解析。
 *
 * 抽成纯函数的动机见实现文件的注释；这里钉住的是**四个真会出错的分支**：
 * `from` 只认 search|library（别的值必须落 null，而不是透传给返回按钮）、
 * 三个参数都要吃掉 `string[]` 形态（同一 query key 重复出现时 Next 给数组）、
 * `t` 只认三个枚举值（把 `?t=garbage` 透传会让 TMDB 命名空间判断失效）。
 */

describe("resolveShowPageParams", () => {
  it("from 只认 search | library；其他值落 null（返回按钮不能收到野生值）", () => {
    expect(resolveShowPageParams({ from: "search" }).from).toBe("search");
    expect(resolveShowPageParams({ from: "library" }).from).toBe("library");
    for (const bad of ["", "Search", "detail", undefined]) {
      expect(resolveShowPageParams(bad === undefined ? {} : { from: bad }).from).toBeNull();
    }
  });

  it("t 只认 movie | tv | anime；其他值落 undefined（不把野生值当命名空间）", () => {
    expect(resolveShowPageParams({ t: "movie" }).mediaTypeHint).toBe("movie");
    expect(resolveShowPageParams({ t: "tv" }).mediaTypeHint).toBe("tv");
    expect(resolveShowPageParams({ t: "anime" }).mediaTypeHint).toBe("anime");
    expect(resolveShowPageParams({ t: "person" }).mediaTypeHint).toBeUndefined();
    expect(resolveShowPageParams({}).mediaTypeHint).toBeUndefined();
  });

  it("w / q / t 支持 string[] 形态（同一 query key 重复时 Next 给数组）", () => {
    const parsed = resolveShowPageParams({
      w: ["cs_first", "cs_second"],
      q: ["星际", "另一部"],
      t: ["tv", "movie"],
    });
    expect(parsed.activeStorageParam).toBe("cs_first");
    expect(parsed.searchQuery).toBe("星际");
    expect(parsed.mediaTypeHint).toBe("tv");
  });

  it("空对象 ⇒ 全部缺省（不抛、不产生空字符串）", () => {
    expect(resolveShowPageParams({})).toEqual({
      from: null,
      activeStorageParam: undefined,
      searchQuery: undefined,
      mediaTypeHint: undefined,
    });
  });
});

/**
 * `/show/<段>` → TMDB id 的解析。
 *
 * 事故原型（2026-11-19 生产实测）：`Number.isInteger(0)` 为真，页面只判整数时
 * `/show/0` 会被当成一部电影走到底，最后在 `buildMovieCandidateId` 抛
 * 「movie candidate id 必须是正整数」，整页 500。TMDB 没有 0 号，纯解析层
 * 拒掉它不需要任何额外信息，也不会误伤真实作品。
 */
describe("parseTmdbIdParam", () => {
  it("正整数 → 数字", () => {
    expect(parseTmdbIdParam("95479")).toBe(95479);
    expect(parseTmdbIdParam("1")).toBe(1);
  });

  it("0 / 负数 / 小数 / 非数字 / 空串 → null（哨兵值不是作品）", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "", "  ", "NaN", "Infinity"]) {
      expect(parseTmdbIdParam(bad), `raw=${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

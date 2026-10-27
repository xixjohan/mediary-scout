import { describe, expect, it } from "vitest";
import { parseOrganizeRequestBody } from "./route";

/**
 * Batch 4 的 HTTP 门。
 *
 * 只测 parseOrganizeRequestBody：整条 POST 要接仓储、executor 和网盘，那部分的断言在
 * organize-run / organize-executor 里已经做过了。这里守的是「什么样的请求算合法」——
 * 尤其 seasonNumber 的缺席与误用。
 */

describe("parseOrganizeRequestBody", () => {
  it("只要 tmdbId（正整数）", () => {
    expect(parseOrganizeRequestBody({ tmdbId: 1396 })).toEqual({ ok: true, tmdbId: 1396 });
  });

  it("**seasonNumber 可以缺席**（电影没有季）", () => {
    const parsed = parseOrganizeRequestBody({ tmdbId: 1396 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.seasonNumber).toBeUndefined();
  });

  it("seasonNumber 在场时必须是正整数", () => {
    expect(parseOrganizeRequestBody({ tmdbId: 1396, seasonNumber: 1 })).toEqual({
      ok: true,
      tmdbId: 1396,
      seasonNumber: 1,
    });
    for (const bad of [0, -1, 1.5, "1", null, true, {}]) {
      expect(parseOrganizeRequestBody({ tmdbId: 1396, seasonNumber: bad }).ok).toBe(false);
    }
  });

  it("tmdbId 缺失或非正整数 ⇒ 拒绝", () => {
    for (const bad of [undefined, null, 0, -5, 1.5, "1396", true, []]) {
      const parsed = parseOrganizeRequestBody({ tmdbId: bad });
      expect(parsed.ok).toBe(false);
    }
  });

  it("非对象 ⇒ invalid body", () => {
    for (const bad of [null, undefined, 42, "x"]) {
      expect(parseOrganizeRequestBody(bad)).toEqual({ ok: false, error: "invalid body" });
    }
  });

  it("**数组也是 object** ⇒ 走到字段判定，仍是拒绝", () => {
    // 数组没有 tmdbId，所以报的是字段错而不是形态错。两种都拒绝，只是文案不同——
    // 这里把差别钉住，免得以后有人以为数组会被认成「非法请求体」而放松对它的断言。
    const parsed = parseOrganizeRequestBody([]);
    expect(parsed.ok).toBe(false);
    expect(parsed).toEqual({ ok: false, error: "tmdbId must be a positive integer" });
  });

  it("**tmdbId 与 seasonNumber 各自独立判定**（一个合法不救另一个）", () => {
    // 这条钉住的是「别因为 tmdbId 对就放过 seasonNumber」
    expect(parseOrganizeRequestBody({ tmdbId: 1396, seasonNumber: "2" }).ok).toBe(false);
    expect(parseOrganizeRequestBody({ tmdbId: "1396", seasonNumber: 2 }).ok).toBe(false);
  });
});

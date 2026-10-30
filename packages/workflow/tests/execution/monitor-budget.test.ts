import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_MONITORED_SEASONS,
  MAX_MONITORED_SEASONS_CEILING,
  checkMonitoredSeasonBudget,
  resolveMaxMonitoredSeasons,
} from "../../src/monitor-budget.js";

/**
 * Batch 5 的成本模型护栏（plan §4.1：「监控季数上限应做成配置项并默认保守（如 50），
 * 超限明确告知而非默默拖垮巡检」）。
 *
 * 主线断言：**超限必须说出来，且说的话能让人知道该做什么。** 一个只给数字的提示
 * （"402"）不告诉运维该上调上限还是停订——所以 message 是契约的一部分，不是装饰。
 */

describe("resolveMaxMonitoredSeasons", () => {
  it("默认 50（plan 点名的保守值）", () => {
    expect(DEFAULT_MAX_MONITORED_SEASONS).toBe(50);
    expect(resolveMaxMonitoredSeasons(undefined)).toBe(50);
    expect(resolveMaxMonitoredSeasons(null)).toBe(50);
  });

  it("合法值照用", () => {
    expect(resolveMaxMonitoredSeasons(20)).toBe(20);
    expect(resolveMaxMonitoredSeasons(120)).toBe(120);
    expect(resolveMaxMonitoredSeasons("80")).toBe(80);
  });

  it("**非正整数回落到默认**（不是 0，也不是无限）", () => {
    // 回落成 0 会让所有标题立刻超限；回落成无限等于关掉护栏
    for (const bad of [0, -1, 1.5, Number.NaN, "abc", "", "  ", true, {}]) {
      expect(resolveMaxMonitoredSeasons(bad as unknown as number)).toBe(50);
    }
  });

  it("**超过硬上限被夹住**（打错的配置不能关掉护栏）", () => {
    expect(MAX_MONITORED_SEASONS_CEILING).toBe(500);
    expect(resolveMaxMonitoredSeasons(99999)).toBe(500);
    expect(resolveMaxMonitoredSeasons("100000")).toBe(500);
  });
});

describe("checkMonitoredSeasonBudget — 在限额内", () => {
  it("withinBudget，且**静默**（成功就是没有消息）", () => {
    const budget = checkMonitoredSeasonBudget({ count: 12, configured: 50 });
    expect(budget.withinBudget).toBe(true);
    expect(budget.overBy).toBe(0);
    expect(budget.message).toBe("");
  });

  it("恰好等于上限算在内", () => {
    expect(checkMonitoredSeasonBudget({ count: 50, configured: 50 }).withinBudget).toBe(true);
  });

  it("0 个也算在内", () => {
    expect(checkMonitoredSeasonBudget({ count: 0 }).withinBudget).toBe(true);
  });
});

describe("checkMonitoredSeasonBudget — 超限必须说出来", () => {
  const budget = checkMonitoredSeasonBudget({ count: 402, configured: 50 });

  it("withinBudget 为 false，overBy 正确", () => {
    expect(budget.withinBudget).toBe(false);
    expect(budget.overBy).toBe(352);
    expect(budget.limit).toBe(50);
  });

  it("**消息点名两个数**（实际值与上限）", () => {
    expect(budget.message).toContain("402");
    expect(budget.message).toContain("50");
  });

  it("**消息给出两条出路**（上调上限 / 停订一部分）", () => {
    expect(budget.message).toContain("上调上限");
    expect(budget.message).toContain("停订");
  });

  it("**消息解释为什么超限危险**（拖垮巡检而非报错）", () => {
    expect(budget.message).toContain("拖垮巡检");
  });

  it("给了每日搜索次数就算出增量成本", () => {
    const withEstimate = checkMonitoredSeasonBudget({ count: 60, configured: 50, searchesPerDay: 2 });
    // 多 10 季 × 每日 2 次 = 20 次/日额外搜索
    expect(withEstimate.message).toContain("20 次/日");
  });

  it("没给每日搜索次数时不算估算（不编一个数）", () => {
    expect(budget.message).not.toContain("次/日");
  });

  it("**超限用默认上限判**（配置缺失时护栏仍在）", () => {
    const fallback = checkMonitoredSeasonBudget({ count: 51, configured: null });
    expect(fallback.withinBudget).toBe(false);
    expect(fallback.limit).toBe(DEFAULT_MAX_MONITORED_SEASONS);
  });
});

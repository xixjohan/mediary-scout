import { describe, expect, it } from "vitest";
import type { AgentStep } from "../../src/domain.js";
import { MAX_TIMELINE_STEPS, tailAgentStepViews, toAgentStepViews } from "../../src/agent-step-view.js";

/**
 * L1 时间线的投影层。
 *
 * 最强断言不是逐字段，而是**敌意 args 深扫**：构造一个 args 里塞满 cookie/URL 的
 * step，投影后对整个结果做 URL 形态与凭证标记扫描。plan 把脱敏列为「本方案安全风险
 * 最高的一项」——「一个登录态用户就能在 UI 里看到自己的网盘 cookie」——所以这里的
 * 断言必须是结果级的，不是字段级的。
 */

function step(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    ordinal: 1,
    toolName: "search",
    args: {},
    activity: "搜索 孤独摇滚",
    phase: "search",
    at: "2024-05-01T10:00:00Z",
    ...overrides,
  };
}

const URL_SHAPE = /(?:https?|magnet):\/\/|ed2k:\/\//i;

describe("toAgentStepViews — 展示字段原样透传", () => {
  it("ordinal/toolName/activity/phase/at 不改，apiCalls 可选", () => {
    const views = toAgentStepViews([
      step({ ordinal: 1, apiCalls: 7 }),
      step({ ordinal: 2 }),
    ]);
    expect(views[0]).toMatchObject({
      ordinal: 1,
      toolName: "search",
      activity: "搜索 孤独摇滚",
      phase: "search",
      at: "2024-05-01T10:00:00Z",
      apiCalls: 7,
    });
    // 没上报 apiCalls 的 step 不带这个键（不塞 undefined）
    expect(views[1]).not.toHaveProperty("apiCalls");
  });

  it("不修改入参", () => {
    const steps = [step({ args: { cookie: "UID=1" } })];
    const before = JSON.parse(JSON.stringify(steps)) as AgentStep[];
    toAgentStepViews(steps);
    expect(steps).toEqual(before);
  });
});

describe("toAgentStepViews — args 脱敏（结果级断言）", () => {
  it("敌意 args 投影后不含 URL 形态，也不含凭证标记", () => {
    const hostile = step({
      args: {
        cookie: "UID=1_C1_2;CID=abc;SEID=def",
        refreshToken: "rt_leak",
        url: "https://115.com/s/swxy8ab",
        shareLink: "https://115.com/s/other",
        nested: { deep: { url: "https://x.example/s", token: "t" } },
        list: ["https://y.example/s", "magnet:?xt=urn:btih:cafe"],
      },
    });
    const serialized = JSON.stringify(toAgentStepViews([hostile]));
    expect(serialized).not.toMatch(URL_SHAPE);
    expect(serialized).not.toContain("UID=1_C1_2");
    expect(serialized).not.toContain("rt_leak");
    expect(serialized).not.toContain("swxy8ab");
  });

  it("诊断字段保留（关键词/集数/candidateId）——时间线要能复盘", () => {
    const views = toAgentStepViews([
      step({ args: { keyword: "孤独摇滚", episodes: ["S01E13"], candidateId: "cand-1" } }),
    ]);
    expect(views[0]!.args).toEqual({ keyword: "孤独摇滚", episodes: ["S01E13"], candidateId: "cand-1" });
  });
});

describe("tailAgentStepViews — 有界时间线", () => {
  it("默认取最后 50 条", () => {
    const many = Array.from({ length: 120 }, (_, i) => step({ ordinal: i + 1 }));
    const tail = tailAgentStepViews(many);
    expect(tail).toHaveLength(MAX_TIMELINE_STEPS);
    expect(tail[0]!.ordinal).toBe(71);
    expect(tail[tail.length - 1]!.ordinal).toBe(120);
  });

  it("不足上限时全给", () => {
    expect(tailAgentStepViews([step(), step({ ordinal: 2 })])).toHaveLength(2);
  });

  it("limit 可覆盖；0 与负数不当成无限", () => {
    expect(tailAgentStepViews([step(), step({ ordinal: 2 })], 1)).toHaveLength(1);
    expect(tailAgentStepViews([step(), step({ ordinal: 2 })], 0)).toHaveLength(0);
    expect(tailAgentStepViews([step(), step({ ordinal: 2 })], -5)).toHaveLength(0);
  });

  it("空输入不炸", () => {
    expect(tailAgentStepViews([])).toEqual([]);
  });
});

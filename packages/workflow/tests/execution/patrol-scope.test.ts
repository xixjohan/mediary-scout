import { describe, expect, it } from "vitest";
import {
  cooldownLogLine,
  overBudgetLogLine,
  patrolSkipKey,
  planPatrolScope,
  type PatrolCandidate,
  type PolicyLookup,
} from "../../src/patrol-scope.js";
import {
  EMPTY_POLICY,
  type SubscriptionPolicy,
} from "../../src/subscription-policy.js";
import type { StoredSubscriptionPolicy } from "../../src/subscription-policy-store.js";

/**
 * 批次 5 的巡检成本门（plan §4.1 成本模型）。
 *
 * 这个模块存在的原因：`checkMonitoredSeasonBudget` 与 `withinCooldown` 两个护栏此前都是
 * **只有测试、没有调用方**的纯函数——写好了却没人接，等于没有。这里把它们接进巡检，并守住
 * 三条会让它们变成装饰的边界：
 *
 *   ① **没配策略的作品必须照常巡检。** 策略层是 opt-in 的过滤器，不是巡检前的闸门。
 *      跳过没配策略的作品 = 策略层悄悄关掉了所有还没写规则的人的订阅。
 *   ② **超限时仍巡检上限内的部分，并明确告知。** plan 原文：「超限明确告知而非默默拖垮
 *      巡检」。全部跳过会让每个人的订阅一起停。
 *   ③ **冷却按作品独立判定。** 一部的冷却不能连带跳过别的。
 */

const NOW = "2026-09-20T00:00:00.000Z";

function candidate(titleKey: string, titleName = titleKey): PatrolCandidate {
  return { accountId: "acct_a", titleKey, titleName };
}

function stored(overrides: Partial<SubscriptionPolicy> & { lastTakenAt?: string | null } = {}): StoredSubscriptionPolicy {
  const { lastTakenAt = null, ...policy } = overrides;
  return {
    ...EMPTY_POLICY,
    ...policy,
    accountId: "acct_a",
    titleKey: "k",
    createdAt: NOW,
    updatedAt: NOW,
    lastTakenAt,
  };
}

/** A lookup backed by a map; a missing key means "no policy configured". */
function lookupOf(map: Record<string, StoredSubscriptionPolicy>): PolicyLookup {
  return async (candidate) => map[candidate.titleKey] ?? null;
}

describe("planPatrolScope — 没配策略的作品", () => {
  it("**照常巡检**（策略层是 opt-in 过滤器，不是闸门）", async () => {
    const decision = await planPatrolScope({
      candidates: [candidate("k1", "孤独摇滚"), candidate("k2", "药屋少女")],
      lookupPolicy: lookupOf({}),
      now: NOW,
    });
    expect(decision.included.map((c) => c.titleKey)).toEqual(["k1", "k2"]);
    expect(decision.skipped).toEqual([]);
  });

  it("**与「配了空策略」是两回事**（空策略 = 不排除任何东西，仍要巡检）", async () => {
    const decision = await planPatrolScope({
      candidates: [candidate("k1")],
      lookupPolicy: lookupOf({ k1: stored() }),
      now: NOW,
    });
    expect(decision.included).toHaveLength(1);
    expect(decision.skipped).toEqual([]);
  });
});

describe("planPatrolScope — 冷却期", () => {
  const cooling = stored({ cooldownDays: 7, lastTakenAt: "2026-09-18T00:00:00.000Z" });

  it("**冷却中的作品被跳过，并说明原因**", async () => {
    const decision = await planPatrolScope({
      candidates: [candidate("k1", "孤独摇滚")],
      lookupPolicy: lookupOf({ k1: cooling }),
      now: NOW,
    });
    expect(decision.included).toEqual([]);
    expect(decision.skipped).toHaveLength(1);
    expect(decision.skipped[0]).toMatchObject({ reason: "cooldown", titleName: "孤独摇滚" });
    expect(decision.skipped[0]!.detail).toContain("7");
  });

  it("**冷却期满后恢复巡检**（正好 N 天）", async () => {
    const decision = await planPatrolScope({
      candidates: [candidate("k1")],
      lookupPolicy: lookupOf({ k1: stored({ cooldownDays: 2, lastTakenAt: "2026-09-18T00:00:00.000Z" }) }),
      now: NOW,
    });
    expect(decision.included).toHaveLength(1);
    expect(decision.skipped).toEqual([]);
  });

  it("**冷却期是 0 的作品永不被冷却**", async () => {
    const decision = await planPatrolScope({
      candidates: [candidate("k1")],
      lookupPolicy: lookupOf({ k1: stored({ cooldownDays: 0, lastTakenAt: NOW }) }),
      now: NOW,
    });
    expect(decision.included).toHaveLength(1);
  });

  it("**从没匹配过（lastTakenAt 为 null）不被冷却**", async () => {
    const decision = await planPatrolScope({
      candidates: [candidate("k1")],
      lookupPolicy: lookupOf({ k1: stored({ cooldownDays: 30, lastTakenAt: null }) }),
      now: NOW,
    });
    expect(decision.included).toHaveLength(1);
  });

  it("**改短 cooldownDays 立刻放行**（用户收紧/放宽规则不该被旧水位线卡住）", async () => {
    // 7 天前匹配过。原本冷却 30 天，用户改成 2 天 —— 现在应该放行。
    // 这是「改规则后重放」在本架构里唯一有意义的形态：没有未处理历史结果可重放
    // （快照只写不读，每轮重搜），所以规则改动的生效点就是下一轮巡检，而冷却必须
    // 按**当前**的 cooldownDays 算，不是按匹配时的那个值。
    const decision = await planPatrolScope({
      candidates: [candidate("k1")],
      lookupPolicy: lookupOf({ k1: stored({ cooldownDays: 2, lastTakenAt: "2026-09-18T00:00:00.000Z" }) }),
      now: NOW,
    });
    expect(decision.included).toHaveLength(1);
  });

  it("**改长 cooldownDays 立刻挡住**（对称：放宽上限也按当前值算）", async () => {
    const decision = await planPatrolScope({
      candidates: [candidate("k1")],
      lookupPolicy: lookupOf({ k1: stored({ cooldownDays: 30, lastTakenAt: "2026-09-18T00:00:00.000Z" }) }),
      now: NOW,
    });
    expect(decision.skipped).toHaveLength(1);
  });

  it("**一部的冷却不连带跳过别的**", async () => {
    const decision = await planPatrolScope({
      candidates: [candidate("k1", "A"), candidate("k2", "B"), candidate("k3", "C")],
      lookupPolicy: lookupOf({ k2: cooling }),
      now: NOW,
    });
    expect(decision.included.map((c) => c.titleKey)).toEqual(["k1", "k3"]);
    expect(decision.skipped.map((s) => s.titleKey)).toEqual(["k2"]);
  });

  it("**跳过的条目带 accountId**（worker 的过滤键是 (account, title)，缺了它就会按 title 过滤）", async () => {
    const decision = await planPatrolScope({
      candidates: [candidate("k1", "A")],
      lookupPolicy: lookupOf({ k1: cooling }),
      now: NOW,
    });
    expect(decision.skipped).toHaveLength(1);
    expect(decision.skipped[0]).toMatchObject({ accountId: "acct_a", titleKey: "k1" });
    // patrolSkipKey 把两个账号的同名作品分开
    expect(patrolSkipKey(decision.skipped[0]!)).not.toBe(patrolSkipKey({ accountId: "acct_b", titleKey: "k1" }));
  });

  it("**不同 account 的同名作品互不影响**（按 (account, work) 判定）", async () => {
    const a = { ...candidate("k1"), accountId: "acct_a" };
    const b = { ...candidate("k1"), accountId: "acct_b" };
    const lookup: PolicyLookup = async (candidate) =>
      candidate.accountId === "acct_a" ? cooling : null;
    const decision = await planPatrolScope({ candidates: [a, b], lookupPolicy: lookup, now: NOW });
    expect(decision.skipped).toHaveLength(1);
    expect(decision.included).toHaveLength(1);
    expect(decision.included[0]!.accountId).toBe("acct_b");
  });
});

describe("planPatrolScope — 监控季数上限", () => {
  const many = Array.from({ length: 60 }, (_, index) => candidate(`k${index}`, `作品 ${index}`));

  it("**未超限 ⇒ overBudget 为 null**", async () => {
    const decision = await planPatrolScope({
      candidates: [candidate("k1")],
      lookupPolicy: lookupOf({}),
      now: NOW,
    });
    expect(decision.overBudget).toBeNull();
  });

  it("**超限 ⇒ 明确告知，且仍巡检上限内的部分**", async () => {
    const decision = await planPatrolScope({
      candidates: many,
      lookupPolicy: lookupOf({}),
      now: NOW,
    });
    expect(decision.overBudget).not.toBeNull();
    expect(decision.overBudget!.limit).toBe(50);
    expect(decision.overBudget!.overBy).toBe(10);
    // plan：「超限明确告知而非默默拖垮巡检」——全部跳过会让每个人的订阅一起停
    expect(decision.included).toHaveLength(60);
  });

  it("**超限信息点名两个数并给出两条出路**", async () => {
    const decision = await planPatrolScope({
      candidates: many,
      lookupPolicy: lookupOf({}),
      searchesPerDay: 4,
      now: NOW,
    });
    const message = decision.overBudget!.message;
    expect(message).toContain("60");
    expect(message).toContain("50");
    expect(message).toContain("上调");
    expect(message).toContain("停订");
  });

  it("**配了更高的上限就不算超**", async () => {
    const decision = await planPatrolScope({
      candidates: many,
      lookupPolicy: lookupOf({}),
      configuredMaxSeasons: 200,
      now: NOW,
    });
    expect(decision.overBudget).toBeNull();
  });

  it("**非法配置回落保守默认，不是 0 也不是无限**", async () => {
    for (const bad of [0, -5, "abc", null, undefined]) {
      const decision = await planPatrolScope({
        candidates: many,
        lookupPolicy: lookupOf({}),
        ...(bad === undefined ? {} : { configuredMaxSeasons: bad as number }),
        now: NOW,
      });
      expect(decision.overBudget!.limit, `configured=${String(bad)}`).toBe(50);
      expect(decision.included).toHaveLength(60);
    }
  });

  it("**冷却与预算同时作用**（冷却跳过的不占巡检名额，也不影响预算判定）", async () => {
    const coolingMap: Record<string, StoredSubscriptionPolicy> = {};
    for (let index = 0; index < 20; index += 1) {
      coolingMap[`k${index}`] = stored({ cooldownDays: 7, lastTakenAt: "2026-09-19T00:00:00.000Z" });
    }
    const decision = await planPatrolScope({
      candidates: many,
      lookupPolicy: lookupOf(coolingMap),
      now: NOW,
    });
    expect(decision.included).toHaveLength(40);
    expect(decision.skipped).toHaveLength(20);
    // 预算是按**候选总数**判的，不是按实际巡检数——超限要说的是「你监控了太多」，
    // 而冷却只是这一次少搜几部，不改变监控规模。
    expect(decision.overBudget!.overBy).toBe(10);
  });
});

describe("巡检日志行", () => {
  it("未超限 ⇒ 没有预算日志行", () => {
    const decision = { included: [], skipped: [], overBudget: null };
    expect(overBudgetLogLine(decision)).toBeNull();
  });

  it("超限 ⇒ 日志行带上完整建议文案", () => {
    const line = overBudgetLogLine({
      included: [candidate("k1")],
      skipped: [],
      overBudget: { limit: 50, overBy: 10, message: "监控季数 60 超出上限 50" },
    });
    expect(line).toContain("[patrol]");
    expect(line).toContain("60 超出上限 50");
    expect(line).toContain("1"); // 仍巡检的数量
  });

  it("没有冷却跳过 ⇒ 没有冷却日志行", () => {
    expect(cooldownLogLine([])).toBeNull();
    expect(cooldownLogLine([{ accountId: "acct_a", titleKey: "k", titleName: "n", reason: "cooldown", detail: "d" }])).toContain("冷却中");
  });

  it("**冷却日志行点名跳过了哪几部**（默默跳过等于订阅凭空停摆）", () => {
    const line = cooldownLogLine([
      { accountId: "acct_a", titleKey: "k1", titleName: "孤独摇滚", reason: "cooldown", detail: "冷却中（7 天内已匹配过）" },
      { accountId: "acct_a", titleKey: "k2", titleName: "药屋少女", reason: "cooldown", detail: "冷却中（7 天内已匹配过）" },
    ]);
    expect(line).toContain("2");
    expect(line).toContain("孤独摇滚");
    expect(line).toContain("药屋少女");
  });
});

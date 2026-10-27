import { describe, expect, it } from "vitest";
import {
  emptyStoredPolicy,
  parseTermList,
  roundTripPolicy,
  serializeTermList,
  subscriptionPolicyFromRow,
  subscriptionPolicyToColumns,
  type SubscriptionPolicyRow,
} from "../src/subscription-policy-store.js";

/**
 * Batch 5：subscription_policies 的持久化形状（plan 四件套 ③）。
 *
 * 主线断言：**损坏的策略行必须大声失败，而不是降解成「没有策略」。**
 * 空 mustNotContain 的意思是「不排除任何东西」——那正好把用户排除掉的资源落地，
 * 而且看起来像「过滤没开」，静默撤销用户的意图。
 *
 * 这与死链/拒绝记录的方向**相反**（那些对普通巡检 fail-open）：那些防的是「落地一个
 * 已知坏的东西」，而策略表达的是「用户想要什么」——猜它比停下来更糟。
 */

function row(overrides: Partial<SubscriptionPolicyRow> = {}): SubscriptionPolicyRow {
  return {
    account_id: "acct_1",
    title_key: "tmdb_tv_42",
    must_contain: '["2160p"]',
    must_not_contain: '["CAM"]',
    episode_filter: "S01",
    use_regex: 0,
    cooldown_days: 7,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    last_taken_at: null,
    ...overrides,
  };
}

describe("serializeTermList / parseTermList", () => {
  it("往返无损", () => {
    expect(parseTermList(serializeTermList(["2160p", "BluRay"]), "must_contain")).toEqual(["2160p", "BluRay"]);
  });

  it("**空数组是合法且有意义的值**（不是错误）", () => {
    // 「没有词」和「词读不出来」是两件事
    expect(parseTermList("[]", "must_contain")).toEqual([]);
  });

  it("**首尾空白被 trim**（用户粘贴多行值时会带上）", () => {
    expect(serializeTermList([" 2160p ", "BluRay"])).toBe('["2160p","BluRay"]');
  });

  it("**坏 JSON ⇒ 抛错**（不是降解成空数组）", () => {
    expect(() => parseTermList("{not json", "must_contain")).toThrow(/not valid JSON/);
  });

  it("**JSON 但不是数组 ⇒ 抛错**", () => {
    expect(() => parseTermList('"2160p"', "must_contain")).toThrow(/not an array/);
    expect(() => parseTermList('{"a":1}', "must_contain")).toThrow(/not an array/);
  });

  it("**数组里有非字符串 ⇒ 抛错**", () => {
    expect(() => parseTermList('[2160]', "must_contain")).toThrow(/non-string term/);
    expect(() => parseTermList('[null]', "must_contain")).toThrow(/non-string term/);
  });

  it("**报错点名列名**（否则不知道是哪一列坏了）", () => {
    expect(() => parseTermList("x", "must_not_contain")).toThrow(/must_not_contain/);
  });
});

describe("subscriptionPolicyFromRow", () => {
  it("读出一个完整策略", () => {
    const policy = subscriptionPolicyFromRow(row());
    expect(policy).toMatchObject({
      accountId: "acct_1",
      titleKey: "tmdb_tv_42",
      mustContain: ["2160p"],
      mustNotContain: ["CAM"],
      episodeFilter: "S01",
      useRegex: false,
      cooldownDays: 7,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("use_regex 1 ⇒ true，0 ⇒ false", () => {
    expect(subscriptionPolicyFromRow(row({ use_regex: 1 })).useRegex).toBe(true);
    expect(subscriptionPolicyFromRow(row({ use_regex: 0 })).useRegex).toBe(false);
  });

  it("**use_regex 是别的值 ⇒ false**（不是 truthy 混过去）", () => {
    // SQLite 没有布尔量；把 2/"true" 当成真会静默改掉策略语义
    expect(subscriptionPolicyFromRow(row({ use_regex: 2 })).useRegex).toBe(false);
    expect(subscriptionPolicyFromRow(row({ use_regex: Number.NaN })).useRegex).toBe(false);
  });

  it("**坏行 ⇒ 抛错，且说得出是哪一列**", () => {
    expect(() => subscriptionPolicyFromRow(row({ must_not_contain: "oops" }))).toThrow(/must_not_contain/);
    expect(() => subscriptionPolicyFromRow(row({ must_contain: "5" }))).toThrow(/must_contain/);
  });
});

describe("subscriptionPolicyToColumns", () => {
  it("写出的列值可读回", () => {
    const columns = subscriptionPolicyToColumns({
      mustContain: ["2160p"],
      mustNotContain: ["CAM"],
      episodeFilter: "S01-S03",
      useRegex: true,
      cooldownDays: 7,
    });
    expect(columns).toEqual({
      must_contain: '["2160p"]',
      must_not_contain: '["CAM"]',
      episode_filter: "S01-S03",
      use_regex: 1,
      cooldown_days: 7,
    });
  });

  it("useRegex false ⇒ 0", () => {
    expect(subscriptionPolicyToColumns({ mustContain: [], mustNotContain: [], episodeFilter: "", useRegex: false, cooldownDays: 0 }).use_regex).toBe(0);
  });

  it("空词表写出 `[]` 而不是 null", () => {
    // null 会让每次读取都要特判
    const columns = subscriptionPolicyToColumns({ mustContain: [], mustNotContain: [], episodeFilter: "", useRegex: false, cooldownDays: 0 });
    expect(columns.must_contain).toBe("[]");
    expect(columns.must_not_contain).toBe("[]");
  });
});

describe("roundTripPolicy — 用户存的必须原样回来", () => {
  it("**五个字段全部无损**", () => {
    const policy = {
      mustContain: ["2160p", "BluRay"],
      mustNotContain: ["CAM", "枪版"],
      episodeFilter: "S01-S03;E01-E10",
      useRegex: true,
      cooldownDays: 14,
    };
    expect(roundTripPolicy(policy)).toEqual(policy);
  });

  it("**useRegex 翻转后仍能分辨**（布尔不会被 0/1 吃掉）", () => {
    const base = { mustContain: [], mustNotContain: [], episodeFilter: "", cooldownDays: 0 };
    expect(roundTripPolicy({ ...base, useRegex: true }).useRegex).toBe(true);
    expect(roundTripPolicy({ ...base, useRegex: false }).useRegex).toBe(false);
  });

  it("**空 episodeFilter 往返后仍是空串**（不是 null/undefined）", () => {
    const back = roundTripPolicy({ mustContain: [], mustNotContain: [], episodeFilter: "", useRegex: false, cooldownDays: 0 });
    expect(back.episodeFilter).toBe("");
  });
});

describe("emptyStoredPolicy", () => {
  it("是一个全空策略，但带作用域与时间戳", () => {
    const policy = emptyStoredPolicy({ accountId: "acct_1", titleKey: "tmdb_tv_42", now: "2026-01-01T00:00:00.000Z" });
    expect(policy).toEqual({
      accountId: "acct_1",
      titleKey: "tmdb_tv_42",
      mustContain: [],
      mustNotContain: [],
      episodeFilter: "",
      useRegex: false,
      cooldownDays: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      // 冷却期水位线：一个从没匹配过的策略是 null，不是空串（空串 Date.parse 成 NaN，
      // 而 withinCooldown 对读不出的时间戳 fail-open —— 那会把冷却悄悄关掉）。
      lastTakenAt: null,
    });
  });

  it("**缺 last_taken_at 列的行归一成 null**（SQLite 对缺失列给 undefined，不是 null）", () => {
    // SubscriptionPolicyRow 的类型写的是 string | null，但 SQLite 对**不存在的列**返回
    // undefined —— 类型在这件事上是谎。undefined !== null，而 withinCooldown 只对 null
    // fail-open，所以一个未补列的旧库会让冷却静默失效。
    //
    // 正常路径已由 upgradeSubscriptionPolicyShape 保证列一定在；这一条守的是
    // 「万一没补上」：fromRow 自己不能再把这个坑挖深。
    const row = {
      account_id: "a",
      title_key: "t",
      must_contain: "[]",
      must_not_contain: "[]",
      episode_filter: "",
      use_regex: 0,
      cooldown_days: 7,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    } as unknown as SubscriptionPolicyRow;
    expect(subscriptionPolicyFromRow(row).lastTakenAt).toBeNull();
    // 有值时必须原样穿过，不能被归一成 null
    expect(subscriptionPolicyFromRow({ ...row, last_taken_at: "2026-01-02T00:00:00.000Z" }).lastTakenAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });

  it("**空策略匹配一切**（没配过规则不该挡掉任何东西）", () => {
    const policy = emptyStoredPolicy({ accountId: "a", titleKey: "t", now: "n" });
    expect(policy.mustContain).toEqual([]);
    expect(policy.mustNotContain).toEqual([]);
    expect(policy.episodeFilter).toBe("");
    expect(policy.cooldownDays).toBe(0);
  });
});

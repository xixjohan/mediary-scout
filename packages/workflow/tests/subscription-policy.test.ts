import { describe, expect, it } from "vitest";
import {
  EMPTY_POLICY,
  matchPolicy,
  parseEpisodeFilter,
  previewPolicy,
  withinCooldown,
  type SubscriptionPolicy,
} from "../src/subscription-policy.js";

/**
 * Batch 5 的策略决策核心（plan §4.1 / 批次 5）。
 *
 * 三条断言的主线：
 *   ① 规则预览与巡检跑**同一个** matchPolicy —— 预览是承诺，不是估算
 *   ② 解析不出的 episodeFilter **排除一切**，而不是少匹配一些
 *   ③ 不建任何 status 状态机：这里只回答「这个资源满足这条策略吗」
 */

function policy(overrides: Partial<SubscriptionPolicy> = {}): SubscriptionPolicy {
  return { ...EMPTY_POLICY, ...overrides };
}

function resource(name: string, episodeCode?: string) {
  return episodeCode === undefined ? { name } : { name, episodeCode };
}

describe("parseEpisodeFilter", () => {
  it("空 ⇒ 无限制", () => {
    expect(parseEpisodeFilter("")?.size).toBe(0);
    expect(parseEpisodeFilter("   ")?.size).toBe(0);
  });

  it("季区间 S01-S03", () => {
    const set = parseEpisodeFilter("S01-S03");
    expect(set).not.toBeNull();
    expect([...set!]).toEqual(["S01", "S02", "S03"]);
  });

  it("集区间 E01-E10", () => {
    const set = parseEpisodeFilter("E01-E03");
    expect([...set!]).toEqual(["E01", "E02", "E03"]);
  });

  it("精确 S02E05", () => {
    expect([...parseEpisodeFilter("S02E05")!]).toEqual(["S02E05"]);
  });

  it("**分号是并集**（plan 的 `S01-S03;E01-E10`）", () => {
    const set = parseEpisodeFilter("S01-S03;E01-E10")!;
    expect(set.has("S02")).toBe(true);
    expect(set.has("E05")).toBe(true);
    expect(set.has("S05")).toBe(false);
  });

  it("裸集号 05 归一成 E05", () => {
    expect([...parseEpisodeFilter("05")!]).toEqual(["E05"]);
  });

  it("**解析不出 ⇒ null**（不是部分答案）", () => {
    // 一个悄悄少匹配的过滤器，就是订阅无声停止工作的来路
    for (const bad of ["S01-", "S03-S01", "S01-S100", "abc", "S01E", "E01-"]) {
      expect(parseEpisodeFilter(bad)).toBeNull();
    }
  });
});

describe("matchPolicy — mustContain / mustNotContain", () => {
  it("空策略放行一切", () => {
    expect(matchPolicy(policy(), resource("anything.mkv")).matched).toBe(true);
  });

  it("mustContain 全中才放行", () => {
    const p = policy({ mustContain: ["2160p", "BluRay"] });
    expect(matchPolicy(p, resource("Show.S01E01.2160p.BluRay.mkv")).matched).toBe(true);
    expect(matchPolicy(p, resource("Show.S01E01.2160p.mkv")).matched).toBe(false);
  });

  it("**mustNotContain 先判**（排除比包含便宜）", () => {
    const p = policy({ mustContain: ["2160p"], mustNotContain: ["CAM"] });
    const verdict = matchPolicy(p, resource("Show.2160p.CAM.mkv"));
    expect(verdict.matched).toBe(false);
    if (verdict.matched) return;
    expect(verdict.reason).toBe("excluded");
  });

  it("**两条规则同时违犯时报排除**（顺序即优先级，不是巧合）", () => {
    // 这个资源既缺 mustContain 的词、又撞了 mustNotContain。若把包含判放到前面，
    //  reason 会变成 missing_term——而用户设的硬排除反而看不到了。这条用例专门
    //  让两种顺序给出不同答案（曾靠一个 mustContain 恰好通过的夹具漏掉）。
    const p = policy({ mustContain: ["2160p"], mustNotContain: ["CAM"] });
    const verdict = matchPolicy(p, resource("Show.S01E01.CAM.1080p.mkv"));
    expect(verdict.matched).toBe(false);
    if (verdict.matched) return;
    expect(verdict.reason).toBe("excluded");
  });

  it("大小写不敏感", () => {
    expect(matchPolicy(policy({ mustContain: ["bluray"] }), resource("Show.BLURAY.mkv")).matched).toBe(
      true,
    );
  });

  it("**多行粘贴按行拆**（qBittorrent 一行一个词）", () => {
    // 一个用户粘贴多行值时期待每行是一个词，而不是一个巨大的子串
    const p = policy({ mustContain: ["2160p", "BluRay"] });
    expect(matchPolicy(p, resource("a.2160p.BluRay.b")).matched).toBe(true);
    expect(matchPolicy(p, resource("a.2160p.b")).matched).toBe(false);
  });

  it("useRegex 时按正则走", () => {
    const p = policy({ mustContain: ["^Show"], useRegex: true });
    expect(matchPolicy(p, resource("Show.S01E01.mkv")).matched).toBe(true);
    expect(matchPolicy(p, resource("AShow.S01E01.mkv")).matched).toBe(false);
  });

  it("**坏正则是排除，不是抛错**（整次巡检不该被一个模式炸掉）", () => {
    const p = policy({ mustContain: ["("], useRegex: true });
    expect(matchPolicy(p, resource("Show.mkv")).matched).toBe(false);
  });
});

describe("matchPolicy — episodeFilter", () => {
  it("季过滤按季放行", () => {
    const p = policy({ episodeFilter: "S01" });
    expect(matchPolicy(p, resource("Show S01E01.mkv")).matched).toBe(true);
    expect(matchPolicy(p, resource("Show S02E01.mkv")).matched).toBe(false);
  });

  it("精确集过滤", () => {
    const p = policy({ episodeFilter: "S01E05" });
    expect(matchPolicy(p, resource("Show S01E05.mkv")).matched).toBe(true);
    expect(matchPolicy(p, resource("Show S01E06.mkv")).matched).toBe(false);
  });

  it("集号过滤跨季", () => {
    const p = policy({ episodeFilter: "E01" });
    expect(matchPolicy(p, resource("Show S03E01.mkv")).matched).toBe(true);
    expect(matchPolicy(p, resource("Show S03E02.mkv")).matched).toBe(false);
  });

  it("**资源没有集号 ⇒ 被过滤掉**（不是放行）", () => {
    const p = policy({ episodeFilter: "S01" });
    const verdict = matchPolicy(p, resource("Movie.2023.2160p.mkv"));
    expect(verdict.matched).toBe(false);
    if (verdict.matched) return;
    expect(verdict.reason).toBe("episode_filtered");
  });

  it("**过滤器解析不出 ⇒ 排除一切**", () => {
    // 对一个读不懂的过滤器去匹配，就是猜用户想干什么
    const p = policy({ episodeFilter: "garbage" });
    expect(matchPolicy(p, resource("Show S01E01.mkv")).matched).toBe(false);
  });

  it("episodeCode 优先于文件名解析", () => {
    const p = policy({ episodeFilter: "S09E09" });
    expect(matchPolicy(p, resource("无名文件.mkv", "S09E09")).matched).toBe(true);
    expect(matchPolicy(p, resource("Show S01E01.mkv", "S09E09")).matched).toBe(true);
  });
});

describe("previewPolicy — ① 预览与巡检同一个匹配器", () => {
  const resources = [
    resource("Show.S01E01.2160p.BluRay.mkv"),
    resource("Show.S01E02.2160p.BluRay.mkv"),
    resource("Show.S01E03.CAM.mkv"),
    resource("Show.S02E01.2160p.BluRay.mkv"),
    resource("random-clip.mp4"),
  ];

  it("命中数与排除数都对", () => {
    const preview = previewPolicy(policy({ mustContain: ["2160p"], mustNotContain: ["CAM"] }), resources);
    expect(preview.matchedCount).toBe(3);
    expect(preview.excludedCount).toBe(2);
  });

  it("**排除带 reason**（只说「排了 7 个」会让人回去猜是哪条规则干的）", () => {
    const preview = previewPolicy(policy({ episodeFilter: "S01" }), resources);
    const reasons = preview.excluded.map((entry) => entry.reason);
    expect(reasons).toContain("episode_filtered");
    expect(preview.excluded.every((entry) => entry.resource.name.length > 0)).toBe(true);
  });

  it("**预览数 == 逐个 matchPolicy 的数**（同一个实现的直接证据）", () => {
    const p = policy({ mustContain: ["2160p"], mustNotContain: ["CAM"], episodeFilter: "S01" });
    const preview = previewPolicy(p, resources);
    const byHand = resources.filter((entry) => matchPolicy(p, entry).matched).length;
    expect(preview.matchedCount).toBe(byHand);
  });

  it("空资源列表 ⇒ 两个 0", () => {
    const preview = previewPolicy(policy(), []);
    expect(preview.matchedCount).toBe(0);
    expect(preview.excludedCount).toBe(0);
  });
});

describe("withinCooldown", () => {
  const p = policy({ cooldownDays: 7 });
  const now = "2026-02-01T00:00:00.000Z";

  it("冷却期内 ⇒ true", () => {
    expect(withinCooldown({ policy: p, lastTakenAt: "2026-01-28T00:00:00.000Z", now })).toBe(true);
  });

  it("超过冷却期 ⇒ false", () => {
    expect(withinCooldown({ policy: p, lastTakenAt: "2026-01-20T00:00:00.000Z", now })).toBe(false);
  });

  it("**恰好等于冷却期 ⇒ false**（边界不含）", () => {
    expect(withinCooldown({ policy: p, lastTakenAt: "2026-01-25T00:00:00.000Z", now })).toBe(false);
  });

  it("cooldownDays 为 0 ⇒ 永不冷却", () => {
    expect(
      withinCooldown({ policy: policy({ cooldownDays: 0 }), lastTakenAt: now, now }),
    ).toBe(false);
  });

  it("从未取过 ⇒ false", () => {
    expect(withinCooldown({ policy: p, lastTakenAt: null, now })).toBe(false);
  });

  it("**时间戳读不出 ⇒ false（fail-open）**", () => {
    // 多搜一次可以；把读不出的时间戳当成冷却会让订阅永久停摆
    expect(withinCooldown({ policy: p, lastTakenAt: "not-a-date", now })).toBe(false);
    expect(withinCooldown({ policy: p, lastTakenAt: "2026-01-28T00:00:00.000Z", now: "nope" })).toBe(
      false,
    );
  });
});

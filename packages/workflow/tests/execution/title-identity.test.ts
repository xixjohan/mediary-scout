import { describe, expect, it } from "vitest";
import {
  EMPTY_POLICY,
  matchIdentity,
  matchPolicy,
  previewPolicy,
  titleIdentityFrom,
  leadingLabelOf,
  candidateIdentityOf,
  type SubscriptionPolicy,
  type TitleIdentity,
} from "@media-track/workflow";

/**
 * 身份闸门（G9–G11）—— 2026-11-17 假阳性事故的回归护栏。
 *
 * 事故语料**逐字**钉在这里：只写 `1080p` 的规则曾把《给你宇宙》《法警小队》
 * 《汪汪队立大功》等都算成「命中」。任何人把身份闸门拿掉，这些断言立刻红。
 */

function policy(overrides: Partial<SubscriptionPolicy> = {}): SubscriptionPolicy {
  return { ...EMPTY_POLICY, mustContain: ["1080p"], ...overrides };
}

function identity(overrides: Partial<TitleIdentity> = {}): TitleIdentity {
  return titleIdentityFrom({ tmdbId: 999_999, year: 2026, title: "12 12 12", originalTitle: "12 12 12", aliases: [], ...overrides });
}

/** 截图里被误算成「命中」的原始标题（含各自的 tmdb 号与年份）。 */
const FALSE_POSITIVES = [
  "给你宇宙 (2026) 第1季 全12集 1080P WEB-DL DDP 7.89 GB",
  "法警小队.2026 - S01E12 - 第 12 集 - 1080p.Amazon.WEB-DL.SDR.AVC.DDP 5.1.{tmdb-290856}.mkv",
  "中央情报局.2026 - S01E12 - 第 12 集 - 1080p.Paramount.WEB-DL.SDR.AVC.DDP 5.1.{tmdb-289560}.mkv",
  "汪汪队立大功.2013 - S12E12 - 第 12 集 - 1080p.Amazon.WEB-DL.SDR.AVC.DDP 5.1.{tmdb-57532}.mkv",
  "法律与秩序：特殊受害者.1999 - S27E12 - 第 12 集 - 1080p.Amazon.WEB-DL.SDR.AVC.DDP 5.1.{tmdb-2734}.mkv",
];

/** 真资源：必须仍然通过（身份闸门不能把真资源也拒掉）。 */
const TRUE_POSITIVES = [
  "12 12 12.2026.S01E12.1080p.WEB-DL.mkv",
  "12 12 12 S01 1080p",
  "12 12 12 2026 1080p WEB-DL",
  "12 12 12 (2026) [1080p] [WEBRip]",
];

describe("G9 — 截图语料：别的作品一律 wrong_title", () => {
  it.each(FALSE_POSITIVES)("拒绝 %s", (name) => {
    const verdict = matchPolicy(policy(), { name }, { identity: identity() });
    expect(verdict.matched).toBe(false);
    if (verdict.matched) return;
    expect(verdict.reason).toBe("wrong_title");
  });

  it.each(TRUE_POSITIVES)("放行真资源 %s", (name) => {
    expect(matchPolicy(policy(), { name }, { identity: identity() }).matched).toBe(true);
  });

  it("**不传身份时行为与引入闸门之前一致**（既有纯单测不受影响）", () => {
    expect(matchPolicy(policy(), { name: FALSE_POSITIVES[0]! }).matched).toBe(true);
  });
});

describe("G10 — {tmdb-N} 硬锚点", () => {
  const withTmdb = { ...identity(), tmdbId: 12_345 };

  it("候选 id 与目标不同 ⇒ wrong_title", () => {
    expect(matchPolicy(policy(), { name: "同一部片 1080p {tmdb-99999}.mkv" }, { identity: withTmdb }).matched).toBe(false);
  });

  it("候选 id 与目标相同 ⇒ 通过（即便片名写法不同）", () => {
    expect(matchPolicy(policy(), { name: "Totally.Different.Name.S01E01.1080p.{tmdb-12345}.mkv" }, { identity: withTmdb }).matched).toBe(true);
  });

  it("候选不带 id ⇒ 不因缺 id 被拒（改由片名判定）", () => {
    const sameTitle = matchPolicy(policy(), { name: "12 12 12 S01 1080p" }, { identity: withTmdb });
    expect(sameTitle.matched).toBe(true);
    const otherTitle = matchPolicy(policy(), { name: "汪汪队立大功 S12E12 1080p" }, { identity: withTmdb });
    expect(otherTitle.matched).toBe(false);
  });

  it("目标没有 tmdbId ⇒ 不启用该锚点", () => {
    const noTmdb = titleIdentityFrom({ tmdbId: null, year: 2026, title: "12 12 12", aliases: [] });
    expect(matchPolicy(policy(), { name: "12 12 12 2026 1080p {tmdb-55555}.mkv" }, { identity: noTmdb }).matched).toBe(true);
  });
});

describe("G11 — 年份只否决不采用", () => {
  it("相差多年 ⇒ wrong_title", () => {
    expect(matchPolicy(policy(), { name: "汪汪队立大功.2013 - S12E12 - 1080p.mkv" }, { identity: identity() }).matched).toBe(false);
  });

  it("相差 1 年 ⇒ 放行（跨年播出的剧很常见）", () => {
    expect(matchPolicy(policy(), { name: "12 12 12.2027.S01E12.1080p.mkv" }, { identity: identity() }).matched).toBe(true);
  });

  it("**缺年份不拒**（大量资源不带年份，加年份常把召回打零）", () => {
    expect(matchPolicy(policy(), { name: "12 12 12 S01 1080p" }, { identity: identity() }).matched).toBe(true);
  });
});

describe("身份判定细节（matchIdentity 直测）", () => {
  it("原名/别名任一对上也算同一部作品", () => {
    const lotr = titleIdentityFrom({
      year: 2022,
      title: "指环王：力量之戒",
      originalTitle: "The Lord of the Rings: The Rings of Power",
      aliases: ["The Rings of Power"],
    });
    expect(matchPolicy(policy({ mustContain: [] }), { name: "The.Lord.of.the.Rings.The.Rings.of.Power.S02.1080p" }, { identity: lotr }).matched).toBe(true);
    expect(matchPolicy(policy({ mustContain: [] }), { name: "The.Rings.of.Power.S02.1080p" }, { identity: lotr }).matched).toBe(true);
  });

  it("字幕组括号前缀不影响识别", () => {
    const anime = titleIdentityFrom({ title: "黄泉的使者", aliases: [] });
    expect(matchPolicy(policy({ mustContain: [] }), { name: "[喵萌奶茶屋] 黄泉的使者 13 [1080p][简日双语]" }, { identity: anime }).matched).toBe(true);
  });

  it("名字相近但不同作品仍拒（野兽之心 vs 美女与野兽）", () => {
    const beast = titleIdentityFrom({ year: 2026, title: "野兽之心", originalTitle: "Heart of the Beast", aliases: [] });
    expect(matchPolicy(policy({ mustContain: [] }), { name: "美女与野兽 (1991) 1080p" }, { identity: beast }).matched).toBe(false);
  });

  it("纯数字片名不会与别处数字撞车", () => {
    const numeric = titleIdentityFrom({ title: "12 12 12", aliases: [] });
    expect(matchIdentityByNameSafe(numeric, "给你宇宙 2026 1080p 全12集")).toBe(false);
    expect(matchIdentityByNameSafe(numeric, "12 12 12 S01 1080p")).toBe(true);
  });

  it("目标没有任何可比片名 ⇒ 闸门不否决一切", () => {
    const blank = titleIdentityFrom({ title: null, originalTitle: null, aliases: [] });
    expect(matchPolicy(policy(), { name: "任意资源 1080p" }, { identity: blank }).matched).toBe(true);
  });

  it("leadingLabelOf 在第一个非片名标记处截断", () => {
    expect(leadingLabelOf("12 12 12.2026.S01E12.1080p.WEB-DL.mkv")).toBe("121212");
    expect(leadingLabelOf("汪汪队立大功.2013 - S12E12 - 1080p.mkv")).toBe("汪汪队立大功");
  });

  it("candidateIdentityOf 读出 tmdb / 年份 / 标题", () => {
    const c = candidateIdentityOf("法警小队.2026 - S01E12 - 1080p.{tmdb-290856}.mkv");
    expect(c.tmdbId).toBe(290856);
    expect(c.year).toBe(2026);
    expect(c.parsedTitle).toContain("法警小队");
  });
});

function matchIdentityByNameSafe(identityValue: TitleIdentity, name: string): boolean {
  return matchIdentity(identityValue, candidateIdentityOf(name)).matched;
}

describe("G12 — 预览：别的作品不得计入命中", () => {
  const title = identity();

  it("命中只含同名资源，且 excludedByReason 记下 wrong_title", () => {
    const resources = [
      { name: TRUE_POSITIVES[0]! },
      { name: FALSE_POSITIVES[1]! },
      { name: FALSE_POSITIVES[3]! },
    ];
    const preview = previewPolicy(policy(), resources, { identity: title });
    expect(preview.matched.map((entry) => entry.name)).toEqual([TRUE_POSITIVES[0]!]);
    expect(preview.matchedCount).toBe(1);
    expect(preview.excludedCount).toBe(2);
    expect(preview.excludedByReason.wrong_title).toBe(2);
  });

  it("**命中数 == 逐条 matchPolicy 的数**（预览仍是承诺）", () => {
    const resources = [...TRUE_POSITIVES, ...FALSE_POSITIVES].map((name) => ({ name }));
    const preview = previewPolicy(policy(), resources, { identity: title });
    const perItem = resources.filter((resource) => matchPolicy(policy(), resource, { identity: title }).matched).length;
    expect(preview.matchedCount).toBe(perItem);
    expect(preview.matchedCount).toBe(TRUE_POSITIVES.length);
  });
});

describe("G15 — 计数单位：整季包与单集分开", () => {
  it("季包计入 matchedPackCount，单集不计", () => {
    const packAware = titleIdentityFrom({ title: "给你宇宙", year: 2026, aliases: [] });
    const resources = [
      { name: "给你宇宙 第1季 全12集 1080P WEB-DL" },
      { name: "给你宇宙.S01E01.1080p.mkv" },
      { name: "给你宇宙.S01E02.1080p.mkv" },
    ];
    const preview = previewPolicy(policy(), resources, { identity: packAware });
    expect(preview.matchedCount).toBe(3);
    expect(preview.matchedPackCount).toBe(1);
  });
});

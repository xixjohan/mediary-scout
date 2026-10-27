import { describe, expect, it } from "vitest";
import type { MediaTitle } from "../src/domain.js";
import { buildTitleSearchKeywords, titleSearchKeywordStrings } from "../src/title-search-keywords.js";
import { normalizeSearchKeyword } from "../src/planning-search-gate.js";

/**
 * 阶梯顺序是设计的一部分：先本地化标题（最具体），再原名/别名，year 附在裸标题后
 * 因为它是对付翻拍/续集同名最有效的单一消歧因子。
 *
 * 去重必须走 agent 搜索闸门同一个 normalizeSearchKeyword——否则 "孤独摇滚" 与
 * "孤独摇滚 " 会各自花掉一次真实搜索额度。
 */

function title(overrides: Partial<MediaTitle> = {}): MediaTitle {
  return {
    id: "t1",
    tmdbId: 1,
    type: "tv",
    title: "孤独摇滚",
    originalTitle: "Bocchi the Rock!",
    year: 2022,
    aliases: [],
    ...overrides,
  };
}

describe("buildTitleSearchKeywords — 阶梯顺序", () => {
  it("裸标题 → 标题+年份 → 原名 → 别名", () => {
    const ladder = buildTitleSearchKeywords(title({ aliases: ["孤独摇滚！"] }));
    expect(ladder.map((entry) => entry.origin)).toEqual([
      "title",
      "title+year",
      "originalTitle",
      "alias",
    ]);
    expect(ladder.map((entry) => entry.keyword)).toEqual([
      "孤独摇滚",
      "孤独摇滚 2022",
      "Bocchi the Rock!",
      "孤独摇滚！",
    ]);
  });

  it("年份为 0/缺失时不造 title+year（不是所有标题都有年份）", () => {
    const ladder = buildTitleSearchKeywords(title({ year: 0 }));
    expect(ladder.map((e) => e.origin)).toEqual(["title", "originalTitle"]);
  });

  it("原名与标题相同时不重复（归一化后去重）", () => {
    const ladder = buildTitleSearchKeywords(title({ originalTitle: "孤独摇滚" }));
    expect(ladder.map((e) => e.origin)).toEqual(["title", "title+year"]);
  });
});

describe("buildTitleSearchKeywords — 去重与上限", () => {
  it("空白/大小写差异视为同一个关键词", () => {
    // 别名只差大小写与首尾空白 → 归一化后与原名同一个，必须被去重掉。
    // 注意 "Bocchi the Rock!" 与 "bocchi the ROCK" 差一个感叹号，那是**不同**
    // 关键词，不算重复——这条用例特意用真正的同形变体。
    const ladder = buildTitleSearchKeywords(
      title({ originalTitle: "Bocchi the Rock!", aliases: ["  BOCCHI THE ROCK!  "] }),
    );
    expect(ladder.map((e) => e.keyword)).toEqual(["孤独摇滚", "孤独摇滚 2022", "Bocchi the Rock!"]);
  });

  it("别名上限 4 条——每多一个关键词就是一次真实索引器搜索", () => {
    const ladder = buildTitleSearchKeywords(title({ aliases: ["a", "b", "c", "d", "e", "f"] }));
    expect(ladder).toHaveLength(4);
  });

  it("空别名/空原名被跳过", () => {
    const ladder = buildTitleSearchKeywords(title({ originalTitle: "  ", aliases: ["", "  "] }));
    expect(ladder.map((e) => e.origin)).toEqual(["title", "title+year"]);
  });

  it("去重口径与 agent 搜索闸门同一个 normalizeSearchKeyword", () => {
    const ladder = buildTitleSearchKeywords(title({ aliases: ["孤独摇滚 "] }));
    const normalized = ladder.map((e) => normalizeSearchKeyword(e.keyword));
    expect(new Set(normalized).size).toBe(normalized.length);
  });
});

describe("titleSearchKeywordStrings", () => {
  it("只给字符串，顺序不变", () => {
    expect(titleSearchKeywordStrings(title())).toEqual(["孤独摇滚", "孤独摇滚 2022", "Bocchi the Rock!"]);
  });
});

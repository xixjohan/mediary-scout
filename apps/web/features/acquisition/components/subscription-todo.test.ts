import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LibraryWallEntry } from "../../../lib/title-hub";
import { missingAiredTitles, SubscriptionTodo } from "./subscription-todo";

/**
 * 订阅页「缺失待办区」。
 *
 * 为什么需要它：这个页面（`?tab=library`）展示的是全部追踪中的作品，一直叫
 * 「媒体库」是误称；正名为「订阅」后，用户对「订阅页」的预期会是「我在追什么、
 * 还缺什么」。只有一墙海报答不了这个问题——必须有一块直接说「还缺哪些集」。
 *
 * 数据口径见 ../lib/subscription-missing 的门禁：这里的数字来自
 * LibraryWallEntry.missingAiredCount，与 /api/agent/library 的 missingAired、
 * 详情页季行的 missingAiredCount 同一个判定，不许另写一套。
 */

function entry(over: Partial<LibraryWallEntry> & Pick<LibraryWallEntry, "tmdbId" | "title">): LibraryWallEntry {
  return {
    year: 2026,
    type: "tv",
    posterPath: null,
    seasonCount: 1,
    obtainedEpisodes: 0,
    totalAiredEpisodes: 0,
    missingAiredCount: 0,
    totalEpisodes: 12,
    releaseDate: null,
    state: "partial",
    airing: true,
    ...over,
  };
}

describe("missingAiredTitles — 从海报墙派生待办列表", () => {
  const wall: LibraryWallEntry[] = [
    entry({ tmdbId: 1, title: "B 剧", missingAiredCount: 5 }),
    entry({ tmdbId: 2, title: "乙", missingAiredCount: 0 }), // 齐了，不进待办
    entry({ tmdbId: 3, title: "C 剧", missingAiredCount: 2 }),
    entry({ tmdbId: 4, title: "A 剧", missingAiredCount: 5 }), // 与 B 同数，按标题稳定排序
  ];

  it("只保留有缺失的标题", () => {
    expect(missingAiredTitles(wall).map((e) => e.tmdbId)).toEqual([4, 1, 3]);
  });

  it("按缺失集数降序，同数按标题排序（稳定）", () => {
    expect(missingAiredTitles(wall).map((e) => e.title)).toEqual(["A 剧", "B 剧", "C 剧"]);
  });

  it("没有缺失时返回空数组", () => {
    expect(missingAiredTitles([entry({ tmdbId: 2, title: "乙", missingAiredCount: 0 })])).toEqual([]);
  });

  it("不修改入参", () => {
    const before = wall.map((e) => e.tmdbId);
    missingAiredTitles(wall);
    expect(wall.map((e) => e.tmdbId)).toEqual(before);
  });
});

describe("SubscriptionTodo 渲染", () => {
  const wall: LibraryWallEntry[] = [
    entry({ tmdbId: 111, title: "有缺的剧", missingAiredCount: 3, type: "tv" }),
    entry({ tmdbId: 222, title: "齐了的剧", missingAiredCount: 0, type: "tv" }),
  ];

  const html = (entries: LibraryWallEntry[], storageId?: string) =>
    renderToStaticMarkup(createElement(SubscriptionTodo, { wallEntries: entries, storageId }));

  it("标题说清这是待办区", () => {
    expect(html(wall)).toContain("还缺");
  });

  it("列出缺失集数合计", () => {
    expect(html(wall)).toContain("3");
  });

  it("每个条目链接到该标题的详情页", () => {
    const markup = html(wall);
    // 走规范的 showHref：?from=library 让详情页的返回标签显示「订阅」。
    expect(markup).toContain('href="/show/111?from=library&amp;t=tv"');
    expect(markup).not.toContain("/show/222");
  });

  it("带 storageId 时链接带上工作区", () => {
    expect(html(wall, "drive_1")).toContain('href="/show/111?from=library&amp;w=drive_1&amp;t=tv"');
  });

  it("没有缺失时整个区块不渲染（不出现空标题栏）", () => {
    const markup = html([entry({ tmdbId: 222, title: "齐了的剧", missingAiredCount: 0 })]);
    expect(markup).toBe("");
  });
});

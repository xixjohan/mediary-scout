import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LibraryWallEntry } from "../../../lib/title-hub";
import {
  adaptToMissingTodoItem,
  formatPosterUrl,
  missingAiredTitles,
  SubscriptionTodo,
  COMPACT_PREVIEW_LIMIT,
} from "./subscription-todo";

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
    entry({ tmdbId: 1, title: "B 剧", missingAiredCount: 5, type: "tv" }),
    entry({ tmdbId: 2, title: "乙", missingAiredCount: 0, type: "tv" }), // 齐了，不进待办
    entry({ tmdbId: 3, title: "C 漫", missingAiredCount: 2, type: "anime" }),
    entry({ tmdbId: 4, title: "A 影", missingAiredCount: 5, type: "movie" }), // 与 B 同数，按标题稳定排序
  ];

  it("只保留有缺失的标题", () => {
    expect(missingAiredTitles(wall).map((e) => e.tmdbId)).toEqual([4, 1, 3]);
  });

  it("按缺失集数降序，同数按标题排序（稳定）", () => {
    expect(missingAiredTitles(wall).map((e) => e.title)).toEqual(["A 影", "B 剧", "C 漫"]);
  });

  it("没有缺失时返回空数组", () => {
    expect(missingAiredTitles([entry({ tmdbId: 2, title: "乙", missingAiredCount: 0 })])).toEqual([]);
  });

  it("不修改入参", () => {
    const before = wall.map((e) => e.tmdbId);
    missingAiredTitles(wall);
    expect(wall.map((e) => e.tmdbId)).toEqual(before);
  });

  it("支持按分类过滤待办列表", () => {
    expect(missingAiredTitles(wall, "anime").map((e) => e.title)).toEqual(["C 漫"]);
    expect(missingAiredTitles(wall, "tv").map((e) => e.title)).toEqual(["B 剧"]);
    expect(missingAiredTitles(wall, "movie").map((e) => e.title)).toEqual(["A 影"]);
    expect(missingAiredTitles(wall, "all").map((e) => e.title)).toEqual(["A 影", "B 剧", "C 漫"]);
  });
});

describe("adaptToMissingTodoItem — 适配器模型转换与业务规则", () => {
  it("海报 URL 正规化转换", () => {
    expect(formatPosterUrl(null)).toBeNull();
    expect(formatPosterUrl("/pic.jpg")).toBe("https://image.tmdb.org/t/p/w185/pic.jpg");
    expect(formatPosterUrl("pic2.jpg")).toBe("https://image.tmdb.org/t/p/w185/pic2.jpg");
    expect(formatPosterUrl("https://example.com/custom.png")).toBe("https://example.com/custom.png");
  });

  it("计算就绪百分比与紧迫度分级", () => {
    // 0 集就绪：紧迫度为 critical，进度 0%
    const critical = adaptToMissingTodoItem(
      entry({ tmdbId: 10, title: "未入库", missingAiredCount: 10, obtainedEpisodes: 0, totalAiredEpisodes: 10 })
    );
    expect(critical.urgencyLevel).toBe("critical");
    expect(critical.progressPercent).toBe(0);

    // 缺 4 集且有部分就绪：紧迫度为 moderate，进度 60%
    const moderate = adaptToMissingTodoItem(
      entry({ tmdbId: 11, title: "部分就绪", missingAiredCount: 4, obtainedEpisodes: 6, totalAiredEpisodes: 10 })
    );
    expect(moderate.urgencyLevel).toBe("moderate");
    expect(moderate.progressPercent).toBe(60);

    // 仅缺 1 集：紧迫度为 low，进度 90%
    const low = adaptToMissingTodoItem(
      entry({ tmdbId: 12, title: "临门一脚", missingAiredCount: 1, obtainedEpisodes: 9, totalAiredEpisodes: 10 })
    );
    expect(low.urgencyLevel).toBe("low");
    expect(low.progressPercent).toBe(90);
  });

  it("正确转换类型标签与详情链接", () => {
    const anime = adaptToMissingTodoItem(entry({ tmdbId: 101, title: "动漫", type: "anime", missingAiredCount: 1 }));
    expect(anime.typeLabel).toBe("动漫");
    expect(anime.detailHref).toContain("/show/101?from=library&t=anime");

    const movie = adaptToMissingTodoItem(
      entry({ tmdbId: 102, title: "电影", type: "movie", missingAiredCount: 1 }),
      "workspace_x"
    );
    expect(movie.typeLabel).toBe("电影");
    expect(movie.detailHref).toContain("w=workspace_x");
  });
});

describe("SubscriptionTodo 渲染与甲板交互", () => {
  const wall: LibraryWallEntry[] = [
    entry({ tmdbId: 111, title: "有缺的剧", missingAiredCount: 3, type: "tv", obtainedEpisodes: 3, totalAiredEpisodes: 6 }),
    entry({ tmdbId: 222, title: "齐了的剧", missingAiredCount: 0, type: "tv" }),
  ];

  const html = (entries: LibraryWallEntry[], storageId?: string, initialCategory?: "movie" | "tv" | "anime" | null) =>
    renderToStaticMarkup(createElement(SubscriptionTodo, { wallEntries: entries, storageId, initialCategory }));

  it("标题说清这是待办区并显示缺失合计", () => {
    const markup = html(wall);
    expect(markup).toContain("还缺 3 集");
    expect(markup).toContain("共 1 部待办");
  });

  it("每个条目链接到该标题的详情页", () => {
    const markup = html(wall);
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

  it("渲染就绪进度条与百分比", () => {
    const markup = html(wall);
    expect(markup).toContain("50%");
    expect(markup).toContain("已获 3/6 集");
  });

  it("多类型缺失时在总览中渲染分类筛选 Tabs", () => {
    const multiWall: LibraryWallEntry[] = [
      entry({ tmdbId: 1, title: "剧 A", type: "tv", missingAiredCount: 2 }),
      entry({ tmdbId: 2, title: "漫 B", type: "anime", missingAiredCount: 4 }),
      entry({ tmdbId: 3, title: "影 C", type: "movie", missingAiredCount: 1 }),
    ];
    const markup = html(multiWall);
    expect(markup).toContain("全部");
    expect(markup).toContain("电视剧");
    expect(markup).toContain("动漫");
    expect(markup).toContain("电影");
  });

  it("处于特定分类上下文时仅渲染该分类的待办", () => {
    const multiWall: LibraryWallEntry[] = [
      entry({ tmdbId: 1, title: "剧 A", type: "tv", missingAiredCount: 2 }),
      entry({ tmdbId: 2, title: "漫 B", type: "anime", missingAiredCount: 4 }),
    ];
    const animeMarkup = html(multiWall, undefined, "anime");
    expect(animeMarkup).toContain("漫 B");
    expect(animeMarkup).not.toContain("剧 A");
    expect(animeMarkup).toContain("共 1 部动漫待办");
  });

  it("大量缺集时默认折叠只渲染 Top 4 并提供展开按钮", () => {
    const largeWall: LibraryWallEntry[] = Array.from({ length: 7 }, (_, i) =>
      entry({
        tmdbId: 100 + i,
        title: `连载作品 ${i + 1}`,
        type: "tv",
        missingAiredCount: 10 - i, // 10, 9, 8, 7, 6, 5, 4
      })
    );
    expect(largeWall.length).toBe(7);
    expect(COMPACT_PREVIEW_LIMIT).toBe(4);

    const markup = html(largeWall);
    // 前 4 部应该渲染
    expect(markup).toContain("连载作品 1");
    expect(markup).toContain("连载作品 2");
    expect(markup).toContain("连载作品 3");
    expect(markup).toContain("连载作品 4");
    // 第 5 部及之后在初始折叠状态不直接渲染在可见区域中
    expect(markup).not.toContain("连载作品 5");
    // 提供展开剩余按钮
    expect(markup).toContain("展开剩余 3 部待办");
    expect(markup).toContain('aria-expanded="false"');
  });
});

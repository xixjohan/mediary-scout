import { describe, expect, it } from "vitest";
import {
  buildFilterHref,
  matchesItemType,
  matchesItemGenre,
  matchesItemYear,
  sortItems,
  applyCandidateFilters,
} from "./media-filter-bar";
import type { SearchCandidateCard } from "@media-track/workflow";

describe("buildFilterHref", () => {
  it("无过滤条件时生成基础路径", () => {
    expect(buildFilterHref("/", {}, {})).toBe("/");
    expect(buildFilterHref("/w/drive_1", {}, {})).toBe("/w/drive_1");
  });

  it("正确追加媒体类型并保留已有查询关键词", () => {
    const url = buildFilterHref(
      "/",
      { q: "流浪地球", type: "all" },
      { type: "movie" },
    );
    expect(url).toBe("/?q=%E6%B5%81%E6%B5%AA%E5%9C%B0%E7%90%83&type=movie");
  });

  it("当切换回 'all' 时自动移除该维度参数保持 URL 简洁", () => {
    const url = buildFilterHref(
      "/",
      { q: "三体", type: "tv", genre: "scifi" },
      { type: "all" },
    );
    expect(url).toBe("/?q=%E4%B8%89%E4%BD%93&genre=scifi");
  });

  it("无查询词时媒体类型切换联动 trending 参数", () => {
    const url = buildFilterHref("/", {}, { type: "anime" });
    expect(url).toBe("/?type=anime&trending=anime");
  });

  it("切换回全部或纪录片/综艺时彻底清除 trending 粘性参数避免过滤冲突", () => {
    const urlAll = buildFilterHref("/", { type: "tv", trending: "tv" }, { type: "all" });
    expect(urlAll).toBe("/");

    const urlDoc = buildFilterHref("/", { type: "movie", trending: "movie" }, { type: "documentary" });
    expect(urlDoc).toBe("/?type=documentary");

    const urlVariety = buildFilterHref("/", { type: "tv", trending: "tv" }, { type: "variety" });
    expect(urlVariety).toBe("/?type=variety");
  });

  it("支持年代与排序复合筛选", () => {
    const url = buildFilterHref(
      "/w/storage1",
      { q: "沙丘" },
      { year: "2024", sort: "rating" },
    );
    expect(url).toContain("year=2024");
    expect(url).toContain("sort=rating");
    expect(url).toContain("q=%E6%B2%99%E4%B8%98");
  });
});

describe("matchesItemType 多类型识别", () => {
  it("type === 'all' 时匹配所有媒体", () => {
    expect(matchesItemType({ title: "任意", year: 2024, mediaType: "movie" }, "all")).toBe(true);
  });

  it("正确识别电影与剧集", () => {
    const movie = { title: "奥本海默", year: 2023, mediaType: "movie" as const };
    const tv = { title: "漫长的季节", year: 2023, mediaType: "tv" as const };
    expect(matchesItemType(movie, "movie")).toBe(true);
    expect(matchesItemType(movie, "tv")).toBe(false);
    expect(matchesItemType(tv, "tv")).toBe(true);
    expect(matchesItemType(tv, "movie")).toBe(false);
  });

  it("通过 TMDB genre 16 或假名/动画关键词精准识别动漫", () => {
    const anime1 = { title: "头脑特工队2", year: 2024, mediaType: "movie" as const, genreIds: [16, 10751] };
    const anime2 = { title: "葬送のフリーレン", year: 2023, mediaType: "tv" as const };
    const nonAnime = { title: "坚如磐石", year: 2023, mediaType: "movie" as const, genreIds: [80, 18] };

    expect(matchesItemType(anime1, "anime")).toBe(true);
    expect(matchesItemType(anime2, "anime")).toBe(true);
    expect(matchesItemType(nonAnime, "anime")).toBe(false);
  });

  it("正确识别纪录片与综艺", () => {
    const doc = { title: "地球脉动", year: 2023, mediaType: "tv" as const, genreIds: [99] };
    const variety = { title: "脱口秀大会", year: 2022, mediaType: "tv" as const, genreIds: [10764] };

    expect(matchesItemType(doc, "documentary")).toBe(true);
    expect(matchesItemType(variety, "variety")).toBe(true);
    expect(matchesItemType(doc, "variety")).toBe(false);
  });
});

describe("matchesItemGenre 题材标签多层级匹配", () => {
  it("优先通过 TMDB genre_ids 精准匹配，即使简介无题材中文词", () => {
    // 《流浪地球》TMDB genre 878 (科幻)，简介里是故事梗概没有“科幻”二字
    const scifiMovie = {
      title: "流浪地球2",
      year: 2023,
      mediaType: "movie" as const,
      overview: "太阳即将毁灭，人类在地球表面建造出巨大的推进器，寻找新的家园。",
      genreIds: [878, 28],
    };
    expect(matchesItemGenre(scifiMovie, "scifi")).toBe(true);
    expect(matchesItemGenre(scifiMovie, "action")).toBe(true);
    expect(matchesItemGenre(scifiMovie, "romance")).toBe(false);
  });

  it("genreIds 缺失时自动回退到同义词词库匹配", () => {
    const legacyItem = {
      title: "太空漫游",
      year: 2001,
      mediaType: "movie" as const,
      overview: "一艘前往木星的飞船发生神秘事故。",
    };
    expect(matchesItemGenre(legacyItem, "scifi")).toBe(true);
  });
});

describe("matchesItemYear 年代维度匹配", () => {
  it("支持具体单年与年代跨度匹配", () => {
    const y2024 = { title: "A", year: 2024, mediaType: "movie" as const };
    const y2021 = { title: "B", year: 2021, mediaType: "movie" as const };
    const y2015 = { title: "C", year: 2015, mediaType: "movie" as const };
    const yNull = { title: "D", year: null, mediaType: "movie" as const };

    expect(matchesItemYear(y2024, "2024")).toBe(true);
    expect(matchesItemYear(y2021, "2024")).toBe(false);
    expect(matchesItemYear(y2021, "2020s")).toBe(true);
    expect(matchesItemYear(y2015, "2020s")).toBe(false);
    expect(matchesItemYear(y2015, "2010s")).toBe(true);
    expect(matchesItemYear(yNull, "2024")).toBe(false);
  });
});

describe("sortItems & applyCandidateFilters 排序与复合过滤", () => {
  const dummyCandidate = (
    title: string,
    year: number,
    mediaType: "movie" | "tv",
    genreIds: number[],
    voteAverage: number,
  ): SearchCandidateCard => ({
    id: `tmdb_${mediaType}_${title}`,
    tmdbId: 100,
    mediaType,
    title,
    originalTitle: title,
    year,
    overview: "",
    posterPath: null,
    backdropPath: null,
    selectedSeasonNumber: null,
    totalEpisodes: null,
    latestAiredEpisode: null,
    seasonNumbers: [],
    genreIds,
    voteAverage,
    action: { state: "can_request", label: "获取", disabled: false, workflowRunId: null },
  });

  it("高分优先排序：结合豆瓣权威评分与 TMDB 降序重排", () => {
    const c1 = dummyCandidate("低分电影", 2024, "movie", [28], 6.0);
    const c2 = dummyCandidate("高分电影", 2024, "movie", [28], 8.5);
    const c3 = dummyCandidate("豆瓣超高分", 2024, "movie", [28], 7.0);

    const doubanMap = new Map([
      ["豆瓣超高分_2024", { title: "豆瓣超高分", score: 9.3, ratingCount: 50000, doubanUrl: "" }],
    ]);

    const sorted = sortItems([c1, c2, c3], "rating", doubanMap);
    expect(sorted.map((c) => c.title)).toEqual(["豆瓣超高分", "高分电影", "低分电影"]);
  });

  it("最新上映排序：按年份降序排列", () => {
    const oldFilm = dummyCandidate("老电影", 2020, "movie", [28], 8.0);
    const newFilm = dummyCandidate("新上映", 2025, "movie", [28], 7.0);

    const sorted = sortItems([oldFilm, newFilm], "release");
    expect(sorted.map((c) => c.title)).toEqual(["新上映", "老电影"]);
  });

  it("复合多维度过滤：类型 + 题材 + 年份精准筛选", () => {
    const list = [
      dummyCandidate("流浪地球2", 2023, "movie", [878], 8.2), // 科幻 电影 2023
      dummyCandidate("头脑特工队2", 2024, "movie", [16], 8.4), // 动画 电影 2024
      dummyCandidate("三体", 2023, "tv", [878, 10765], 8.7), // 科幻 剧集 2023
      dummyCandidate("沙丘2", 2024, "movie", [878], 8.3), // 科幻 电影 2024
    ];

    // 筛选：2024年 + 科幻 + 电影
    const result = applyCandidateFilters(list, {
      type: "movie",
      genre: "scifi",
      year: "2024",
      sort: "rating",
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("沙丘2");
  });
});

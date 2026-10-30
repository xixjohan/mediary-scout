import { describe, expect, it, vi } from "vitest";
import {
  DoubanSearchProvider,
  FallbackSearchProvider,
  signFrodoRequest,
  DEFAULT_FRODO_KEY,
  DEFAULT_FRODO_SECRET,
} from "../../src/providers/douban-provider.js";
import type { MediaSearchCandidate, MediaSearchProvider } from "../../src/search-view.js";

describe("signFrodoRequest", () => {
  it("使用 HMAC-SHA1 产出可复现的签名", () => {
    const fixedNow = () => 1700000000;
    const { ts, sig } = signFrodoRequest("/api/v2/search/subjects", "GET", DEFAULT_FRODO_SECRET, fixedNow);
    expect(ts).toBe(1700000000);
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(10);
  });
});

describe("DoubanSearchProvider", () => {
  it("空查询直接返回空列表", async () => {
    const provider = new DoubanSearchProvider();
    const res = await provider.searchMedia({ query: "   " });
    expect(res).toEqual([]);
  });

  it("正常解析豆瓣 Frodo API 响应", async () => {
    const mockResponse = {
      total: 45,
      start: 0,
      count: 20,
      items: [
        {
          target_type: "tv",
          type_name: "电视剧",
          target_id: "2347485",
          target: {
            id: "2347485",
            title: "天道",
            card_subtitle: "中国大陆 / 剧情 / 王志文",
            year: "2008",
            cover_url: "https://img9.doubanio.com/p2374798402.jpg",
            rating: { value: 9.2, count: 120000 },
          },
        },
        {
          target_type: "movie",
          type_name: "电影",
          target_id: "1292052",
          target: {
            id: "1292052",
            title: "肖申克的救赎",
            card_subtitle: "美国 / 剧情",
            year: "1994",
            cover_url: "https://img9.doubanio.com/p480747492.jpg",
            rating: { value: 9.7, count: 2000000 },
          },
        },
      ],
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const provider = new DoubanSearchProvider({ fetchFn: mockFetch as unknown as typeof fetch });
    const pageResult = await provider.searchMediaPage({ query: "天道", page: 1 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("https://frodo.douban.com/api/v2/search/weixin");
    expect(calledUrl).toContain("apiKey=" + DEFAULT_FRODO_KEY);
    expect(calledUrl).toContain("start=0&count=30");

    expect(pageResult.source).toBe("douban");
    expect(pageResult.totalResults).toBe(45);
    expect(pageResult.totalPages).toBe(2);
    expect(pageResult.candidates.length).toBe(2);

    const tv = pageResult.candidates[0]!;
    expect(tv.title).toBe("天道");
    expect(tv.year).toBe(2008);
    expect(tv.mediaType).toBe("tv");
    expect(tv.tmdbId).toBe(2347485);
    expect(tv.source).toBe("douban");
    expect(tv.voteAverage).toBe(9.2);
    expect(tv.seasons.length).toBe(1);

    // 显式指定 pageSize=20 时
    const customResult = await provider.searchMediaPage({ query: "天道", page: 1, pageSize: 20 });
    const customUrl = mockFetch.mock.calls[1]![0] as string;
    expect(customUrl).toContain("start=0&count=20");
    expect(customResult.totalPages).toBe(3);

    const movie = pageResult.candidates[1]!;
    expect(movie.title).toBe("肖申克的救赎");
    expect(movie.year).toBe(1994);
    expect(movie.mediaType).toBe("movie");
    expect(movie.tmdbId).toBe(1292052);
    expect(movie.source).toBe("douban");
    expect(movie.seasons.length).toBe(0);
  });

  it("当上游返回非 200 或抛错时优雅降级为空数组，不崩溃", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network timeout"));
    const provider = new DoubanSearchProvider({ fetchFn: mockFetch as unknown as typeof fetch });
    const res = await provider.searchMedia({ query: "任意片名" });
    expect(res).toEqual([]);
  });
});

describe("FallbackSearchProvider", () => {
  it("Primary 源命中时，直接返回 Primary 结果，不调用 Fallback", async () => {
    const primaryCandidate: MediaSearchCandidate = {
      tmdbId: 100,
      mediaType: "movie",
      title: "流浪地球",
      originalTitle: "The Wandering Earth",
      year: 2019,
      overview: "太阳即将毁灭",
      posterPath: "/poster.jpg",
      backdropPath: null,
      seasons: [],
      source: "tmdb",
    };

    const primary: MediaSearchProvider = {
      searchMedia: vi.fn().mockResolvedValue([primaryCandidate]),
    };
    const fallback: MediaSearchProvider = {
      searchMedia: vi.fn().mockResolvedValue([]),
    };
    const onFallback = vi.fn();

    const provider = new FallbackSearchProvider(primary, fallback, { onFallback });
    const res = await provider.searchMedia({ query: "流浪地球" });

    expect(res).toEqual([primaryCandidate]);
    expect(fallback.searchMedia).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("Primary 源返回 0 结果时，优雅降级调用 Fallback 源", async () => {
    const fallbackCandidate: MediaSearchCandidate = {
      tmdbId: 2347485,
      mediaType: "tv",
      title: "天道",
      originalTitle: "天道",
      year: 2008,
      overview: "商界怪才丁元英",
      posterPath: "https://img9.doubanio.com/cover.jpg",
      backdropPath: null,
      seasons: [{ seasonNumber: 1, episodeCount: 24, latestAiredEpisode: 24 }],
      source: "douban",
    };

    const primary: MediaSearchProvider = {
      searchMedia: vi.fn().mockResolvedValue([]),
    };
    const fallback: MediaSearchProvider = {
      searchMedia: vi.fn().mockResolvedValue([fallbackCandidate]),
    };
    const onFallback = vi.fn();

    const provider = new FallbackSearchProvider(primary, fallback, { onFallback });
    const pageResult = await provider.searchMediaPage({ query: "天道", page: 1 });

    expect(primary.searchMedia).toHaveBeenCalledWith({ query: "天道", page: 1 });
    expect(fallback.searchMedia).toHaveBeenCalledWith({ query: "天道", page: 1 });
    expect(onFallback).toHaveBeenCalledWith("天道", "empty");
    expect(pageResult.source).toBe("douban");
    expect(pageResult.candidates).toEqual([fallbackCandidate]);
  });

  it("Primary 源抛出网络错误时，捕获错误并触发 Fallback 源兜底救场", async () => {
    const fallbackCandidate: MediaSearchCandidate = {
      tmdbId: 2347485,
      mediaType: "tv",
      title: "天道",
      originalTitle: "天道",
      year: 2008,
      overview: "商界怪才",
      posterPath: null,
      backdropPath: null,
      seasons: [],
      source: "douban",
    };

    const primary: MediaSearchProvider = {
      searchMedia: vi.fn().mockRejectedValue(new Error("GFW Connection reset")),
    };
    const fallback: MediaSearchProvider = {
      searchMedia: vi.fn().mockResolvedValue([fallbackCandidate]),
    };
    const onFallback = vi.fn();

    const provider = new FallbackSearchProvider(primary, fallback, { onFallback });
    const res = await provider.searchMedia({ query: "天道" });

    expect(onFallback).toHaveBeenCalledWith("天道", "error", expect.any(Error));
    expect(res).toEqual([fallbackCandidate]);
  });
});

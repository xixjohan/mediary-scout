import { describe, expect, it, vi } from "vitest";
import { doubanCacheKey, fetchDoubanRatingFromUpstream, getDoubanRating } from "./douban-rating";

describe("doubanCacheKey", () => {
  it("归一化标点符号、空格与大小写", () => {
    expect(doubanCacheKey("三体: 第一季", 2023)).toBe("douban:三体 第一季:2023");
    expect(doubanCacheKey("流浪地球 (2019)", 2019)).toBe("douban:流浪地球 2019 :2019");
    expect(doubanCacheKey("Avatar: The Way of Water", 2022)).toBe(
      "douban:avatar the way of water:2022",
    );
  });

  it("无年份时后缀为空串", () => {
    expect(doubanCacheKey("肖申克的救赎")).toBe("douban:肖申克的救赎:");
  });
});

describe("fetchDoubanRatingFromUpstream — 健壮性与降级契约", () => {
  it("网络报错或超时静默返回 null，绝不抛出异常", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network timeout"));

    const res = await fetchDoubanRatingFromUpstream("测试影片", 2024);
    expect(res).toBeNull();

    globalThis.fetch = originalFetch;
  });

  it("正确解析有效响应并提取评分与链接", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            target: {
              id: "1292052",
              title: "肖申克的救赎",
              rating: { value: 9.7, count: 2984512 },
              year: "1994",
            },
          },
        ],
      }),
    } as unknown as Response);

    const res = await fetchDoubanRatingFromUpstream("肖申克的救赎", 1994);
    expect(res).not.toBeNull();
    if (res) {
      expect(res.score).toBe(9.7);
      expect(res.voteCount).toBe(2984512);
      expect(res.doubanId).toBe("1292052");
      expect(res.doubanUrl).toBe("https://movie.douban.com/subject/1292052/");
    }

    globalThis.fetch = originalFetch;
  });

  it("当候选评分无效（如评分 0）时不选并降级为 null", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            target: {
              id: "999",
              title: "尚未上映的电影",
              rating: { value: 0, count: 0 },
              year: "2027",
            },
          },
        ],
      }),
    } as unknown as Response);

    const res = await fetchDoubanRatingFromUpstream("尚未上映的电影", 2027);
    expect(res).toBeNull();

    globalThis.fetch = originalFetch;
  });
});

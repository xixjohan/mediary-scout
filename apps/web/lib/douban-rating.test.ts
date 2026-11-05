import { describe, expect, it, vi } from "vitest";
import { doubanCacheKey, fetchDoubanRatingFromUpstream, getDoubanRating, getDoubanRatings } from "./douban-rating";

const { cacheValues, cacheMock } = vi.hoisted(() => {
  const cacheValues = new Map<string, unknown>();
  return {
    cacheValues,
    cacheMock: {
      getJson: vi.fn(async (key: string) => cacheValues.get(key) ?? null),
      setJson: vi.fn(async (key: string, value: unknown) => { cacheValues.set(key, value); }),
    },
  };
});

vi.mock("./durable-cache", () => ({ getDurableJsonCache: () => cacheMock }));

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

  it("超时计时器持续覆盖响应体读取", async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_input, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    } as unknown as Response));

    let settled = false;
    const result = fetchDoubanRatingFromUpstream("测试影片", 2024).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2500);
    expect(settled).toBe(true);
    await expect(result).resolves.toBeNull();

    globalThis.fetch = originalFetch;
    vi.useRealTimers();
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

describe("getDoubanRating cache behavior", () => {
  it("短期缓存空结果，重复打开页面不重复请求 Douban", async () => {
    cacheValues.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) } as unknown as Response);

    await expect(getDoubanRating("没有评分的影片", 2025)).resolves.toBeNull();
    await expect(getDoubanRating("没有评分的影片", 2025)).resolves.toBeNull();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(cacheMock.setJson).toHaveBeenCalledWith(
      doubanCacheKey("没有评分的影片", 2025),
      { kind: "negative" },
      expect.any(Number),
    );
    globalThis.fetch = originalFetch;
  });

  it("相同标题的并发冷缓存查询合并为一次上游请求", async () => {
    cacheValues.clear();
    const originalFetch = globalThis.fetch;
    let release!: (value: Response) => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));

    const first = getDoubanRating("并发影片", 2024);
    const second = getDoubanRating("并发影片", 2024);
    await Promise.resolve();
    await Promise.resolve();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    release({ ok: true, json: async () => ({ items: [] }) } as unknown as Response);
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);

    globalThis.fetch = originalFetch;
  });

  it("批量评分请求最多并发 6 个上游查询", async () => {
    cacheValues.clear();
    const originalFetch = globalThis.fetch;
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return { ok: true, json: async () => ({ items: [] }) } as unknown as Response;
    });

    await getDoubanRatings(Array.from({ length: 14 }, (_, index) => ({ title: `并发限制影片${index}`, year: 2024 })));

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(6);
    globalThis.fetch = originalFetch;
  });
});

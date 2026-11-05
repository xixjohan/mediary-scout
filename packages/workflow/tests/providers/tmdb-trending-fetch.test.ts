import { describe, expect, it, vi } from "vitest";
import { fetchTmdbList } from "../../src/providers/tmdb-provider.js";

describe("fetchTmdbList", () => {
  it("fetches a raw list path via the access chain and returns the parsed body", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      expect(url).toContain("/trending/movie/week");
      expect(url).toContain("language=zh-CN");
      return { results: [{ id: 1 }] };
    });
    const result = await fetchTmdbList(
      [{ baseURL: "https://proxy.example" }],
      "trending/movie/week",
      { language: "zh-CN" },
      { fetchJson },
    );
    expect(result).toEqual({ results: [{ id: 1 }] });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it("falls back to the second access when the first throws", async () => {
    const fetchJson = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ results: [] });
    const result = await fetchTmdbList(
      [{ baseURL: "https://a", readToken: "k" }, { baseURL: "https://b" }],
      "trending/tv/week",
      {},
      { fetchJson },
    );
    expect(result).toEqual({ results: [] });
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it("remembers failed accesses across list pages", async () => {
    const fetchJson = vi.fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValue({ results: [] });
    const accesses = [{ baseURL: "https://direct.example", readToken: "user-key" }, { baseURL: "https://proxy.example" }];
    const deadAccesses = new Set<string>();

    await fetchTmdbList(accesses, "discover/movie", { page: "1" }, { fetchJson, deadAccesses });
    await fetchTmdbList(accesses, "discover/movie", { page: "2" }, { fetchJson, deadAccesses });

    expect(fetchJson).toHaveBeenCalledTimes(3);
    expect([...deadAccesses]).toEqual(["https://direct.example\nuser-key"]);
  });
});

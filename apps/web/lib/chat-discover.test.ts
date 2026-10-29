import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  MOVIE_GENRES,
  TV_GENRES,
  resolveGenreId,
  executeDiscoverMedia,
} from "./chat-discover";

describe("chat-discover — 影视发现与防幻觉门禁", () => {
  it("分类 ID 正确映射", () => {
    expect(MOVIE_GENRES["科幻"]).toBe("878");
    expect(TV_GENRES["科幻"]).toBe("10765");
    expect(resolveGenreId("科幻电影", "movie")).toBe("878");
    expect(resolveGenreId("科幻剧", "tv")).toBe("10765");
    expect(resolveGenreId(undefined, "movie")).toBeUndefined();
  });

  it("executeDiscoverMedia 在离线/Demo 模式下平稳返回", async () => {
    const result = await executeDiscoverMedia({
      type: "movie",
      year: 2026,
      genre: "科幻",
    });

    expect(result.reply).toBeDefined();
    // 包含门禁提醒
    expect(result.reply).toContain("2026");
    expect(result.suggestedPrompts.length).toBeGreaterThan(0);
  });
});

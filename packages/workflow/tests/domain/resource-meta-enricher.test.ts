import { describe, expect, it } from "vitest";
import {
  CompositeResourceMetaExtractor,
  RawPayloadExtractionStrategy,
  TitleRegexExtractionStrategy,
} from "../../src/domain/resource-meta-enricher.js";

describe("TitleRegexExtractionStrategy (策略 B：标题正则智能解析)", () => {
  const strategy = new TitleRegexExtractionStrategy();

  it("成功提取常见体积单位 (GB / G / MB / TB)", () => {
    expect(strategy.extract("进击的巨人.The.Final.Season.2160p.12.8GB").sizeBytes).toBe(
      Math.round(12.8 * 1024 * 1024 * 1024)
    );

    expect(strategy.extract("[喵萌奶茶屋] 葬送的芙莉莲 [01-28][1080P/4.5G]").sizeBytes).toBe(
      Math.round(4.5 * 1024 * 1024 * 1024)
    );

    expect(strategy.extract("孤独摇滚! 简日双语 750MB").sizeBytes).toBe(
      750 * 1024 * 1024
    );

    expect(strategy.extract("奥本海默.2023.IMAX.Remux.1.5TB").sizeBytes).toBe(
      Math.round(1.5 * 1024 * 1024 * 1024 * 1024)
    );
  });

  it("不会将分辨率 (1080p) 或集号误识别为体积", () => {
    const meta = strategy.extract("[字幕组] 某科学的超电磁炮 1080p HEVC S01E05");
    expect(meta.sizeBytes).toBeUndefined();
  });

  it("成功提取日期与集数", () => {
    const meta = strategy.extract("间谍过家家 2024-10-15 全25集 1080p 8.2GB");
    expect(meta.postedAt).toBe("2024-10-15");
    expect(meta.fileCount).toBe(25);
    expect(meta.sizeBytes).toBe(Math.round(8.2 * 1024 * 1024 * 1024));
  });
});

describe("CompositeResourceMetaExtractor (策略模式级联组合)", () => {
  const composite = new CompositeResourceMetaExtractor();

  it("RawPayload 优先级高于 TitleRegex", () => {
    const meta = composite.resolve("剧集 1080p 15GB", {
      sizeBytes: 1234567,
      datetime: "2026-01-01T00:00:00Z",
      fileCount: 10,
    });
    expect(meta.sizeBytes).toBe(1234567);
    expect(meta.postedAt).toBe("2026-01-01T00:00:00Z");
    expect(meta.fileCount).toBe(10);
  });

  it("RawPayload 缺失时平滑回退到 TitleRegex", () => {
    const meta = composite.resolve("剧集 1080p 4.2G 2025-06-18 全12集", {});
    expect(meta.sizeBytes).toBe(Math.round(4.2 * 1024 * 1024 * 1024));
    expect(meta.postedAt).toBe("2025-06-18");
    expect(meta.fileCount).toBe(12);
  });
});

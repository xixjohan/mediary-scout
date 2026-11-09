import { describe, expect, it } from "vitest";
import type { ResourceCandidateView } from "../providers/resource-candidate-view.js";
import type { AcquisitionFilterPreferences } from "@media-track/contracts";
import {
  applyAcquisitionFilters,
  compileNegativeKeywordRegex,
  isAllowedContainer,
  passesSizeSanity,
} from "./acquisition-filter-pipeline.js";

function makeCandidate(title: string, sizeBytes?: number): ResourceCandidateView {
  return {
    candidateId: `c_${Math.random().toString(36).slice(2, 8)}`,
    title,
    type: "115",
    source: "test-source",
    ...(typeof sizeBytes === "number" ? { sizeBytes } : {}),
  };
}

describe("AcquisitionFilterPipeline — Micro-helpers", () => {
  it("compileNegativeKeywordRegex 编译排毒正则", () => {
    const re = compileNegativeKeywordRegex(["TXT", "OST", "解说", "预告片"]);
    expect(re).not.toBeNull();
    expect(re!.test("爱死亡和机器人 OST 原声大碟")).toBe(true);
    expect(re!.test("肖申克的救赎 经典解说版")).toBe(true);
    expect(re!.test("肖申克的救赎 1080p Bluray")).toBe(false);
  });

  it("isAllowedContainer 容器白名单校验", () => {
    const allowed = [".mkv", ".mp4", ".ts"];
    expect(isAllowedContainer("Title.S01E01.1080p.mkv", allowed)).toBe(true);
    expect(isAllowedContainer("Title.S01E01.1080p.MP4", allowed)).toBe(true);
    expect(isAllowedContainer("Title.S01E01.1080p.rar", allowed)).toBe(false);
    expect(isAllowedContainer("Title.S01E01.1080p.exe", allowed)).toBe(false);
    // 无文件扩展名的磁力包名不拦截
    expect(isAllowedContainer("Title S01 Complete 4K HDR", allowed)).toBe(true);
  });

  it("passesSizeSanity 物理体积下限安全闸门", () => {
    const prefs: AcquisitionFilterPreferences = {
      mode: "balanced",
      negativeKeywords: [],
      allowedContainers: [".mkv", ".mp4"],
      minMovieSizeBytes: 800 * 1024 * 1024,
      minSeriesEpisodeSizeBytes: 200 * 1024 * 1024,
      minAnimeEpisodeSizeBytes: 100 * 1024 * 1024,
    };
    expect(passesSizeSanity(500 * 1024 * 1024, "movie", prefs)).toBe(false);
    expect(passesSizeSanity(1500 * 1024 * 1024, "movie", prefs)).toBe(true);
    expect(passesSizeSanity(undefined, "movie", prefs)).toBe(true); // 未知体积放行由后续探针校验
  });
});

describe("applyAcquisitionFilters — 四层确定性排毒流水线", () => {
  const prefs: AcquisitionFilterPreferences = {
    mode: "strict",
    negativeKeywords: ["TXT", "OST", "解说", "花絮", "预告"],
    allowedContainers: [".mkv", ".mp4", ".ts"],
    minMovieSizeBytes: 800 * 1024 * 1024, // 800MB
    minSeriesEpisodeSizeBytes: 150 * 1024 * 1024, // 150MB
    minAnimeEpisodeSizeBytes: 80 * 1024 * 1024, // 80MB
  };

  it("Layer 1: 过滤黑名单关键词（有声书/解说/花絮等）", () => {
    const candidates = [
      makeCandidate("绝命毒师 S01 全集 4K Remux.mkv"),
      makeCandidate("绝命毒师 深度解说合集.mp4"),
      makeCandidate("绝命毒师 官方原声大碟 OST.flac"),
      makeCandidate("绝命毒师 幕后花絮特辑.mp4"),
    ];
    const result = applyAcquisitionFilters(candidates, prefs, { mediaType: "tv" });
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]?.title).toBe("绝命毒师 S01 全集 4K Remux.mkv");
    expect(result.filteredCount).toBe(3);
    expect(result.reasons.negativeKeyword).toBe(3);
  });

  it("Layer 2: 过滤非法容器格式（.zip, .exe, .iso）", () => {
    const candidates = [
      makeCandidate("肖申克的救赎.1994.Bluray.1080p.mkv"),
      makeCandidate("肖申克的救赎.1994.Bluray.1080p.iso"),
      makeCandidate("肖申克的救赎.1994.种子包.zip"),
    ];
    const result = applyAcquisitionFilters(candidates, prefs, { mediaType: "movie" });
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]?.title).toBe("肖申克的救赎.1994.Bluray.1080p.mkv");
    expect(result.reasons.disallowedContainer).toBe(2);
  });

  it("Layer 3: 电影/剧集体积下限过滤（防枪版与假样本）", () => {
    const candidates = [
      makeCandidate("星际穿越 4K.mkv", 15 * 1024 * 1024 * 1024),
      makeCandidate("星际穿越 抢先版.mp4", 300 * 1024 * 1024), // 300MB < 800MB
      makeCandidate("星际穿越 磁力链接"), // 未知放行
    ];
    const result = applyAcquisitionFilters(candidates, prefs, { mediaType: "movie" });
    expect(result.passed).toHaveLength(2);
    expect(result.passed.map((c) => c.title)).toEqual(["星际穿越 4K.mkv", "星际穿越 磁力链接"]);
    expect(result.reasons.sizeSanity).toBe(1);
  });
});

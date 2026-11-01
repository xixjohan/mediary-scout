import { describe, expect, it } from "vitest";
import type { ResourceCandidateView } from "@media-track/workflow";
import {
  DEFAULT_FILTER_CRITERIA,
  extractFacets,
  extractResolution,
  filterCandidates,
  matchesSpec,
  paginateCandidates,
  sortCandidates,
  type ResourceFilterCriteria,
} from "./resource-filter-model";

const sampleCandidates: ResourceCandidateView[] = [
  {
    candidateId: "c1",
    title: "阿凡达 1-2 合集 Avatar 1-2 2009-2022 UHD BluRay 2160p x265 10bit HDR 2Audio-SSDSSE 76.55GB",
    type: "magnet",
    source: "pansou",
    sizeBytes: 82194982912,
    postedAt: "2024-01-10T12:00:00.000Z",
    seeders: 45,
  },
  {
    candidateId: "c2",
    title: "阿凡达.Avatar.2009.Blu-ray.720P.x264.AAC-TYZH.北影公映国语，英语.mkv",
    type: "115",
    source: "pansou",
    sizeBytes: 4294967296,
    postedAt: "2023-05-01T08:00:00.000Z",
  },
  {
    candidateId: "c3",
    title: "阿凡达.Avatar.2009.Extended.UHD.Re-Grade.2160p.x265.10bit.HDR.2Audio-SSDSSE",
    type: "quark",
    source: "pansou",
    sizeBytes: 32212254720,
    postedAt: "2024-02-15T15:30:00.000Z",
  },
  {
    candidateId: "c4",
    title: "阿凡达.2009.Extended.Collector's.Edition.Hybrid.BluRay.1080p.x265.10bit.DDP5.1.Repack.H-SSDSSE",
    type: "115",
    source: "pansou",
    sizeBytes: 16106127360,
    postedAt: "2024-03-01T10:00:00.000Z",
  },
  {
    candidateId: "c5",
    title: "阿凡达.Avatar.2009.2160p.IMAX.Bluray.REMUX.TrueHD.7.1.Atmos.HEVC.mkv",
    type: "magnet",
    source: "pansou",
    sizeBytes: 64424509440,
    postedAt: "2024-04-01T12:00:00.000Z",
    seeders: 120,
  },
  {
    candidateId: "c6",
    title: "阿凡达.Avatar.2009.WEB-DL.1080p.H264.AAC-PTH",
    type: "uc",
    source: "pansou",
    sizeBytes: 8589934592,
    postedAt: "2023-11-20T09:00:00.000Z",
  },
];

describe("resource-filter-model 分面、过滤与分页核心域测试", () => {
  describe("extractResolution & matchesSpec", () => {
    it("准确识别 4K / 2160p / UHD", () => {
      expect(extractResolution("Movie.2024.2160p.HDR")).toBe("4k");
      expect(extractResolution("Movie 4k REMUX")).toBe("4k");
      expect(extractResolution("Movie UHD BluRay")).toBe("4k");
    });

    it("准确识别 1080p 与 720p", () => {
      expect(extractResolution("Movie.1080p.WEB-DL")).toBe("1080p");
      expect(extractResolution("Movie.FHD.x264")).toBe("1080p");
      expect(extractResolution("Movie.720p.HDTV")).toBe("720p");
      expect(extractResolution("Movie Without Res")).toBeUndefined();
    });

    it("准确识别规格 REMUX、BluRay、WEB-DL、HDR/DV", () => {
      expect(matchesSpec("Movie.REMUX.mkv", "remux")).toBe(true);
      expect(matchesSpec("Movie.BluRay.x264", "bluray")).toBe(true);
      expect(matchesSpec("Movie 蓝光原盘", "bluray")).toBe(true);
      expect(matchesSpec("Movie.WEB-DL.1080p", "web-dl")).toBe(true);
      expect(matchesSpec("Movie.2160p.HDR10+.Dolby Vision", "hdr_dv")).toBe(true);
    });
  });

  describe("extractFacets 标签统计与聚合", () => {
    it("正确聚合全部候选的类型、分辨率与制作规格统计", () => {
      const facets = extractFacets(sampleCandidates);

      // 类型统计
      const allType = facets.types.find((t) => t.value === "all");
      expect(allType?.count).toBe(6);
      const pan115Type = facets.types.find((t) => t.value === "115");
      expect(pan115Type?.count).toBe(2);
      const magnetType = facets.types.find((t) => t.value === "magnet");
      expect(magnetType?.count).toBe(2);

      // 分辨率统计 (c1: 4k, c2: 720p, c3: 4k, c4: 1080p, c5: 4k, c6: 1080p) => 4k:3, 1080p:2, 720p:1
      const res4k = facets.resolutions.find((r) => r.value === "4k");
      expect(res4k?.count).toBe(3);
      const res1080 = facets.resolutions.find((r) => r.value === "1080p");
      expect(res1080?.count).toBe(2);
      const res720 = facets.resolutions.find((r) => r.value === "720p");
      expect(res720?.count).toBe(1);

      // 规格统计
      const specRemux = facets.specs.find((s) => s.value === "remux");
      expect(specRemux?.count).toBe(1); // c5
      const specWebDl = facets.specs.find((s) => s.value === "web-dl");
      expect(specWebDl?.count).toBe(1); // c6
    });
  });

  describe("filterCandidates 组合过滤", () => {
    it("默认无过滤条件时，返回全部候选", () => {
      const res = filterCandidates(sampleCandidates, DEFAULT_FILTER_CRITERIA);
      expect(res).toHaveLength(6);
    });

    it("按名称关键词即时过滤", () => {
      const criteria: ResourceFilterCriteria = {
        ...DEFAULT_FILTER_CRITERIA,
        keyword: "Extended",
      };
      const res = filterCandidates(sampleCandidates, criteria);
      expect(res).toHaveLength(2); // c3, c4
      expect(res.every((c) => c.title.includes("Extended"))).toBe(true);
    });

    it("按网盘类型过滤", () => {
      const criteria: ResourceFilterCriteria = {
        ...DEFAULT_FILTER_CRITERIA,
        type: "115",
      };
      const res = filterCandidates(sampleCandidates, criteria);
      expect(res).toHaveLength(2);
      expect(res.map((c) => c.candidateId)).toEqual(["c2", "c4"]);
    });

    it("按画质与制作规格组合过滤 (4K + REMUX)", () => {
      const criteria: ResourceFilterCriteria = {
        ...DEFAULT_FILTER_CRITERIA,
        resolution: "4k",
        spec: "remux",
      };
      const res = filterCandidates(sampleCandidates, criteria);
      expect(res).toHaveLength(1);
      expect(res[0]?.candidateId).toBe("c5");
    });

    it("无匹配项时返回空数组", () => {
      const criteria: ResourceFilterCriteria = {
        ...DEFAULT_FILTER_CRITERIA,
        keyword: "不存在的生僻词",
      };
      const res = filterCandidates(sampleCandidates, criteria);
      expect(res).toHaveLength(0);
    });
  });

  describe("sortCandidates 排序策略", () => {
    it("按大小降序排序", () => {
      const res = sortCandidates(sampleCandidates, "size_desc");
      expect(res[0]?.candidateId).toBe("c1"); // 76.55GB
      expect(res[1]?.candidateId).toBe("c5"); // 64GB
      expect(res[res.length - 1]?.candidateId).toBe("c2"); // 4GB
    });

    it("按发布日期降序排序", () => {
      const res = sortCandidates(sampleCandidates, "date_desc");
      expect(res[0]?.candidateId).toBe("c5"); // 2024-04-01
      expect(res[1]?.candidateId).toBe("c4"); // 2024-03-01
    });

    it("按做种数降序排序", () => {
      const res = sortCandidates(sampleCandidates, "seeders_desc");
      expect(res[0]?.candidateId).toBe("c5"); // 120 seeders
      expect(res[1]?.candidateId).toBe("c1"); // 45 seeders
    });
  });

  describe("paginateCandidates 分页截取与钳位保护", () => {
    it("标准分页切分", () => {
      const result = paginateCandidates(sampleCandidates, 1, 2);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.candidateId).toBe("c1");
      expect(result.items[1]?.candidateId).toBe("c2");
      expect(result.totalPages).toBe(3);
      expect(result.currentPage).toBe(1);
      expect(result.hasPrev).toBe(false);
      expect(result.hasNext).toBe(true);
      expect(result.startIndex).toBe(1);
      expect(result.endIndex).toBe(2);
    });

    it("末页计算与无后续保护", () => {
      const result = paginateCandidates(sampleCandidates, 3, 2);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.candidateId).toBe("c5");
      expect(result.items[1]?.candidateId).toBe("c6");
      expect(result.hasPrev).toBe(true);
      expect(result.hasNext).toBe(false);
      expect(result.startIndex).toBe(5);
      expect(result.endIndex).toBe(6);
    });

    it("超界页码自动安全钳位", () => {
      const result = paginateCandidates(sampleCandidates, 999, 2);
      expect(result.currentPage).toBe(3); // 自动钳位到最后一页
      expect(result.items).toHaveLength(2);
    });

    it("空数组分页返回干净空态", () => {
      const result = paginateCandidates([], 1, 10);
      expect(result.items).toEqual([]);
      expect(result.totalItems).toBe(0);
      expect(result.totalPages).toBe(1);
      expect(result.currentPage).toBe(1);
      expect(result.startIndex).toBe(0);
      expect(result.endIndex).toBe(0);
      expect(result.hasPrev).toBe(false);
      expect(result.hasNext).toBe(false);
    });
  });
});

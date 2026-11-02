import { describe, expect, it } from "vitest";
import type { TitleHubSeason } from "../../../lib/title-hub";
import {
  extractMissingEpisodes,
  filterMissingBySeason,
  paginateMissingEpisodes,
  parseEpisodeNumber,
  type MissingEpisodeItem,
} from "./missing-episodes-model";

function createMockSeason(
  seasonNumber: number,
  tracked: boolean,
  episodesConfig: Array<{ code: string; displayState: "obtained" | "missing_aired" | "unaired" }>,
): TitleHubSeason {
  return {
    seasonNumber,
    totalEpisodes: episodesConfig.length,
    latestAiredEpisode: episodesConfig.length,
    tracked,
    status: tracked ? "active" : null,
    obtainedCount: episodesConfig.filter((e) => e.displayState === "obtained").length,
    missingAiredCount: episodesConfig.filter((e) => e.displayState === "missing_aired").length,
    trackedSeasonId: tracked ? `season_${seasonNumber}` : null,
    episodes: episodesConfig.map((c) => ({
      episodeCode: c.code,
      airStatus: c.displayState === "unaired" ? "unaired" : "aired",
      obtained: c.displayState === "obtained",
      metadataStatus: "confirmed",
      verifiedFileCount: c.displayState === "obtained" ? 1 : 0,
      displayState: c.displayState,
    })),
  };
}

describe("missing-episodes-model 缺集提取、过滤与分页域测试", () => {
  describe("parseEpisodeNumber", () => {
    it("正确解析标准 SxxExx 集号", () => {
      expect(parseEpisodeNumber("S01E05")).toBe(5);
      expect(parseEpisodeNumber("S02E105")).toBe(105);
      expect(parseEpisodeNumber("s03e12")).toBe(12);
    });

    it("正确解析长篇动漫 1000+ 集", () => {
      expect(parseEpisodeNumber("S01E1085")).toBe(1085);
      expect(parseEpisodeNumber("E1100")).toBe(1100);
    });

    it("正确解析中文第N集", () => {
      expect(parseEpisodeNumber("第 8 集")).toBe(8);
      expect(parseEpisodeNumber("第24集")).toBe(24);
    });

    it("无效输入安全回退为 1", () => {
      expect(parseEpisodeNumber("invalid")).toBe(1);
      expect(parseEpisodeNumber("")).toBe(1);
    });
  });

  describe("extractMissingEpisodes 跨季缺集聚合", () => {
    it("未追踪的季不提取缺集", () => {
      const seasons = [
        createMockSeason(1, false, [
          { code: "S01E01", displayState: "missing_aired" },
          { code: "S01E02", displayState: "missing_aired" },
        ]),
      ];
      expect(extractMissingEpisodes(seasons)).toEqual([]);
    });

    it("正确提取跨季缺失集并按季、集顺序排序", () => {
      const seasons = [
        createMockSeason(2, true, [
          { code: "S02E01", displayState: "obtained" },
          { code: "S02E02", displayState: "missing_aired" },
        ]),
        createMockSeason(1, true, [
          { code: "S01E01", displayState: "obtained" },
          { code: "S01E02", displayState: "missing_aired" },
          { code: "S01E03", displayState: "missing_aired" },
          { code: "S01E04", displayState: "unaired" }, // 未播不计入
        ]),
      ];

      const missing = extractMissingEpisodes(seasons);
      expect(missing).toHaveLength(3);
      // 排序必须为 S01E02, S01E03, S02E02
      expect(missing[0]?.episodeCode).toBe("S01E02");
      expect(missing[0]?.seasonNumber).toBe(1);
      expect(missing[0]?.episodeNumber).toBe(2);
      expect(missing[1]?.episodeCode).toBe("S01E03");
      expect(missing[2]?.episodeCode).toBe("S02E02");
    });

    it("冷启动未初始化逐集表时，根据 latestAiredEpisode 与 obtainedCount 降级合成缺集", () => {
      const coldSeason: TitleHubSeason = {
        seasonNumber: 1,
        totalEpisodes: 10,
        latestAiredEpisode: 8,
        tracked: true,
        status: "active",
        obtainedCount: 5,
        missingAiredCount: 3,
        trackedSeasonId: "season_1",
        episodes: [],
      };
      const missing = extractMissingEpisodes([coldSeason]);
      expect(missing).toHaveLength(3);
      expect(missing[0]?.episodeCode).toBe("S01E06");
      expect(missing[2]?.episodeCode).toBe("S01E08");
    });
  });

  describe("filterMissingBySeason 按季过滤", () => {
    const items: MissingEpisodeItem[] = [
      { id: "1_2", episodeCode: "S01E02", seasonNumber: 1, episodeNumber: 2, displayCode: "第 2 集", displayState: "missing_aired" },
      { id: "1_3", episodeCode: "S01E03", seasonNumber: 1, episodeNumber: 3, displayCode: "第 3 集", displayState: "missing_aired" },
      { id: "2_1", episodeCode: "S02E01", seasonNumber: 2, episodeNumber: 1, displayCode: "第 1 集", displayState: "missing_aired" },
    ];

    it("all 返回全部", () => {
      expect(filterMissingBySeason(items, "all")).toHaveLength(3);
    });

    it("按指定季号过滤", () => {
      const s1 = filterMissingBySeason(items, 1);
      expect(s1).toHaveLength(2);
      expect(s1.every((i) => i.seasonNumber === 1)).toBe(true);

      const s2 = filterMissingBySeason(items, 2);
      expect(s2).toHaveLength(1);
      expect(s2[0]?.seasonNumber).toBe(2);

      const s3 = filterMissingBySeason(items, 3);
      expect(s3).toHaveLength(0);
    });
  });

  describe("paginateMissingEpisodes 分页安全切片", () => {
    const items: MissingEpisodeItem[] = Array.from({ length: 25 }, (_, idx) => {
      const ep = idx + 1;
      return {
        id: `1_${ep}`,
        episodeCode: `S01E${String(ep).padStart(2, "0")}`,
        seasonNumber: 1,
        episodeNumber: ep,
        displayCode: `第 ${ep} 集`,
        displayState: "missing_aired",
      };
    });

    it("正确分页第 1 页", () => {
      const res = paginateMissingEpisodes(items, 1, 10);
      expect(res.items).toHaveLength(10);
      expect(res.currentPage).toBe(1);
      expect(res.totalPages).toBe(3);
      expect(res.hasPrev).toBe(false);
      expect(res.hasNext).toBe(true);
      expect(res.items[0]?.episodeNumber).toBe(1);
      expect(res.items[9]?.episodeNumber).toBe(10);
    });

    it("正确分页最后一页", () => {
      const res = paginateMissingEpisodes(items, 3, 10);
      expect(res.items).toHaveLength(5);
      expect(res.currentPage).toBe(3);
      expect(res.hasPrev).toBe(true);
      expect(res.hasNext).toBe(false);
      expect(res.items[0]?.episodeNumber).toBe(21);
      expect(res.items[4]?.episodeNumber).toBe(25);
    });

    it("超界页码安全钳位", () => {
      const res = paginateMissingEpisodes(items, 999, 10);
      expect(res.currentPage).toBe(3);
      expect(res.items).toHaveLength(5);
    });

    it("空集安全返回", () => {
      const res = paginateMissingEpisodes([], 1, 10);
      expect(res.items).toEqual([]);
      expect(res.totalItems).toBe(0);
      expect(res.totalPages).toBe(1);
    });
  });
});

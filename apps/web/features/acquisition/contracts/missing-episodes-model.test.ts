import { describe, expect, it } from "vitest";
import type { TitleHubSeason } from "../../../lib/title-hub";
import {
  extractMissingEpisodes,
  isSeasonEpisodeStateIncomplete,
  filterMissingBySeason,
  paginateMissingEpisodes,
  parseEpisodeNumber,
  sliceSeasonEpisodes,
  SEASON_CHUNK_SIZE,
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
    it("对部分或未知逐集状态显示待同步，不误报完整", () => {
      const season = createMockSeason(1, true, [{ code: "S01E01", displayState: "unaired" }]);
      expect(isSeasonEpisodeStateIncomplete(season)).toBe(false);
      expect(isSeasonEpisodeStateIncomplete({ ...season, totalEpisodes: 2 })).toBe(true);
      expect(isSeasonEpisodeStateIncomplete({ ...season, episodes: [{ ...season.episodes[0]!, airStatus: "unknown", displayState: "unknown" }] })).toBe(true);
    });
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

    it("冷启动未初始化逐集表时，不推断具体缺集", () => {
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
      expect(missing).toEqual([]);
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

  describe("sliceSeasonEpisodes 超长季分段切片算法测试 (1555集动漫防撑破)", () => {
    it("常规季 (<= 100 集，如 23 集) 无切片，直出全量", () => {
      const eps = Array.from({ length: 23 }, (_, i) => ({ ep: i + 1 }));
      const result = sliceSeasonEpisodes(eps, 0, SEASON_CHUNK_SIZE);
      expect(result.totalChunks).toBe(1);
      expect(result.chunks).toEqual([{ chunkIndex: 0, startEp: 1, endEp: 23 }]);
      expect(result.currentChunk).toBe(0);
      expect(result.sliced).toHaveLength(23);
      expect(result.sliced).toBe(eps); // 保持原数组引用，避免无效重渲染
    });

    it("超长季 (1555 集) 正确划分为 16 个分段胶囊，并将当前 DOM 节点锐减 93%", () => {
      const eps = Array.from({ length: 1555 }, (_, i) => ({ ep: i + 1 }));
      const result = sliceSeasonEpisodes(eps, 0, 100);

      expect(result.totalChunks).toBe(16);
      expect(result.chunks).toHaveLength(16);
      // 第 1 分段: 1-100
      expect(result.chunks[0]).toEqual({ chunkIndex: 0, startEp: 1, endEp: 100 });
      // 第 2 分段: 101-200
      expect(result.chunks[1]).toEqual({ chunkIndex: 1, startEp: 101, endEp: 200 });
      // 最终分段: 1501-1555
      expect(result.chunks[15]).toEqual({ chunkIndex: 15, startEp: 1501, endEp: 1555 });

      // 当前展示切片只有 100 集
      expect(result.sliced).toHaveLength(100);
      expect(result.sliced[0]?.ep).toBe(1);
      expect(result.sliced[99]?.ep).toBe(100);
    });

    it("切换至中间分段与末尾分段", () => {
      const eps = Array.from({ length: 1555 }, (_, i) => ({ ep: i + 1 }));

      // 切换至 chunk 1 (101-200)
      const chunk1 = sliceSeasonEpisodes(eps, 1, 100);
      expect(chunk1.currentChunk).toBe(1);
      expect(chunk1.sliced).toHaveLength(100);
      expect(chunk1.sliced[0]?.ep).toBe(101);
      expect(chunk1.sliced[99]?.ep).toBe(200);

      // 切换至最后一分段 (1501-1555)
      const lastChunk = sliceSeasonEpisodes(eps, 15, 100);
      expect(lastChunk.currentChunk).toBe(15);
      expect(lastChunk.sliced).toHaveLength(55);
      expect(lastChunk.sliced[0]?.ep).toBe(1501);
      expect(lastChunk.sliced[54]?.ep).toBe(1555);
    });

    it("分段索引越界防护 (安全钳位)", () => {
      const eps = Array.from({ length: 1555 }, (_, i) => ({ ep: i + 1 }));

      // 向上越界 -> 钳位到最后一个有效分段 15
      const overflow = sliceSeasonEpisodes(eps, 999, 100);
      expect(overflow.currentChunk).toBe(15);
      expect(overflow.sliced).toHaveLength(55);

      // 向下越界 -> 钳位到分段 0
      const underflow = sliceSeasonEpisodes(eps, -5, 100);
      expect(underflow.currentChunk).toBe(0);
      expect(underflow.sliced).toHaveLength(100);
    });

    it("空集安全返回", () => {
      const empty = sliceSeasonEpisodes([], 0, 100);
      expect(empty.totalChunks).toBe(0);
      expect(empty.chunks).toEqual([]);
      expect(empty.currentChunk).toBe(0);
      expect(empty.sliced).toEqual([]);
    });
  });
});

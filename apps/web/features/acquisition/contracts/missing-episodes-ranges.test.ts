import { describe, expect, it } from "vitest";
import {
  describeEpisodeRanges,
  filterMissingByEpisodeRanges,
  type EpisodeRange,
  type MissingEpisodeItem,
} from "./missing-episodes-model";

function item(seasonNumber: number, episodeNumber: number): MissingEpisodeItem {
  return {
    id: `${seasonNumber}_${episodeNumber}`,
    episodeCode: `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`,
    seasonNumber,
    episodeNumber,
    displayCode: `第 ${episodeNumber} 集`,
    displayState: "missing_aired",
  };
}

describe("filterMissingByEpisodeRanges", () => {
  it("无范围配置时保持原样（不误伤）", () => {
    const items = [item(1, 1), item(1, 190)];
    expect(filterMissingByEpisodeRanges(items, [])).toHaveLength(2);
    expect(filterMissingByEpisodeRanges(items, null)).toHaveLength(2);
  });

  it("按起始集过滤（E190 起）", () => {
    const ranges: EpisodeRange[] = [{ seasonNumber: 1, startEpisode: 190, endEpisode: null }];
    const items = [item(1, 1), item(1, 189), item(1, 190), item(1, 199)];
    expect(filterMissingByEpisodeRanges(items, ranges).map((i) => i.episodeNumber)).toEqual([190, 199]);
  });

  it("结束集为 null 表示不限", () => {
    const ranges: EpisodeRange[] = [{ seasonNumber: 1, startEpisode: 190, endEpisode: null }];
    expect(filterMissingByEpisodeRanges([item(1, 500)], ranges)).toHaveLength(1);
  });

  it("结束集有值时双向收窄", () => {
    const ranges: EpisodeRange[] = [{ seasonNumber: 1, startEpisode: 10, endEpisode: 12 }];
    const items = [item(1, 9), item(1, 10), item(1, 12), item(1, 13)];
    expect(filterMissingByEpisodeRanges(items, ranges).map((i) => i.episodeNumber)).toEqual([10, 12]);
  });

  it("未配置范围的季不受影响", () => {
    const ranges: EpisodeRange[] = [{ seasonNumber: 1, startEpisode: 190, endEpisode: null }];
    const items = [item(1, 5), item(2, 5)];
    expect(filterMissingByEpisodeRanges(items, ranges).map((i) => i.seasonNumber)).toEqual([2]);
  });
});

describe("describeEpisodeRanges", () => {
  it("渲染简短文案并按季排序", () => {
    expect(
      describeEpisodeRanges([
        { seasonNumber: 2, startEpisode: 1, endEpisode: 12 },
        { seasonNumber: 1, startEpisode: 190, endEpisode: null },
      ]),
    ).toBe("第 1 季 E190–不限 · 第 2 季 E1–E12");
  });

  it("空数组返回空串", () => {
    expect(describeEpisodeRanges([])).toBe("");
  });
});

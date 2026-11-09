import { describe, expect, it } from "vitest";
import {
  arbitrateReleasePack,
  classifyReleasePack,
} from "./pack-episode-arbitrator.js";

describe("classifyReleasePack", () => {
  it("正确识别全季合集大包", () => {
    expect(classifyReleasePack("[DBD-Raws] 孤独摇滚 S01 Complete [1080p BDRip]").kind).toBe("season_pack");
    expect(classifyReleasePack("葬送的芙莉莲 第1季 全集 4K Remux").kind).toBe("season_pack");
    expect(classifyReleasePack("[VCB-Studio] 无职转生 [全23话] [BDRip]").kind).toBe("season_pack");
    expect(classifyReleasePack("进击的巨人 Season 1 Complete").kind).toBe("season_pack");
  });

  it("正确识别分段合包", () => {
    const res1 = classifyReleasePack("[NC-Raws] 某动漫 01-12 [1080p]");
    expect(res1.kind).toBe("partial_pack");
    expect(res1.startEpisode).toBe(1);
    expect(res1.endEpisode).toBe(12);

    const res2 = classifyReleasePack("剧名 S01E01-E06 1080p");
    expect(res2.kind).toBe("partial_pack");
    expect(res2.startEpisode).toBe(1);
    expect(res2.endEpisode).toBe(6);
  });

  it("正确识别单集资源", () => {
    const res1 = classifyReleasePack("[SubGroup] 葬送的芙莉莲 S01E11 [1080p]");
    expect(res1.kind).toBe("single_episode");
    expect(res1.startEpisode).toBe(11);

    const res2 = classifyReleasePack("剧名 EP05 [1080p]");
    expect(res2.kind).toBe("single_episode");
    expect(res2.startEpisode).toBe(5);

    const res3 = classifyReleasePack("[极影字幕社] 无职转生 [08] [1080p]");
    expect(res3.kind).toBe("single_episode");
    expect(res3.startEpisode).toBe(8);
  });
});

describe("arbitrateReleasePack", () => {
  it("缺 1 集 (1/12) 时，严格拒绝全季大包以节省配额与暂存空间", () => {
    const verdict = arbitrateReleasePack({
      resourceName: "[DBD-Raws] 剧名 S01 Complete [1080p BDRip]",
      missingEpisodesCount: 1,
      totalEpisodesCount: 12,
    });

    expect(verdict.verdict).toBe("reject");
    expect(verdict.reason).toBe("pack_rejected_few_missing");
    expect(verdict.scoreModifier).toBeLessThan(0);
    expect(verdict.explanation).toContain("仅缺 1/12 集");
  });

  it("缺 1 集 (1/12) 时，优先放行并加分单集资源", () => {
    const verdict = arbitrateReleasePack({
      resourceName: "[SubGroup] 剧名 S01E11 [1080p]",
      missingEpisodesCount: 1,
      totalEpisodesCount: 12,
    });

    expect(verdict.verdict).toBe("allow");
    expect(verdict.reason).toBe("single_allowed");
    expect(verdict.scoreModifier).toBeGreaterThan(0);
  });

  it("大面积缺集 (10/12) 时，优先提拔整季大包一次性补全以节省配额", () => {
    const verdict = arbitrateReleasePack({
      resourceName: "[DBD-Raws] 剧名 S01 Complete [1080p BDRip]",
      missingEpisodesCount: 10,
      totalEpisodesCount: 12,
    });

    expect(verdict.verdict).toBe("allow");
    expect(verdict.reason).toBe("pack_preferred_many_missing");
    expect(verdict.scoreModifier).toBe(50);
    expect(verdict.explanation).toContain("优先整季大包一次性补全");
  });

  it("边界安全：0 集缺失或空输入安全处理", () => {
    const verdict = arbitrateReleasePack({
      resourceName: "",
      missingEpisodesCount: 0,
      totalEpisodesCount: 12,
    });

    expect(verdict.verdict).toBe("allow");
    expect(verdict.classification.kind).toBe("unknown");
  });
});

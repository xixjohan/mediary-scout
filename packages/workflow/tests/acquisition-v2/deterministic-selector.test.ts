import { describe, expect, it, vi } from "vitest";
import {
  executeDeterministicFallback,
  pickBestCandidate,
  scoreCandidate,
  type CandidateLike,
} from "../../src/acquisition-v2/deterministic-selector.js";

describe("scoreCandidate", () => {
  it("根据 4K 偏好优先给 2160p 打高分", () => {
    const c4k: CandidateLike = {
      id: "1",
      title: "流浪地球2 2023 2160p UHD HDR 内嵌中字",
      seeders: 10,
      sizeBytes: 15 * 1024 * 1024 * 1024,
    };
    const c1080p: CandidateLike = {
      id: "2",
      title: "流浪地球2 2023 1080p HD",
    };

    expect(scoreCandidate(c4k, "4K")).toBeGreaterThan(scoreCandidate(c1080p, "4K"));
  });


  it("密码压缩包与可执行木马假种被严重扣分并淘汰", () => {
    const passwordJunk: CandidateLike = {
      id: "junk1",
      title: "流浪地球2 2160p 密码在压缩包内.rar",
    };
    const exeJunk: CandidateLike = {
      id: "junk2",
      title: "流浪地球2 setup.exe 播放器安装",
    };

    expect(scoreCandidate(passwordJunk, "4K")).toBeLessThan(-200);
    expect(scoreCandidate(exeJunk, "4K")).toBeLessThan(-500);
  });

  it("当仅缺 1 集 (1/12) 时，裁决器联动导致整季大包被扣分并淘汰", () => {
    const completePack: CandidateLike = {
      id: "pack",
      title: "剧名 S01 Complete 1080p BDRip",
    };
    const singleEp: CandidateLike = {
      id: "single",
      title: "剧名 S01E11 1080p WebRip",
    };

    const candidates = [completePack, singleEp];
    const best = pickBestCandidate(candidates, "1080p", {
      missingEpisodesCount: 1,
      totalEpisodesCount: 12,
    });

    expect(best?.id).toBe("single");
  });

  it("预告片/花絮被严重扣分", () => {
    const trailer: CandidateLike = {
      id: "3",
      title: "流浪地球2 预告片 Trailer 1080p",
    };
    expect(scoreCandidate(trailer, "1080p")).toBeLessThan(0);
  });
});

describe("pickBestCandidate", () => {
  it("从候选池中挑出最优项", () => {
    const candidates: CandidateLike[] = [
      {
        id: "low",
        title: "流浪地球2 720p",
      },
      {
        id: "best",
        title: "流浪地球2 2160p 4K 内嵌中字",
        seeders: 25,
      },
    ];

    const best = pickBestCandidate(candidates, "4K");
    expect(best?.id).toBe("best");
  });

  it("空列表返回 null", () => {
    expect(pickBestCandidate([], "4K")).toBeNull();
  });
});

describe("executeDeterministicFallback", () => {
  it("转存剧集后自动执行规范化重命名并保留技术标签", async () => {
    const renamesSpy = vi.fn().mockResolvedValue({ success: true, count: 1 });
    const fakeSandbox = {
      getObservedSnapshots: () => [
        {
          id: "snap1",
          keyword: "桃源暗鬼",
          searchedAt: new Date().toISOString(),
          candidates: [
            {
              id: "cand1",
              title: "[LoliHouse] TOUGEN ANKI - 02 [WebRip 1080p HEVC-10bit AAC].mkv",
              seeders: 5,
              sizeBytes: 600 * 1024 * 1024,
            },
          ],
        },
      ],
      transferCandidate: vi.fn().mockResolvedValue(undefined),
      inspectStaging: vi.fn().mockResolvedValue([
        { id: "f1", path: "/staging/[LoliHouse] TOUGEN ANKI - 02 [WebRip 1080p HEVC-10bit AAC].mkv", size: 600 * 1024 * 1024 },
      ]),
      moveToSeason: vi.fn().mockResolvedValue(undefined),
      getPrimaryTitle: () => "桃源暗鬼",
      renameTargetFiles: renamesSpy,
      markObtained: vi.fn().mockResolvedValue(undefined),
      discardStaging: vi.fn().mockResolvedValue(undefined),
      finish: vi.fn().mockResolvedValue(undefined),
    } as any;

    const result = await executeDeterministicFallback(fakeSandbox, {
      movie: false,
      qualityPreference: "1080p",
      keyword: "桃源暗鬼",
    });

    expect(result.success).toBe(true);
    expect(fakeSandbox.moveToSeason).toHaveBeenCalledWith({
      moves: [{ season: 1, fileIds: ["f1"] }],
    });
    expect(renamesSpy).toHaveBeenCalledWith({
      season: 1,
      renames: [
        {
          fileId: "f1",
          newName: "桃源暗鬼 - S01E02 [LoliHouse] [WebRip 1080p HEVC-10bit AAC].mkv",
        },
      ],
    });
    expect(fakeSandbox.markObtained).toHaveBeenCalledWith({
      codes: ["S01E02"],
    });
  });
});

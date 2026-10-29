import { describe, expect, it } from "vitest";
import {
  pickBestCandidate,
  scoreCandidate,
  type CandidateLike,
} from "../src/acquisition-v2/deterministic-selector.js";

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

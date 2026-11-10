import { describe, expect, it } from "vitest";
import {
  DefaultVersionRanker,
  isExtraOrSample,
  isJunkFile,
  isVideoFile,
  scoreMediaFile,
} from "../../src/execution/version-ranker.js";

describe("version-ranker", () => {
  it("identifies video and junk files correctly", () => {
    expect(isVideoFile("movie.mp4")).toBe(true);
    expect(isVideoFile("movie.mkv")).toBe(true);
    expect(isVideoFile("movie.ts")).toBe(true);
    expect(isVideoFile("info.nfo")).toBe(false);
    expect(isJunkFile("promo.url")).toBe(true);
    expect(isJunkFile("readme.txt")).toBe(true);
    expect(isExtraOrSample("movie-trailer.mp4")).toBe(true);
    expect(isExtraOrSample("movie-sample.mkv")).toBe(true);
    expect(isExtraOrSample("featurette.mp4")).toBe(true);
    expect(isExtraOrSample("main-feature.mp4", 2 * 1024 * 1024 * 1024)).toBe(false);
  });

  it("scores media files with preference for 4K / REMUX / HDR", () => {
    const score4k = scoreMediaFile("The.Movie.2026.2160p.UHD.REMUX.HEVC.DV.Atmos.mkv", 30 * 1024 * 1024 * 1024, "4K");
    const score1080p = scoreMediaFile("The.Movie.2026.1080p.BluRay.x264.DDP5.1.mkv", 8 * 1024 * 1024 * 1024, "4K");
    const score720p = scoreMediaFile("The.Movie.2026.720p.HDTV.x264.mkv", 2 * 1024 * 1024 * 1024, "4K");

    expect(score4k).toBeGreaterThan(score1080p);
    expect(score1080p).toBeGreaterThan(score720p);
  });

  it("ranks movie candidates and isolates redundant versions", () => {
    const ranker = new DefaultVersionRanker();
    const candidates = [
      {
        id: "f1",
        name: "The.Hotel.New.Hampshire.1984.1080p.BluRay.x264-RARBG.mp4",
        sizeBytes: 2 * 1024 * 1024 * 1024,
      },
      {
        id: "f2",
        name: "The Hotel New Hampshire (1984) [1080p] [BluRay] [YTS.MX].mp4",
        sizeBytes: 1.5 * 1024 * 1024 * 1024,
      },
      {
        id: "f3",
        name: "The.Hotel.New.Hampshire.1984.2160p.UHD.REMUX.HEVC.DV-AMIABLE.mkv",
        sizeBytes: 18 * 1024 * 1024 * 1024,
      },
      {
        id: "f4",
        name: "The.Hotel.New.Hampshire.1984-trailer.mp4",
        sizeBytes: 50 * 1024 * 1024,
      },
    ];

    const result = ranker.rankMovieCandidates(candidates, "4K");
    expect(result.primary?.id).toBe("f3"); // 2160p REMUX selected as primary
    expect(result.redundant.map((r) => r.id)).toEqual(["f1", "f2"]); // other full versions redundant
    expect(result.extras.map((e) => e.id)).toEqual(["f4"]); // trailer marked as extra
  });

  it("ranks TV candidates per episode and detects redundant copies", () => {
    const ranker = new DefaultVersionRanker();
    const candidates = [
      { id: "e1_baha", name: "[ANI] 桃源暗鬼 - 01 [Baha][1080P].mp4", sizeBytes: 600 * 1024 * 1024 },
      { id: "e1_loli", name: "[LoliHouse] Tougen Anki - 01 [WebRip 1080p HEVC-10bit].mkv", sizeBytes: 800 * 1024 * 1024 },
      { id: "e2_baha", name: "[ANI] 桃源暗鬼 - 02 [Baha][1080P].mp4", sizeBytes: 600 * 1024 * 1024 },
      { id: "e3_loli", name: "[LoliHouse] Tougen Anki - 03 [WebRip 1080p HEVC-10bit].mkv", sizeBytes: 800 * 1024 * 1024 },
      { id: "promo", name: "Tougen Anki PV01.mp4", sizeBytes: 30 * 1024 * 1024 },
    ];

    const result = ranker.rankTvCandidates(candidates, 1);
    expect(result.primary.get("S01E01")?.id).toBe("e1_loli"); // HEVC 10bit higher score than plain mp4
    expect(result.primary.get("S01E02")?.id).toBe("e2_baha");
    expect(result.primary.get("S01E03")?.id).toBe("e3_loli");
    expect(result.redundant.map((r) => r.id)).toEqual(["e1_baha"]); // duplicate E01 marked redundant
    expect(result.extras.map((e) => e.id)).toEqual(["promo"]);
  });
});

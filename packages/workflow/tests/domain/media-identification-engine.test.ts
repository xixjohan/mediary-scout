import { describe, expect, it } from "vitest";
import { identifyMediaFile, parseSeasonFromDirName } from "../../src/domain/media-identification-engine.js";

describe("MediaIdentificationEngine", () => {
  it("should parse season from directory names correctly", () => {
    expect(parseSeasonFromDirName("Season 01")).toBe(1);
    expect(parseSeasonFromDirName("Season 2")).toBe(2);
    expect(parseSeasonFromDirName("S03")).toBe(3);
    expect(parseSeasonFromDirName("第1季")).toBe(1);
    expect(parseSeasonFromDirName("第二季")).toBe(2);
    expect(parseSeasonFromDirName("电影专区")).toBeNull();
  });

  it("should identify standard TV episode with Season folder", () => {
    const result = identifyMediaFile({
      fileName: "Breaking.Bad.S01E05.1080p.BluRay.x265.mkv",
      parentDirName: "Season 01",
      grandParentDirName: "Breaking Bad (2008) {tmdb-1396}",
      libraryType: "tv",
    });

    expect(result.mediaType).toBe("tv");
    expect(result.title).toBe("Breaking Bad");
    expect(result.tmdbId).toBe(1396);
    expect(result.year).toBe(2008);
    expect(result.seasonNumber).toBe(1);
    expect(result.episodeNumber).toBe(5);
    expect(result.resolution).toBe("1080p");
    expect(result.videoCodec).toBe("x265");
    expect(result.suggestedCanonicalName).toBe("Breaking Bad - S01E05.mkv");
  });

  it("should identify anime fansub filename with Chinese title", () => {
    const result = identifyMediaFile({
      fileName: "[VCB-Studio] Frieren - 01 [Ma10p_1080p] [x265_flac].mkv",
      parentDirName: "葬送的芙莉莲 (2023)",
      libraryType: "anime",
    });

    expect(result.mediaType).toBe("tv");
    expect(result.title).toBe("葬送的芙莉莲");
    expect(result.year).toBe(2023);
    expect(result.seasonNumber).toBe(1);
    expect(result.episodeNumber).toBe(1);
    expect(result.resolution).toBe("1080p");
    expect(result.videoCodec).toBe("x265");
    expect(result.suggestedCanonicalName).toBe("葬送的芙莉莲 - S01E01.mkv");
  });

  it("should identify Chinese drama episode pattern", () => {
    const result = identifyMediaFile({
      fileName: "狂飙 第08集.4K.mp4",
      parentDirName: "狂飙 (2023)",
      libraryType: "tv",
    });

    expect(result.mediaType).toBe("tv");
    expect(result.title).toBe("狂飙");
    expect(result.year).toBe(2023);
    expect(result.seasonNumber).toBe(1);
    expect(result.episodeNumber).toBe(8);
    expect(result.resolution).toBe("4k");
    expect(result.suggestedCanonicalName).toBe("狂飙 - S01E08.mp4");
  });

  it("should identify movies with resolution", () => {
    const result = identifyMediaFile({
      fileName: "Oppenheimer.2023.2160p.UHD.BluRay.x265.mkv",
      parentDirName: "奥本海默 (2023)",
      libraryType: "movie",
    });

    expect(result.mediaType).toBe("movie");
    expect(result.title).toBe("奥本海默");
    expect(result.year).toBe(2023);
    expect(result.seasonNumber).toBe(1);
    expect(result.episodeNumber).toBeNull();
    expect(result.resolution).toBe("2160p");
    expect(result.suggestedCanonicalName).toBe("奥本海默 (2023).mkv");
  });
});

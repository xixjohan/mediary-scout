import { describe, expect, it } from "vitest";
import {
  TitleParseChain,
  parseTitleWithChain,
  CanonicalTmdbTagStrategy,
  StandardTitleYearFolderStrategy,
  ReleaseGroupFilenameStrategy,
  AnimeFansubPatternStrategy,
} from "../../src/domain/title-parse-chain.js";

describe("TitleParseChain & Parsing Strategies", () => {
  it("CanonicalTmdbTagStrategy parses folder with {tmdb-N} with 100% confidence", () => {
    const res = parseTitleWithChain({
      folderName: "奥本海默 (2023) {tmdb-872585}",
    });
    expect(res).not.toBeNull();
    expect(res?.tmdbId).toBe(872585);
    expect(res?.year).toBe(2023);
    expect(res?.title).toBe("奥本海默");
    expect(res?.confidence).toBe(100);
    expect(res?.strategyUsed).toBe("CanonicalTmdbTagStrategy");
  });

  it("CanonicalTmdbTagStrategy handles title without year but with tmdb id", () => {
    const res = parseTitleWithChain({
      folderName: "Breaking Bad {tmdb-1396}",
    });
    expect(res?.tmdbId).toBe(1396);
    expect(res?.title).toBe("Breaking Bad");
    expect(res?.year).toBeUndefined();
    expect(res?.confidence).toBe(100);
  });

  it("StandardTitleYearFolderStrategy parses paren format 'Title (Year)'", () => {
    const res = parseTitleWithChain({
      folderName: "肖申克的救赎 (1994)",
    });
    expect(res).not.toBeNull();
    expect(res?.title).toBe("肖申克的救赎");
    expect(res?.year).toBe(1994);
    expect(res?.confidence).toBe(90);
    expect(res?.strategyUsed).toBe("StandardTitleYearFolderStrategy");
  });

  it("StandardTitleYearFolderStrategy parses dot format 'Inception.2010'", () => {
    const res = parseTitleWithChain({
      folderName: "Inception.2010",
    });
    expect(res).not.toBeNull();
    expect(res?.title).toBe("Inception");
    expect(res?.year).toBe(2010);
    expect(res?.confidence).toBe(85);
  });

  it("ReleaseGroupFilenameStrategy cleans complex release names and extracts season", () => {
    const res = parseTitleWithChain({
      folderName: "Breaking.Bad.S01.2160p.WEB-DL.H265.AAC-HDCTV",
    });
    expect(res).not.toBeNull();
    expect(res?.title).toBe("Breaking Bad");
    expect(res?.seasonNumber).toBe(1);
    expect(res?.confidence).toBe(75);
    expect(res?.strategyUsed).toBe("ReleaseGroupFilenameStrategy");
  });

  it("ReleaseGroupFilenameStrategy cleans movie release name with year", () => {
    const res = parseTitleWithChain({
      folderName: "Dune.Part.Two.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC-FraMeSToR",
    });
    expect(res).not.toBeNull();
    expect(res?.title).toBe("Dune Part Two");
    expect(res?.year).toBe(2024);
    expect(res?.confidence).toBe(85);
  });

  it("AnimeFansubPatternStrategy cleans anime fansub bracket names", () => {
    const res = parseTitleWithChain({
      folderName: "[ANi] 葬送的芙莉莲 - 01 [1080P][Bilibili][WEB-DL][AAC AVC][CHT CHS].mp4",
    });
    expect(res).not.toBeNull();
    expect(res?.title).toBe("葬送的芙莉莲");
    expect(res?.confidence).toBe(70);
    expect(res?.strategyUsed).toBe("AnimeFansubPatternStrategy");
  });

  it("Chain prioritizes CanonicalTmdbTagStrategy over Standard and ReleaseGroup", () => {
    const res = parseTitleWithChain({
      folderName: "Three.Body.2023.2160p {tmdb-202345}",
    });
    expect(res?.strategyUsed).toBe("CanonicalTmdbTagStrategy");
    expect(res?.tmdbId).toBe(202345);
  });

  it("returns null for unparseable short garbage string", () => {
    const res = parseTitleWithChain({
      folderName: "a",
    });
    expect(res).toBeNull();
  });
});

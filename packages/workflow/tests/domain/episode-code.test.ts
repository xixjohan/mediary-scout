import { describe, expect, it } from "vitest";
import {
  canonicalEpisodeFileName,
  cleanMediaTitle,
  episodeCodeFromFileName,
  extractReleaseTags,
} from "../../src/index.js";

describe("episodeCodeFromFileName", () => {
  it("parses standard SxxExx names", () => {
    expect(episodeCodeFromFileName("Show.S02E12.2160p.mkv")).toBe("S02E12");
    expect(episodeCodeFromFileName("show s01e05.mkv")).toBe("S01E05");
  });

  it("parses 4-digit episode numbers for 1000+ episode anime (One Piece etc.)", () => {
    expect(episodeCodeFromFileName("One.Piece.S01E1050.mkv")).toBe("S01E1050");
    expect(episodeCodeFromFileName("海贼王 第1050集.mp4")).toBe("S01E1050");
  });

  it("parses anime dash format with release group and quality tags", () => {
    expect(
      episodeCodeFromFileName(
        "[ReleaseGroup] TOUGEN ANKI - 02 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv",
      ),
    ).toBe("S01E02");
    expect(
      episodeCodeFromFileName(
        "[ReleaseGroup] TOUGEN ANKI - 16 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv",
      ),
    ).toBe("S01E16");
    expect(episodeCodeFromFileName("[NC-Raws] Lycoris Recoil - 01.mkv")).toBe("S01E01");
  });

  it("parses anime bracketed episode numbers and version tags", () => {
    expect(
      episodeCodeFromFileName("[ReleaseGroup][Sousou no Frieren][05][1080P][BDRip].mkv"),
    ).toBe("S01E05");
    expect(episodeCodeFromFileName("[SubGroup] Title - 03v2.mkv")).toBe("S01E03");
    expect(episodeCodeFromFileName("[Group][Title][12v3].mp4")).toBe("S01E12");
  });

  it("parses standalone EP format", () => {
    expect(episodeCodeFromFileName("DanDaDan EP04 1080p.mkv")).toBe("S01E04");
    expect(episodeCodeFromFileName("Anime E07.mp4")).toBe("S01E07");
  });

  it("respects fallbackSeason for anime without explicit season token", () => {
    expect(
      episodeCodeFromFileName("[ReleaseGroup] TOUGEN ANKI - 02 [1080p].mkv", 2),
    ).toBe("S02E02");
  });

  it("does not mistake resolutions or years for episode numbers", () => {
    expect(episodeCodeFromFileName("Show.S01E05.2160p.mkv")).toBe("S01E05");
    expect(episodeCodeFromFileName("Movie.2023.2160p.mkv")).toBeNull();
    expect(episodeCodeFromFileName("Avatar (2009) [1080p].mkv")).toBeNull();
    expect(episodeCodeFromFileName("Concert 720p.mkv")).toBeNull();
  });
});

describe("cleanMediaTitle", () => {
  it("strips year and {tmdb-xxx} suffixes cleanly", () => {
    expect(cleanMediaTitle("桃源暗鬼 (2025) {tmdb-253811}")).toBe("桃源暗鬼");
    expect(cleanMediaTitle("Breaking Bad (2008)")).toBe("Breaking Bad");
    expect(cleanMediaTitle("Frieren")).toBe("Frieren");
  });
});

describe("extractReleaseTags", () => {
  it("extracts non-episode brackets while skipping numeric episode tags", () => {
    const tags = extractReleaseTags(
      "[ReleaseGroup] TOUGEN ANKI - 02 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv",
    );
    expect(tags).toEqual(["[ReleaseGroup]", "[WebRip 1080p HEVC-10bit AAC SRTx2]"]);

    const animeTags = extractReleaseTags(
      "[ReleaseGroup][Sousou no Frieren][05][1080P][BDRip].mkv",
    );
    expect(animeTags).toEqual(["[ReleaseGroup]", "[Sousou no Frieren]", "[1080P]", "[BDRip]"]);
  });
});

describe("canonicalEpisodeFileName", () => {
  it("generates clean standard naming when preserveMetadata is false", () => {
    const name = canonicalEpisodeFileName({
      title: "桃源暗鬼 (2025) {tmdb-253811}",
      episodeCode: "S01E02",
      sourceName: "[ReleaseGroup] TOUGEN ANKI - 02 [WebRip 1080p].mkv",
      preserveMetadata: false,
    });
    expect(name).toBe("桃源暗鬼 - S01E02.mkv");
  });

  it("generates metadata-preserved standard naming when preserveMetadata is true", () => {
    const name = canonicalEpisodeFileName({
      title: "桃源暗鬼 (2025) {tmdb-253811}",
      episodeCode: "S01E02",
      sourceName: "[ReleaseGroup] TOUGEN ANKI - 02 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv",
      preserveMetadata: true,
    });
    expect(name).toBe(
      "桃源暗鬼 - S01E02 [ReleaseGroup] [WebRip 1080p HEVC-10bit AAC SRTx2].mkv",
    );
  });
});

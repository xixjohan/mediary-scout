import { describe, expect, it } from "vitest";
import {
  canonicalMovieFileName,
  isCanonicalMovieFileName,
  sanitizeFileSegment,
} from "../../src/domain/movie-file-name.js";

describe("canonicalMovieFileName", () => {
  it("生成 Title (Year).ext", () => {
    expect(
      canonicalMovieFileName({
        title: "新汉普夏饭店",
        year: 1984,
        sourceName: "The.Hotel.New.Hampshire.1984.1080p.BluRay.x265-RARBG.mp4",
      }),
    ).toBe("新汉普夏饭店 (1984).mp4");
  });

  it("年份缺失时不留空括号", () => {
    expect(
      canonicalMovieFileName({ title: "某部电影", year: null, sourceName: "movie.mkv" }),
    ).toBe("某部电影.mkv");
    expect(
      canonicalMovieFileName({ title: "某部电影", year: "0", sourceName: "movie.mkv" }),
    ).toBe("某部电影.mkv");
  });

  it("保留发布标签时追加方括号元信息", () => {
    expect(
      canonicalMovieFileName({
        title: "电影",
        year: 2020,
        sourceName: "[SubGroup] 电影.2020.[1080p][BluRay].mkv",
        preserveMetadata: true,
      }),
    ).toBe("电影 (2020) [SubGroup] [1080p] [BluRay].mkv");
  });

  it("清理标题里的 tmdb 后缀与年份，避免重复", () => {
    expect(
      canonicalMovieFileName({
        title: "凡人修仙传 (2020) {tmdb-106449}",
        year: 2020,
        sourceName: "a.mkv",
      }),
    ).toBe("凡人修仙传 (2020).mkv");
  });

  it("扩展名保留原样，无扩展名时不强加", () => {
    expect(canonicalMovieFileName({ title: "T", year: 2000, sourceName: "noext" })).toBe("T (2000)");
  });

  it("非法字符被替换，避免跨网盘兼容问题", () => {
    expect(sanitizeFileSegment('a/b:c*d?e"f<g>h|i')).toBe("a b c d e f g h i");
    expect(
      canonicalMovieFileName({ title: "A/B:C", year: 2000, sourceName: "x.mp4" }),
    ).toBe("A B C (2000).mp4");
  });
});

describe("isCanonicalMovieFileName", () => {
  it("已规范的名字不再触发重命名", () => {
    expect(isCanonicalMovieFileName("电影 (2020).mkv", "电影", 2020)).toBe(true);
    expect(isCanonicalMovieFileName("Movie.2020.1080p.mkv", "电影", 2020)).toBe(false);
  });
});

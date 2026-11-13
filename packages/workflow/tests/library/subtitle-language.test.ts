import { describe, expect, it } from "vitest";
import { detectSubtitleLanguage, subtitleLanguageLabel } from "../../src/library/subtitle-language.js";

describe("detectSubtitleLanguage", () => {
  it("识别简体中文的常见标记", () => {
    for (const name of [
      "Movie.2024.zh-CN.srt",
      "Movie.chs.ass",
      "Movie.zh-Hans.srt",
      "电影.简体.ass",
      "Movie.中字.srt",
      "Movie.中英双语.ass",
    ]) {
      expect(detectSubtitleLanguage(name)).toBe("zh-Hans");
    }
  });

  it("繁体优先于简体（混合命名里繁体是更强信号）", () => {
    expect(detectSubtitleLanguage("Movie.繁中.chs.ass")).toBe("zh-Hant");
    expect(detectSubtitleLanguage("Movie.cht.srt")).toBe("zh-Hant");
    expect(detectSubtitleLanguage("Movie.zh-TW.srt")).toBe("zh-Hant");
    expect(detectSubtitleLanguage("Movie.BIG5.srt")).toBe("zh-Hant");
  });

  it("识别英文、日文、韩文", () => {
    expect(detectSubtitleLanguage("Movie.eng.srt")).toBe("en");
    expect(detectSubtitleLanguage("Movie.en-US.srt")).toBe("en");
    expect(detectSubtitleLanguage("Movie.日语.ass")).toBe("ja");
    expect(detectSubtitleLanguage("Movie.jpn.srt")).toBe("ja");
    expect(detectSubtitleLanguage("Movie.韩语.srt")).toBe("ko");
    expect(detectSubtitleLanguage("Movie.kor.srt")).toBe("ko");
  });

  it("无法识别时返回 und，不猜错", () => {
    expect(detectSubtitleLanguage("Movie.2024.1080p.srt")).toBe("und");
    expect(detectSubtitleLanguage("")).toBe("und");
    // 注意：`sc` 只有在独立词元时才算简体，避免误命中 score/screen 等单词
    expect(detectSubtitleLanguage("Movie.score.srt")).toBe("und");
  });

  it("标签可读，未知标签原样返回", () => {
    expect(subtitleLanguageLabel("zh-Hans")).toBe("简体中文");
    expect(subtitleLanguageLabel("zh-Hant")).toBe("繁体中文");
    expect(subtitleLanguageLabel("und")).toBe("未识别语言");
    expect(subtitleLanguageLabel("fr")).toBe("fr");
    expect(subtitleLanguageLabel("")).toBe("未识别语言");
  });
});

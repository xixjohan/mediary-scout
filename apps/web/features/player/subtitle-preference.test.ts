import { describe, expect, it } from "vitest";
import type { SubtitleTrackInfo } from "@media-track/contracts";
import { buildPlayerSubtitleTracks } from "./subtitle-tracks";
import {
  DEFAULT_SUBTITLE_PREFERENCE,
  parseSubtitlePreference,
  resolvePreferredTrack,
} from "./subtitle-preference";

function sub(id: string, language: string, url: string): SubtitleTrackInfo {
  return {
    id,
    language,
    title: `${id}.srt`,
    format: "srt",
    type: "external",
    url,
  };
}

const TRACKS = buildPlayerSubtitleTracks([
  sub("en", "en", "/en"),
  sub("cht", "zh-Hant", "/cht"),
  sub("chs", "zh-Hans", "/chs"),
]);

describe("parseSubtitlePreference", () => {
  it("空值与非法 JSON 一律退回默认（不抛错）", () => {
    expect(parseSubtitlePreference(null)).toEqual(DEFAULT_SUBTITLE_PREFERENCE);
    expect(parseSubtitlePreference(undefined)).toEqual(DEFAULT_SUBTITLE_PREFERENCE);
    expect(parseSubtitlePreference("")).toEqual(DEFAULT_SUBTITLE_PREFERENCE);
    expect(parseSubtitlePreference("{bad json")).toEqual(DEFAULT_SUBTITLE_PREFERENCE);
    expect(parseSubtitlePreference("123")).toEqual(DEFAULT_SUBTITLE_PREFERENCE);
  });

  it("解析合法偏好", () => {
    expect(parseSubtitlePreference('{"mode":"off","language":null}')).toEqual({
      mode: "off",
      language: null,
    });
    expect(parseSubtitlePreference('{"mode":"auto","language":"zh-Hans"}')).toEqual({
      mode: "auto",
      language: "zh-Hans",
    });
  });

  it("未知 mode 回落 auto，未知语言回落 null", () => {
    expect(parseSubtitlePreference('{"mode":"weird","language":"fr"}')).toEqual({
      mode: "auto",
      language: null,
    });
  });
});

describe("resolvePreferredTrack", () => {
  it("off 表示用户主动关闭字幕", () => {
    expect(resolvePreferredTrack(TRACKS, { mode: "off", language: null })).toBeNull();
  });

  it("按记忆的语言精确命中", () => {
    expect(resolvePreferredTrack(TRACKS, { mode: "auto", language: "en" })?.id).toBe("en");
    expect(resolvePreferredTrack(TRACKS, { mode: "auto", language: "zh-Hant" })?.id).toBe("cht");
  });

  it("语言为 zh 时回落到任意中文轨", () => {
    expect(resolvePreferredTrack(TRACKS, { mode: "auto", language: "zh" })?.id).toBe("chs");
  });

  it("未指定语言时走自动优先级（简→繁→英）", () => {
    expect(resolvePreferredTrack(TRACKS, DEFAULT_SUBTITLE_PREFERENCE)?.id).toBe("chs");
  });

  it("无字幕轨时返回 null", () => {
    expect(resolvePreferredTrack([], DEFAULT_SUBTITLE_PREFERENCE)).toBeNull();
  });
});

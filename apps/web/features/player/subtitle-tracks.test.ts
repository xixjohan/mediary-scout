import { describe, expect, it } from "vitest";
import type { SubtitleTrackInfo } from "@media-track/contracts";
import { buildPlayerSubtitleTracks, pickDefaultTrack, toArtSubtitleType } from "./subtitle-tracks";

function sub(overrides: Partial<SubtitleTrackInfo>): SubtitleTrackInfo {
  return {
    id: "s1",
    language: "und",
    title: "Movie.zh-CN.ass",
    format: "ass",
    type: "external",
    url: "/api/strm/play/x/y?delivery=proxy",
    ...overrides,
  };
}

describe("toArtSubtitleType", () => {
  it("文本格式原样透传，不再把 srt 错标成 vtt", () => {
    expect(toArtSubtitleType("srt")).toBe("srt");
    expect(toArtSubtitleType("ASS")).toBe("ass");
    expect(toArtSubtitleType(" vtt ")).toBe("vtt");
  });

  it("位图字幕与未知格式返回 null（不可渲染）", () => {
    expect(toArtSubtitleType("pgs")).toBeNull();
    expect(toArtSubtitleType("sub")).toBeNull();
    expect(toArtSubtitleType("")).toBeNull();
  });
});

describe("buildPlayerSubtitleTracks", () => {
  it("过滤无 URL 与不可渲染格式", () => {
    const tracks = buildPlayerSubtitleTracks([
      sub({ id: "a", format: "srt", url: "/u1" }),
      sub({ id: "b", format: "pgs", url: "/u2" }),
      sub({ id: "c", format: "ass", url: "" }),
      sub({ id: "d", format: "ass", url: "/u3" }),
    ]);
    expect(tracks.map((t) => t.id)).toEqual(["a", "d"]);
  });

  it("按 URL 去重，避免同一字幕重复入列表", () => {
    const tracks = buildPlayerSubtitleTracks([
      sub({ id: "a", url: "/same" }),
      sub({ id: "b", url: "/same" }),
    ]);
    expect(tracks).toHaveLength(1);
  });

  it("标签包含语言名与去扩展名的文件名", () => {
    const [track] = buildPlayerSubtitleTracks([
      sub({ language: "zh-Hans", title: "Movie.2024.zh-CN.srt", format: "srt", url: "/u" }),
    ]);
    expect(track?.label).toContain("简体中文");
    expect(track?.label).toContain("Movie.2024.zh-CN");
    expect(track?.label).not.toContain(".srt");
  });

  it("空输入返回空数组", () => {
    expect(buildPlayerSubtitleTracks(undefined)).toEqual([]);
    expect(buildPlayerSubtitleTracks([])).toEqual([]);
  });
});

describe("pickDefaultTrack", () => {
  it("优先简体中文，其次繁体、英文", () => {
    const tracks = buildPlayerSubtitleTracks([
      sub({ id: "en", language: "en", url: "/en" }),
      sub({ id: "cht", language: "zh-Hant", url: "/cht" }),
      sub({ id: "chs", language: "zh-Hans", url: "/chs" }),
    ]);
    expect(pickDefaultTrack(tracks)?.id).toBe("chs");
  });

  it("无中文时退回英文，再退回第一条", () => {
    const withEn = buildPlayerSubtitleTracks([
      sub({ id: "ja", language: "ja", url: "/ja" }),
      sub({ id: "en", language: "en", url: "/en" }),
    ]);
    expect(pickDefaultTrack(withEn)?.id).toBe("en");

    const unknown = buildPlayerSubtitleTracks([
      sub({ id: "x", language: "und", url: "/x" }),
      sub({ id: "y", language: "und", url: "/y" }),
    ]);
    expect(pickDefaultTrack(unknown)?.id).toBe("x");
  });

  it("空列表返回 null", () => {
    expect(pickDefaultTrack([])).toBeNull();
  });
});

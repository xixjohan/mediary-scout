import { describe, expect, it } from "vitest";
import {
  isExtensionlessVideoName,
  planExtensionFixes,
  videoExtensionFromName,
} from "../../src/execution/extensionless-video.js";

const BIG = 1200 * 1024 * 1024;
const TRUNCATED = "凡人修仙传：重返天南[第175集].1080p.WEB-DL.H264.AAC-ColorTV";

describe("videoExtensionFromName", () => {
  it("从种子/分享名里取视频后缀", () => {
    expect(videoExtensionFromName("Show.S01E01.1080p.WEB-DL.mkv")).toBe("mkv");
    expect(videoExtensionFromName("电影.2024.MP4")).toBe("mp4");
    expect(videoExtensionFromName("Show.S01E01.ts")).toBe("ts");
  });

  it("发布组后缀（带连字符）不会被当成扩展名", () => {
    expect(videoExtensionFromName(TRUNCATED)).toBeNull();
    expect(videoExtensionFromName("...H264.AAC-ColorTV")).toBeNull();
  });

  it("非视频后缀 / 空值返回 null", () => {
    expect(videoExtensionFromName("Show.S01E01.nfo")).toBeNull();
    expect(videoExtensionFromName("Show")).toBeNull();
    expect(videoExtensionFromName(undefined)).toBeNull();
    expect(videoExtensionFromName("   ")).toBeNull();
  });
});

describe("isExtensionlessVideoName", () => {
  it("无扩展名 + 正片体积 → 命中", () => {
    expect(isExtensionlessVideoName(TRUNCATED, BIG)).toBe(true);
  });

  it("已有视频扩展名 → 不命中", () => {
    expect(isExtensionlessVideoName("Show.S01E01.mkv", BIG)).toBe(false);
  });

  it("体积不足（字幕/封面）→ 不命中", () => {
    expect(isExtensionlessVideoName(TRUNCATED, 2 * 1024 * 1024)).toBe(false);
    expect(isExtensionlessVideoName(TRUNCATED, undefined)).toBe(false);
  });

  it("垃圾扩展名 → 不命中", () => {
    expect(isExtensionlessVideoName("Show.S01E01.nfo", BIG)).toBe(false);
  });
});

describe("planExtensionFixes", () => {
  it("资源名带后缀时，为截断文件规划补名", () => {
    const fixes = planExtensionFixes({
      files: [
        { id: "f1", name: TRUNCATED, sizeBytes: BIG },
        { id: "f2", name: "Show.S01E02.mkv", sizeBytes: BIG },
      ],
      sourceNames: ["凡人修仙传 合集.mkv"],
    });
    expect(fixes).toEqual([
      { fileId: "f1", from: TRUNCATED, to: `${TRUNCATED}.mkv`, extension: "mkv" },
    ]);
  });

  it("拿不到扩展名时不动手（绝不默认 mp4）", () => {
    const fixes = planExtensionFixes({
      files: [{ id: "f1", name: TRUNCATED, sizeBytes: BIG }],
      sourceNames: ["凡人修仙传 合集", null],
    });
    expect(fixes).toEqual([]);
  });

  it("多个资源名时取第一个可用后缀", () => {
    const fixes = planExtensionFixes({
      files: [{ id: "f1", name: TRUNCATED, sizeBytes: BIG }],
      sourceNames: ["合集", "合集.mp4"],
    });
    expect(fixes[0]?.extension).toBe("mp4");
  });

  it("体积不足的候选不会被改名", () => {
    const fixes = planExtensionFixes({
      files: [{ id: "f1", name: "字幕", sizeBytes: 1024 }],
      sourceNames: ["x.mkv"],
    });
    expect(fixes).toEqual([]);
  });
});

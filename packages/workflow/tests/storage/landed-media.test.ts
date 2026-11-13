import { describe, expect, it, vi } from "vitest";
import { collectLandedVideos, normalizeLandedExtensions } from "../../src/storage/landed-media.js";

const BIG = 1200 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set(["mkv", "mp4", "ts"]);

describe("collectLandedVideos", () => {
  it("纳入无扩展名大文件（转存截断），同时保留按扩展名识别的视频", async () => {
    const files = await collectLandedVideos({
      listItems: async () => [
        { fid: "f1", n: "Show.S01E01.mkv", s: String(BIG) },
        { fid: "f2", n: "Show.S01E02.1080p.WEB-DL.H264.AAC-ColorTV", s: String(BIG) },
        { fid: "f3", n: "Show.S01E01.nfo", s: "1024" },
        { fid: "f4", n: "cover", s: "2048" },
      ],
      videoExtensions: VIDEO_EXTENSIONS,
      rootDirectoryId: "dir_1",
    });
    expect(files.map((file) => file.id)).toEqual(["f1", "f2"]);
    // 截断文件也要能解析出集号，后续整理才认得出
    expect(files[1]?.episodeCode).toBe("S01E02");
  });

  it("递归进入子目录（staging 包常见一层包裹目录）", async () => {
    const listing: Record<string, Array<{ fid: string; n: string; s: string }>> = {
      dir_1: [],
      dir_1_wrapper: [{ fid: "inner", n: "EP01.1080p.H264-ColorTV", s: String(BIG) }],
    };
    const files = await collectLandedVideos({
      listItems: async (directoryId) =>
        directoryId === "dir_1"
          ? [{ cid: "dir_1_wrapper", n: "包", fc: "0" }]
          : (listing[directoryId] ?? []),
      videoExtensions: VIDEO_EXTENSIONS,
      rootDirectoryId: "dir_1",
    });
    expect(files.map((file) => file.id)).toEqual(["inner"]);
  });

  it("体积小的无扩展名文件不算落地视频", async () => {
    const files = await collectLandedVideos({
      listItems: async () => [{ fid: "f1", n: "readme", s: "4096" }],
      videoExtensions: VIDEO_EXTENSIONS,
      rootDirectoryId: "dir_1",
    });
    expect(files).toEqual([]);
  });
});

describe("normalizeLandedExtensions", () => {
  it("按资源名补扩展名并统计成功数", async () => {
    const rename = vi.fn(async () => ({ ok: true, message: "" }));
    const renamed = await normalizeLandedExtensions({
      landed: [
        {
          id: "f1",
          storageDirectoryId: "dir_1",
          name: "Show.S01E01.1080p.H264.AAC-ColorTV",
          sizeBytes: BIG,
          episodeCode: "S01E01",
          providerFileId: "f1",
        },
      ],
      sourceTitle: "Show.S01E01.1080p.H264.mkv",
      rename,
    });
    expect(renamed).toBe(1);
    expect(rename).toHaveBeenCalledWith("f1", "Show.S01E01.1080p.H264.AAC-ColorTV.mkv");
  });

  it("上游拒绝时只告警，不抛错", async () => {
    const warn = vi.fn();
    const renamed = await normalizeLandedExtensions({
      landed: [
        {
          id: "f1",
          storageDirectoryId: "dir_1",
          name: "Show.S01E01.H264-ColorTV",
          sizeBytes: BIG,
          episodeCode: "S01E01",
          providerFileId: "f1",
        },
      ],
      sourceTitle: "x.mkv",
      rename: async () => ({ ok: false, message: "扩展名固定" }),
      warn,
    });
    expect(renamed).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("补扩展名被上游拒绝"));
  });

  it("资源名没有视频后缀时完全不发改名请求", async () => {
    const rename = vi.fn(async () => ({ ok: true, message: "" }));
    const renamed = await normalizeLandedExtensions({
      landed: [
        {
          id: "f1",
          storageDirectoryId: "dir_1",
          name: "Show.S01E01.H264-ColorTV",
          sizeBytes: BIG,
          episodeCode: "S01E01",
          providerFileId: "f1",
        },
      ],
      sourceTitle: "凡人修仙传 合集",
      rename,
    });
    expect(renamed).toBe(0);
    expect(rename).not.toHaveBeenCalled();
  });
});

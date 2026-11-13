import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MIN_UNRECOGNIZED_BYTES,
  buildRenamedFileName,
  collectUnrecognizedFromTree,
  extensionForContainer,
  looksLikeVideoWithoutExtension,
  scanUnrecognizedMedia,
  sniffVideoContainer,
} from "../../src/execution/unrecognized-media.js";

const BIG = DEFAULT_MIN_UNRECOGNIZED_BYTES + 1;

function bytes(...values: Array<number | string>): Uint8Array {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === "number") out.push(value);
    else for (const char of value) out.push(char.charCodeAt(0));
  }
  return new Uint8Array(out);
}

describe("looksLikeVideoWithoutExtension", () => {
  it("已有视频扩展名的一律排除", () => {
    expect(looksLikeVideoWithoutExtension("a.mkv", BIG)).toBe(false);
    expect(looksLikeVideoWithoutExtension("a.MP4", BIG)).toBe(false);
  });

  it("垃圾扩展名排除（nfo/txt 等）", () => {
    expect(looksLikeVideoWithoutExtension("a.nfo", BIG)).toBe(false);
    expect(looksLikeVideoWithoutExtension("a.txt", BIG)).toBe(false);
  });

  it("体积不足正片量级时排除（字幕、封面）", () => {
    expect(looksLikeVideoWithoutExtension("subtitle", 2 * 1024 * 1024)).toBe(false);
    expect(looksLikeVideoWithoutExtension("cover", undefined)).toBe(false);
  });

  it("无扩展名且达到正片体积 → 命中", () => {
    expect(
      looksLikeVideoWithoutExtension("【高清剧集网】凡人修仙传[第175集].1080p.WEB-DL.H264.AAC-ColorTV", BIG),
    ).toBe(true);
  });

  it("空白文件名不命中", () => {
    expect(looksLikeVideoWithoutExtension("   ", BIG)).toBe(false);
  });
});

describe("sniffVideoContainer", () => {
  it("MP4（ftyp）", () => {
    expect(sniffVideoContainer(bytes(0, 0, 0, 0x18, "ftypisom"))).toBe("mp4");
  });

  it("Matroska / WebM（EBML）", () => {
    expect(sniffVideoContainer(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x42))).toBe("mkv");
  });

  it("AVI（RIFF+AVI ）", () => {
    expect(sniffVideoContainer(bytes("RIFF", 0, 0, 0, 0, "AVI "))).toBe("avi");
  });

  it("FLV", () => {
    expect(sniffVideoContainer(bytes("FLV", 0x01, 0x05))).toBe("flv");
  });

  it("MPEG-TS（首尾同步字节 0x47）", () => {
    const head = new Uint8Array(189).fill(0);
    head[0] = 0x47;
    head[188] = 0x47;
    expect(sniffVideoContainer(head)).toBe("ts");
  });

  it("无法判定时返回 unknown（不猜）", () => {
    expect(sniffVideoContainer(bytes("hello world"))).toBe("unknown");
    expect(sniffVideoContainer(new Uint8Array(0))).toBe("unknown");
  });
});

describe("extensionForContainer", () => {
  it("已知容器映射扩展名，unknown 返回 null", () => {
    expect(extensionForContainer("mp4")).toBe("mp4");
    expect(extensionForContainer("mkv")).toBe("mkv");
    expect(extensionForContainer("unknown")).toBeNull();
  });
});

describe("buildRenamedFileName", () => {
  it("缺扩展名时追加", () => {
    expect(buildRenamedFileName("凡人修仙传[第175集].ColorTV", "mkv")).toBe("凡人修仙传[第175集].ColorTV.mkv");
  });

  it("已带同扩展名不重复追加", () => {
    expect(buildRenamedFileName("a.mkv", "mkv")).toBe("a.mkv");
    expect(buildRenamedFileName("a.MKV", "mkv")).toBe("a.MKV");
  });
});

describe("collectUnrecognizedFromTree", () => {
  it("只看直属文件，嵌套路径不算（父目录无法改名）", () => {
    const items = collectUnrecognizedFromTree(
      [
        { providerFileId: "f1", path: "第175集.ColorTV", sizeBytes: BIG },
        { providerFileId: "f2", path: "sub/第176集.ColorTV", sizeBytes: BIG },
        { providerFileId: "f3", path: "第177集.mkv", sizeBytes: BIG },
      ],
      { id: "season_01", name: "Season 01" },
    );
    expect(items.map((item) => item.fileId)).toEqual(["f1"]);
    expect(items[0]?.directoryName).toBe("Season 01");
  });
});

describe("scanUnrecognizedMedia", () => {
  it("覆盖剧集根目录、Season 目录与 staging 目录", async () => {
    const storage = {
      listChildDirectories: vi.fn(async () => [
        { id: "season_01", name: "Season 01" },
        { id: "stg", name: "staging-abc" },
        { id: "extras", name: "Extras" },
      ]),
      listTree: vi.fn(async ({ directoryId }: { directoryId: string }) => {
        if (directoryId === "show") return [{ providerFileId: "r1", path: "根目录正片.ColorWEB", sizeBytes: BIG }];
        if (directoryId === "season_01") return [{ providerFileId: "s1", path: "第175集.ColorTV", sizeBytes: BIG }];
        if (directoryId === "stg") return [{ providerFileId: "t1", path: "第188集.ColorWEB", sizeBytes: BIG }];
        return [{ providerFileId: "x1", path: "花絮.ColorTV", sizeBytes: BIG }];
      }),
    };

    const items = await scanUnrecognizedMedia({ storage, showDirectoryId: "show" });

    expect(items.map((item) => item.fileId).sort()).toEqual(["r1", "s1", "t1"]);
    // Extras 目录不在扫描范围内
    expect(items.some((item) => item.directoryId === "extras")).toBe(false);
  });

  it("单个目录列举失败不影响其它目录", async () => {
    const storage = {
      listChildDirectories: vi.fn(async () => [
        { id: "season_01", name: "Season 01" },
        { id: "season_02", name: "Season 02" },
      ]),
      listTree: vi.fn(async ({ directoryId }: { directoryId: string }) => {
        if (directoryId === "season_01") throw new Error("upstream 500");
        if (directoryId === "season_02") return [{ providerFileId: "s2", path: "第10集", sizeBytes: BIG }];
        return [];
      }),
    };

    const items = await scanUnrecognizedMedia({ storage, showDirectoryId: "show" });
    expect(items.map((item) => item.fileId)).toEqual(["s2"]);
  });
});

import { describe, it, expect } from "vitest";
import { sniffMediaKind } from "../../src/domain/media-kind-sniffer.js";

describe("Media Classification Sniffer (媒体类型智能嗅探矩阵)", () => {
  it("无季号动漫顶级文件夹通过内容嗅探判定为 TV: 孤独摇滚 (内含 EP01~EP12)", () => {
    const kind = sniffMediaKind({
      folderName: "孤独摇滚",
      relativePath: "Anime/孤独摇滚",
      items: [
        { name: "孤独摇滚 - EP01.mp4", isFolder: false, type: "video" },
        { name: "孤独摇滚 - EP02.mp4", isFolder: false, type: "video" },
      ],
    });
    expect(kind).toBe("tv");
  });

  it("无季号电视剧顶级文件夹通过子目录季结构判定为 TV: 繁花 (内含 Season 1)", () => {
    const kind = sniffMediaKind({
      folderName: "繁花",
      relativePath: "TV/繁花",
      items: [{ name: "Season 1", isFolder: true }],
    });
    expect(kind).toBe("tv");
  });

  it("中文集数命名识别为 TV: 庆余年 (内含 第01集.mp4, 第02集.mp4)", () => {
    const kind = sniffMediaKind({
      folderName: "庆余年",
      items: [
        { name: "庆余年 - 第01集.mp4", isFolder: false, type: "video" },
        { name: "庆余年 - 第02集.mp4", isFolder: false, type: "video" },
      ],
    });
    expect(kind).toBe("tv");
  });

  it("字幕组动漫中括号编号识别为 TV: 鬼灭之刃 (内含 [01].mkv, [02].mkv)", () => {
    const kind = sniffMediaKind({
      folderName: "鬼灭之刃 柱训练篇",
      items: [
        { name: "[Lilith-Raws] Kimetsu no Yaiba - [01] [Baha] [1080p].mkv", isFolder: false, type: "video" },
        { name: "[Lilith-Raws] Kimetsu no Yaiba - [02] [Baha] [1080p].mkv", isFolder: false, type: "video" },
      ],
    });
    expect(kind).toBe("tv");
  });

  it("纯单文件电影正片正确归入 Movie: 沙丘2 (内含单个 4K 压制正片)", () => {
    const kind = sniffMediaKind({
      folderName: "沙丘2.Dune.Part.Two.2024.2160p",
      relativePath: "Movies/沙丘2",
      items: [
        { name: "Dune.Part.Two.2024.2160p.mkv", isFolder: false, type: "video" },
        { name: "Dune.Part.Two.2024.2160p.nfo", isFolder: false, type: "file" },
      ],
    });
    expect(kind).toBe("movie");
  });

  it("存储分区 CID 判定: 处于 tvCid 或 animeCid 分区下的条目继承为 TV", () => {
    const tvKind = sniffMediaKind({
      folderName: "神秘条目A",
      parentCid: "tv_cid_123",
      storageCids: { tvCid: "tv_cid_123", moviesCid: "movies_cid_456" },
    });
    expect(tvKind).toBe("tv");

    const movieKind = sniffMediaKind({
      folderName: "神秘条目B",
      parentCid: "movies_cid_456",
      storageCids: { tvCid: "tv_cid_123", moviesCid: "movies_cid_456" },
    });
    expect(movieKind).toBe("movie");
  });

  it("路径关键词判定: 处于 TV 或 Anime 路径下的条目继承为 TV", () => {
    expect(sniffMediaKind({ folderName: "Title", relativePath: "TV/Title" })).toBe("tv");
    expect(sniffMediaKind({ folderName: "Title", relativePath: "Anime/Title" })).toBe("tv");
    expect(sniffMediaKind({ folderName: "Title", relativePath: "电视剧/Title" })).toBe("tv");
    expect(sniffMediaKind({ folderName: "Title", relativePath: "动漫/Title" })).toBe("tv");
    expect(sniffMediaKind({ folderName: "Title", relativePath: "Movies/Title" })).toBe("movie");
  });

  it("TMDB 检索结果判定: 单文件与 TMDB 结果协同", () => {
    const kindMovie = sniffMediaKind({
      folderName: "Oppenheimer",
      items: [{ name: "Oppenheimer.2023.mkv", isFolder: false, type: "video" }],
      tmdbMediaType: "movie",
    });
    expect(kindMovie).toBe("movie");

    const kindTv = sniffMediaKind({
      folderName: "Chernobyl",
      tmdbMediaType: "tv",
    });
    expect(kindTv).toBe("tv");
  });

  it("显式用户偏好强覆盖判定: 无论目录结构为何均遵循用户偏好", () => {
    const forceMovie = sniffMediaKind({
      folderName: "孤独摇滚",
      preferredCategory: "movie",
      items: [
        { name: "EP01.mp4", isFolder: false, type: "video" },
        { name: "EP02.mp4", isFolder: false, type: "video" },
      ],
    });
    expect(forceMovie).toBe("movie");

    const forceTv = sniffMediaKind({
      folderName: "沙丘2",
      preferredCategory: "tv",
      items: [{ name: "Dune.Part.Two.mkv", isFolder: false, type: "video" }],
    });
    expect(forceTv).toBe("tv");
  });
});

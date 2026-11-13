import { describe, expect, it } from "vitest";
import { buildOrganizeContext, findStagingParentCrumb } from "./use-folder-organize";

describe("buildOrganizeContext", () => {
  it("普通影视目录不带季号", () => {
    expect(
      buildOrganizeContext({
        storageId: "cs_1",
        directoryId: "dir_1",
        directoryName: "凡人修仙传 (2020) {tmdb-106449}",
        tmdbId: 106449,
      }),
    ).toEqual({
      storageId: "cs_1",
      directoryId: "dir_1",
      directoryName: "凡人修仙传 (2020) {tmdb-106449}",
      tmdbId: 106449,
    });
  });

  it("Season NN 目录解析出季号", () => {
    const ctx = buildOrganizeContext({
      storageId: "cs_1",
      directoryId: "dir_s1",
      directoryName: "Season 02",
      tmdbId: 106449,
    });
    expect(ctx.seasonNumber).toBe(2);
  });

  it("中文「第 N 季」同样解析", () => {
    const ctx = buildOrganizeContext({
      storageId: "cs_1",
      directoryId: "dir_s3",
      directoryName: "第 3 季",
      tmdbId: 106449,
    });
    expect(ctx.seasonNumber).toBe(3);
  });

  it("带上父目录名（adopt 身份校验用）", () => {
    const ctx = buildOrganizeContext({
      storageId: "cs_1",
      directoryId: "dir_1",
      directoryName: "Some Movie (2020)",
      tmdbId: 1,
      parentFolderName: "电影",
    });
    expect(ctx.parentFolderName).toBe("电影");
  });
});

describe("findStagingParentCrumb", () => {
  const crumbs = [
    { id: "root", name: "根目录" },
    { id: "anime", name: "Anime" },
    { id: "staging", name: "staging-42218692" },
  ];

  it("staging 目录回退到上一级", () => {
    expect(findStagingParentCrumb("staging-42218692", crumbs)).toEqual({
      id: "anime",
      name: "Anime",
    });
  });

  it("非 staging 目录不回退", () => {
    expect(findStagingParentCrumb("Season 01", crumbs)).toBeNull();
    expect(findStagingParentCrumb(undefined, crumbs)).toBeNull();
  });

  it("面包屑不足两级时不回退（避免越界）", () => {
    expect(findStagingParentCrumb("staging-x", [{ id: "root", name: "根目录" }])).toBeNull();
  });
});

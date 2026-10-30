import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../../src/acquisition-v2/fake-provider.js";
import type { SimTreeFile, StorageV2 } from "../../src/acquisition-v2/storage-115-simulator.js";

/**
 * 任务单 S3.1 集成：inspectStaging 返回的每个文件都带确定性解析字段（parsed），
 * agent 的证据里直接有集号/画质/字幕组——不必再靠 LLM 读文件名猜。
 */
function storageWith(files: SimTreeFile[]): StorageV2 {
  return {
    async createDirectory() {
      return "created";
    },
    async transferCandidate() {
      throw new Error("no transfer");
    },
    candidateLinkKind() {
      return "unknown";
    },
    async listTree() {
      return files;
    },
    async listSubdirectories() {
      return [];
    },
    async moveFiles(input: { fileIds: string[] }) {
      return { moved: input.fileIds };
    },
    async renameFile() {},
    async deleteFiles() {
      return { deleted: [] };
    },
    async removeDirectory() {
      return { removed: [] };
    },
    async transferSubtitleUrls() {
      return [];
    },
  };
}

function sandboxFor(files: SimTreeFile[]): TaskSandbox {
  return new TaskSandbox({
    provider: new FakeResourceProviderV2({ results: {} }),
    storage: storageWith(files),
    stagingDirectoryId: "stg",
    targetSeasonDirectoryIds: { 1: "season" },
    need: ["S01E08"],
  });
}

const file = (path: string, over: Partial<SimTreeFile> = {}): SimTreeFile => ({
  id: path,
  path,
  sizeBytes: 100,
  isVideo: true,
  isSubtitle: false,
  ...over,
});

describe("inspectStaging 附带确定性解析（S3.1）", () => {
  it("动漫括号名 / 欧美发行名 / 中文第N集 都带出集号与画质", async () => {
    const sandbox = sandboxFor([
      file("[Nekomoe kisscircle][Grantaire 1st Season][05][CHS][1080P].mp4"),
      file("The.Mandalorian.S02E05.2160p.WEB-DL.mkv"),
      file("凡人修仙传 第07集 1080P.mp4"),
    ]);
    const seen = await sandbox.inspectStaging();
    expect(seen.map((f) => f.parsed?.episodeCode)).toEqual(["S01E05", "S02E05", "S01E07"]);
    expect(seen[0]?.parsed?.releaseGroup?.toLowerCase()).toContain("nekomoe");
    expect(seen[1]?.parsed?.resolution).toBe("2160p");
    expect(seen[2]?.parsed?.resolution).toBe("1080p");
  });

  it("尝鲜版 / End 完 终章：agent 不再需要猜的那种名", async () => {
    const sandbox = sandboxFor([file("尝鲜版09.mkv"), file("庆余年 第36集 完.mp4")]);
    const seen = await sandbox.inspectStaging();
    expect(seen[0]?.parsed?.episodeCode).toBe("S01E09");
    expect(seen[1]?.parsed?.episode).toBe(36);
    expect(seen[1]?.parsed?.isFinale).toBe(true);
  });

  it("垃圾名不抛异常，parsed 存在但字段为 null", async () => {
    const sandbox = sandboxFor([file("?????.mkv"), file("random")]);
    const seen = await sandbox.inspectStaging();
    expect(seen).toHaveLength(2);
    expect(seen.every((f) => f.parsed !== undefined)).toBe(true);
    expect(seen.every((f) => f.parsed?.episodeCode === null)).toBe(true);
  });

  it("外挂字幕文件也带解析（与视频同放，判定不依赖它但不缺失）", async () => {
    const sandbox = sandboxFor([file("Show.S01E03.chs.srt", { isVideo: false, isSubtitle: true })]);
    const seen = await sandbox.inspectStaging();
    expect(seen[0]?.parsed?.episodeCode).toBe("S01E03");
  });
});

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  DEFAULT_MAX_SUBTITLE_UPLOAD_BYTES,
  Storage115Executor,
  type Pan115DirectoryInfo,
  type Pan115Item,
  type Pan115StorageApi,
} from "../../src/index.js";

/**
 * 字幕上传路径的契约。
 *
 * 核心断言是**降级方向**：上传路径的任何失败（无能力／超限／网络不通／需对象
 * 存储）都必须返回明确的降级信号，让调用方回退到现有离线任务路径。字幕是软
 * 目标——它的落地方式变化绝不能影响视频覆盖，也绝不能让一次上传失败变成抛错。
 */

function seasonPathInfo(rootId: string, seasonId: string): Pan115DirectoryInfo {
  return {
    state: true,
    path: [
      { cid: "0", name: "root" },
      { cid: rootId, name: "Media Track Test Root" },
      { cid: "show_1", name: "Show" },
      { cid: seasonId, name: "Season 1" },
    ],
  };
}

const SUBTITLE_BYTES = Buffer.from("[Script Info]\nTitle: Test Subtitle\n");

interface FakeApi extends Pan115StorageApi {
  directories: Record<string, Pan115Item[]>;
  directoryInfo: Record<string, Pan115DirectoryInfo>;
  initUploadCalls: Array<{ fileName: string; fileSize: number; directoryId: string; fileSha1: string }>;
}

function fakeApi(options: {
  initStatus?: number;
  fileId?: string;
  supportsUpload?: boolean;
} = {}): FakeApi {
  const api: FakeApi = {
    directories: {} as Record<string, Pan115Item[]>,
    directoryInfo: { season_1: seasonPathInfo("test_root", "season_1") } as Record<string, Pan115DirectoryInfo>,
    initUploadCalls: [],
    async listItems(input: { directoryId: string }) {
      return this.directories[input.directoryId] ?? [];
    },
    async getDirectoryInfo(input: { directoryId: string }) {
      return this.directoryInfo[input.directoryId] ?? null;
    },
    async createFolder(input: { name: string; parentId: string }) {
      return `${input.parentId}_${input.name}`;
    },
    async receiveShare() {
      return { ok: true, message: "" };
    },
    async addOfflineTask() {
      return { ok: true, message: "" };
    },
    async removeOfflineTask() {
      return { ok: true, message: "" };
    },
    async listOfflineTasks() {
      return [];
    },
    async moveItems() {
      return { ok: true, message: "" };
    },
    async deleteItems() {
      return { ok: true, message: "" };
    },
    async renameFile() {
      return { ok: true, message: "" };
    },
  };
  if (options.supportsUpload !== false) {
    api.initUpload = async (input) => {
      api.initUploadCalls.push({
        fileName: input.fileName,
        fileSize: input.fileSize,
        directoryId: input.directoryId,
        fileSha1: input.fileSha1,
      });
      return { status: options.initStatus ?? 2, ...(options.fileId ? { fileId: options.fileId } : {}) };
    };
  }
  return api;
}

function executor(api: Pan115StorageApi, fetchImpl?: typeof fetch): Storage115Executor {
  return new Storage115Executor({
    api,
    apiGuardOptions: { minDelayMs: 0 },
    protectedDirectoryIds: [],
    writeScopeDirectoryIds: ["test_root"],
    moviesDirectoryId: "movies",
    subtitleMaterializeAttempts: 1,
    subtitleMaterializePollMs: 0,
    sleep: async () => {},
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

const okFetch = (async () =>
  new Response(SUBTITLE_BYTES, { status: 200 })) as unknown as typeof fetch;

describe("uploadSubtitle — 秒传路径", () => {
  it("status=2 秒传成功，返回 landed 与 fileId", async () => {
    const api = fakeApi({ initStatus: 2, fileId: "file_42" });
    const result = await executor(api, okFetch).uploadSubtitle({
      url: "https://example.com/Show.S01E01.ass",
      filename: "Show.S01E01.ass",
      directoryId: "season_1",
    });
    expect(result).toEqual({ outcome: "landed", fileId: "file_42" });
    expect(api.initUploadCalls).toHaveLength(1);
    expect(api.initUploadCalls[0]!.fileSha1).toBe(createHash("sha1").update(SUBTITLE_BYTES).digest("hex"));
    expect(api.initUploadCalls[0]!.fileSize).toBe(SUBTITLE_BYTES.length);
    expect(api.initUploadCalls[0]!.directoryId).toBe("season_1");
  });

  it("秒传成功但无 fileId 时不塞键", async () => {
    const api = fakeApi({ initStatus: 2 });
    const result = await executor(api, okFetch).uploadSubtitle({
      url: "https://example.com/a.ass",
      filename: "a.ass",
      directoryId: "season_1",
    });
    expect(result).toEqual({ outcome: "landed" });
  });

  it("status=1 需对象存储 → 明确降级信号", async () => {
    const api = fakeApi({ initStatus: 1 });
    const result = await executor(api, okFetch).uploadSubtitle({
      url: "https://example.com/a.ass",
      filename: "a.ass",
      directoryId: "season_1",
    });
    expect(result).toEqual({ outcome: "needs_object_storage" });
  });
});

describe("uploadSubtitle — 降级路径", () => {
  it("驱动未实现上传能力 → unavailable", async () => {
    const api = fakeApi({ supportsUpload: false });
    const result = await executor(api, okFetch).uploadSubtitle({
      url: "https://example.com/a.ass",
      filename: "a.ass",
      directoryId: "season_1",
    });
    expect(result.outcome).toBe("unavailable");
  });

  it("assrt 直链下载失败（本机出网受限）→ unavailable 且带原因", async () => {
    const failing = (async () => {
      throw new Error("connect ETIMEDOUT 1.2.3.4:443");
    }) as unknown as typeof fetch;
    const api = fakeApi();
    const result = await executor(api, failing).uploadSubtitle({
      url: "https://example.com/a.ass",
      filename: "a.ass",
      directoryId: "season_1",
    });
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") {
      expect(result.reason).toContain("字幕下载失败");
    }
    expect(api.initUploadCalls).toHaveLength(0); // 没下载到内容就不该调上传
  });

  it("HTTP 非 200 → unavailable", async () => {
    const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const result = await executor(fakeApi(), notFound).uploadSubtitle({
      url: "https://example.com/missing.ass",
      filename: "missing.ass",
      directoryId: "season_1",
    });
    expect(result.outcome).toBe("unavailable");
  });

  it("空内容 → unavailable", async () => {
    const empty = (async () => new Response(Buffer.alloc(0), { status: 200 })) as unknown as typeof fetch;
    const result = await executor(fakeApi(), empty).uploadSubtitle({
      url: "https://example.com/empty.ass",
      filename: "empty.ass",
      directoryId: "season_1",
    });
    expect(result.outcome).toBe("unavailable");
  });

  it("超过大小上限 → unavailable，不把大文件拖进本地上传", async () => {
    const big = Buffer.alloc(DEFAULT_MAX_SUBTITLE_UPLOAD_BYTES + 1, 0x41);
    const bigFetch = (async () => new Response(big, { status: 200 })) as unknown as typeof fetch;
    const api = fakeApi();
    const result = await executor(api, bigFetch).uploadSubtitle({
      url: "https://example.com/huge.ass",
      filename: "huge.ass",
      directoryId: "season_1",
    });
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") {
      expect(result.reason).toContain("上传上限");
    }
    expect(api.initUploadCalls).toHaveLength(0);
  });

  it("initUpload 抛错（平台上传服务不可用）→ unavailable，绝不向上抛", async () => {
    const api = fakeApi();
    api.initUpload = async () => {
      throw new Error("open platform unavailable");
    };
    const result = await executor(api, okFetch).uploadSubtitle({
      url: "https://example.com/a.ass",
      filename: "a.ass",
      directoryId: "season_1",
    });
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") {
      expect(result.reason).toContain("上传初始化失败");
    }
  });

  it("大小上限可配置", async () => {
    const api = fakeApi();
    const bytes = Buffer.alloc(1024, 0x42);
    const fetchImpl = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;
    const ex = new Storage115Executor({
      api,
      apiGuardOptions: { minDelayMs: 0 },
      writeScopeDirectoryIds: ["test_root"],
      maxSubtitleUploadBytes: 512,
      fetchImpl,
    });
    const result = await ex.uploadSubtitle({
      url: "https://example.com/a.ass",
      filename: "a.ass",
      directoryId: "season_1",
    });
    expect(result.outcome).toBe("unavailable");
  });
});

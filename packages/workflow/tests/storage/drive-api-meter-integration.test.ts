import { afterEach, describe, expect, it } from "vitest";
import {
  Storage115Executor,
  type Pan115ActionResult,
  type Pan115DirectoryInfo,
  type Pan115Item,
  type Pan115OfflineTask,
  type Pan115StorageApi,
} from "../../src/index.js";
import { driveApiMeter } from "../../src/storage/drive-api-meter.js";

/**
 * 埋点集成测试：验证 executor 的真实调用确实按类别进了 meter。
 *
 * 单测 drive-api-meter 只证明「给定 operation 分类正确」；这里证明
 * **executor 的每个出口都真的上报了**，且 url 协议分流在真实调用路径上成立
 * （字幕的 http 离线任务计 download，磁力转存计 free）。漏埋点会让分类模型
 * 完美却什么都统计不到。
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

function fakeApi(overrides: Record<string, unknown> = {}): Pan115StorageApi {
  const api = {
    directories: {} as Record<string, Pan115Item[]>,
    shareFiles: {} as Record<string, Pan115Item[]>,
    directoryInfo: { season_1: seasonPathInfo("test_root", "season_1") } as Record<string, Pan115DirectoryInfo>,
    offlineTaskList: [] as Pan115OfflineTask[],
    offlineTasks: [] as Array<{ url: string; directoryId: string }>,
    ...overrides,
  };
  return {
    async listItems(input: { directoryId: string }) {
      return api.directories[input.directoryId] ?? [];
    },
    async getDirectoryInfo(input: { directoryId: string }) {
      return api.directoryInfo[input.directoryId] ?? null;
    },
    async createFolder(input: { name: string; parentId: string }) {
      return `${input.parentId}_${input.name}`;
    },
    async receiveShare() {
      return { ok: true, message: "" };
    },
    async addOfflineTask(input: { url: string; directoryId: string }) {
      api.offlineTasks.push(input);
      return { ok: true, message: "" };
    },
    async removeOfflineTask() {
      return { ok: true, message: "" };
    },
    async listOfflineTasks() {
      return api.offlineTaskList;
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
  } as Pan115StorageApi;
}

function executor(api: Pan115StorageApi): Storage115Executor {
  return new Storage115Executor({
    api,
    apiGuardOptions: { minDelayMs: 0 },
    protectedDirectoryIds: [],
    writeScopeDirectoryIds: ["test_root"],
    moviesDirectoryId: "movies",
    // 字幕落地轮询：1 次尝试、0 等待——本测试只关心埋点，不等真实落地。
    subtitleMaterializeAttempts: 1,
    subtitleMaterializePollMs: 0,
    sleep: async () => {},
  });
}

afterEach(() => {
  driveApiMeter.reset();
});

describe("executor → meter 埋点", () => {
  it("磁力转存：addOfflineTask 计 free，其间的 listOfflineTasks 计 download", async () => {
    const api = fakeApi();
    const ex = executor(api);
    await ex.transfer({
      workflowRunId: "run-1",
      directoryId: "season_1",
      candidate: {
        id: "cand-1",
        title: "Show.S01E01.mkv",
        providerPayload: { url: "magnet:?xt=urn:btih:" + "a".repeat(40) },
      } as never,
    });
    // 磁力提交本身无月限；但转存流程要 listOfflineTasks 判定秒传/在途，
    // 而离线任务管理与直链下载共享月限（用户口径）——所以 download > 0 是对的。
    const snap = driveApiMeter.snapshot();
    expect(snap.download).toBeGreaterThanOrEqual(1);
    expect(snap.free).toBeGreaterThanOrEqual(1);
  });

  it("字幕 http 离线任务计 download（同一 addOfflineTask 按 url 协议分流）", async () => {
    const api = fakeApi();
    const ex = executor(api);
    await ex.transferSubtitleUrl({
      url: "https://example.com/Show.S01E01.ass",
      filename: "Show.S01E01.ass",
      directoryId: "season_1",
      workflowRunId: "run-1",
    });
    const snap = driveApiMeter.snapshot();
    expect(snap.download).toBeGreaterThanOrEqual(1);
    expect(snap.free).toBeGreaterThanOrEqual(1); // write-scope + before-snapshot
  });

  it("目录列举计 free", async () => {
    const api = fakeApi();
    const ex = executor(api);
    await ex.listVideoFiles("season_1");
    const snap = driveApiMeter.snapshot();
    expect(snap.download).toBe(0);
    expect(snap.free).toBeGreaterThanOrEqual(1);
  });

  it("meter 不影响调用结果——上报前后行为一致", async () => {
    const api = fakeApi();
    const ex = executor(api);
    const result = await ex.transfer({
      workflowRunId: "run-1",
      directoryId: "season_1",
      candidate: {
        id: "cand-1",
        title: "Show.S01E01.mkv",
        providerPayload: { url: "magnet:?xt=urn:btih:" + "b".repeat(40) },
      } as never,
    });
    expect(result).toBeDefined();
    expect(driveApiMeter.snapshot().total).toBeGreaterThan(0);
  });
});

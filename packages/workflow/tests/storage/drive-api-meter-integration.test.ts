import { describe, expect, it } from "vitest";
import {
  Storage115Executor,
  type Pan115ActionResult,
  type Pan115DirectoryInfo,
  type Pan115Item,
  type Pan115OfflineTask,
  type Pan115StorageApi,
} from "../../src/index.js";

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
    expect(ex.downloadApiCallCount()).toBeGreaterThanOrEqual(1);
    expect(ex.apiCallCount()).toBeGreaterThan(ex.downloadApiCallCount()); // 其余为 free
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
    expect(ex.downloadApiCallCount()).toBeGreaterThanOrEqual(1);
    // write-scope 校验与 before 快照都是 free，故总调用数大于下载类
    expect(ex.apiCallCount()).toBeGreaterThan(ex.downloadApiCallCount());
  });

  it("目录列举计 free", async () => {
    const api = fakeApi();
    const ex = executor(api);
    await ex.listVideoFiles("season_1");
    expect(ex.downloadApiCallCount()).toBe(0);
    expect(ex.apiCallCount()).toBeGreaterThanOrEqual(1);
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
    expect(ex.apiCallCount()).toBeGreaterThan(0);
  });

  it("计数按任务隔离：第二个 executor 不继承第一个的下载类次数", async () => {
    const runA = executor(fakeApi());
    await runA.transferSubtitleUrl({
      url: "https://example.com/Show.S01E01.ass",
      filename: "Show.S01E01.ass",
      directoryId: "season_1",
      workflowRunId: "run-a",
    });
    expect(runA.downloadApiCallCount()).toBeGreaterThanOrEqual(1);

    // 每次采集运行经 factory 新建 executor —— 新任务必须从 0 起算。
    const runB = executor(fakeApi());
    await runB.listVideoFiles("season_1");
    expect(runB.downloadApiCallCount()).toBe(0);
    expect(runB.apiCallCount()).toBeGreaterThanOrEqual(1);
  });
});

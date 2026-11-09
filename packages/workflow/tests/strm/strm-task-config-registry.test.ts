import { describe, expect, it, vi } from "vitest";
import { StrmTaskConfigRegistry } from "../../src/strm/strm-task-config-registry.js";
import type { StrmTask } from "../../src/strm/strm-types.js";

describe("StrmTaskConfigRegistry 内存字典注册中心与适配器策略", () => {
  it("单例内存字典 O(1) 命中并缓存，TTL 内不重复查库", async () => {
    const mockTask: StrmTask = {
      id: "strm_task_movie",
      accountId: "acc_1",
      name: "电影同步",
      storageId: "cs_quark",
      remoteFolderId: "root",
      remotePath: "/Movies",
      localOutputDir: "/tmp/movies",
      deliveryMode: "redirect",
      scanMode: "incremental_missing",
      scheduleMode: "interval",
      scanIntervalMinutes: 120,
      extensions: "mkv;mp4",
      minFileSizeMb: 100,
      excludeKeywords: "",
      isActive: true,
      status: "idle",
      lastScanAt: null,
      lastScanStatus: null,
      lastErrorMessage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const getTaskSpy = vi.fn().mockResolvedValue(mockTask);
    const getStorageSpy = vi.fn().mockResolvedValue({ provider: "quark", status: "active" });

    const registry = new StrmTaskConfigRegistry({
      getTaskById: getTaskSpy,
      getStorageById: getStorageSpy,
    });

    // 1. 初次调用冷态加载
    const cfg1 = await registry.resolveConfig("strm_task_movie");
    expect(cfg1.taskId).toBe("strm_task_movie");
    expect(cfg1.deliveryMode).toBe("redirect");
    expect(cfg1.provider).toBe("quark");
    expect(getTaskSpy).toHaveBeenCalledTimes(1);

    // 2. 第二次调用直接命中内存字典 (0 次查库)
    const cfg2 = await registry.resolveConfig("strm_task_movie");
    expect(cfg2).toBe(cfg1);
    expect(getTaskSpy).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
  });

  it("SingleFlight 并发防击穿：10 个并发仅产生 1 次查库", async () => {
    let callCount = 0;
    const mockTask: StrmTask = {
      id: "strm_task_burst",
      accountId: "acc_1",
      name: "高并发测试",
      storageId: "cs_ali",
      remoteFolderId: "f1",
      remotePath: "/Ali",
      localOutputDir: "/tmp/ali",
      deliveryMode: "proxy",
      scanMode: "incremental_missing",
      scheduleMode: "interval",
      scanIntervalMinutes: 60,
      extensions: "mkv",
      minFileSizeMb: 50,
      excludeKeywords: "",
      isActive: true,
      status: "idle",
      lastScanAt: null,
      lastScanStatus: null,
      lastErrorMessage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const registry = new StrmTaskConfigRegistry({
      getTaskById: async () => {
        callCount++;
        // 模拟 10ms 数据库 I/O 延迟
        await new Promise((resolve) => setTimeout(resolve, 10));
        return mockTask;
      },
      getStorageById: async () => ({ provider: "aliyun", status: "active" }),
    });

    // 并发 10 个 Range 请求打入
    const results = await Promise.all(
      Array.from({ length: 10 }, () => registry.resolveConfig("strm_task_burst")),
    );

    expect(results).toHaveLength(10);
    for (const r of results) {
      expect(r.taskId).toBe("strm_task_burst");
      expect(r.deliveryMode).toBe("proxy");
    }
    // 验证 SingleFlight 合并：实际查库只有 1 次！
    expect(callCount).toBe(1);
  });

  it("主动失效 invalidate 触发毫秒级缓存淘汰", async () => {
    let version = 1;
    const registry = new StrmTaskConfigRegistry({
      getTaskById: async (id) => ({
        id,
        accountId: "acc_1",
        name: `任务版本 v${version}`,
        storageId: "cs_test",
        remoteFolderId: "f1",
        remotePath: "/",
        localOutputDir: "/tmp",
        deliveryMode: version === 1 ? "redirect" : "proxy",
        scanMode: "incremental_missing",
        scheduleMode: "interval",
        scanIntervalMinutes: 60,
        extensions: "mkv",
        minFileSizeMb: 10,
        excludeKeywords: "",
        isActive: true,
        status: "idle",
        lastScanAt: null,
        lastScanStatus: null,
        lastErrorMessage: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      getStorageById: async () => ({ provider: "quark", status: "active" }),
    });

    const c1 = await registry.resolveConfig("task_mutation");
    expect(c1.deliveryMode).toBe("redirect");

    // 用户在 Web 端修改任务配置为 proxy
    version = 2;
    registry.invalidate("task_mutation");
    expect(registry.size).toBe(0);

    // 下一次播放请求立即加载新配置
    const c2 = await registry.resolveConfig("task_mutation");
    expect(c2.deliveryMode).toBe("proxy");
  });

  it("115 驱动物理特性协商：即使任务配置为 redirect 也自适应协商为 proxy", async () => {
    const registry = new StrmTaskConfigRegistry({
      getTaskById: async (id) => ({
        id,
        accountId: "acc_1",
        name: "115误设302任务",
        storageId: "cs_115_danger",
        remoteFolderId: "root",
        remotePath: "/Anime",
        localOutputDir: "/tmp/anime",
        deliveryMode: "redirect", // 用户误设为 302 重定向
        scanMode: "incremental_missing",
        scheduleMode: "interval",
        scanIntervalMinutes: 120,
        extensions: "mkv",
        minFileSizeMb: 100,
        excludeKeywords: "",
        isActive: true,
        status: "idle",
        lastScanAt: null,
        lastScanStatus: null,
        lastErrorMessage: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      getStorageById: async () => ({ provider: "pan115", status: "active" }), // 底层是 115
    });

    const cfg = await registry.resolveConfig("task_115");
    // 必须自动协商升级为 proxy，防止 403 崩溃
    expect(cfg.deliveryMode).toBe("proxy");
    expect(cfg.provider).toBe("pan115");
  });

  it("多态适配器模式：支持以 cs_ 开头的存储驱动直连点播，自动生成虚拟配置并协商为 proxy", async () => {
    const getTaskSpy = vi.fn().mockResolvedValue(null);
    const getStorageSpy = vi.fn().mockResolvedValue({
      provider: "quark",
      status: "active",
      accountId: "acct_quark_live",
    });

    const registry = new StrmTaskConfigRegistry({
      getTaskById: getTaskSpy,
      getStorageById: getStorageSpy,
    });

    const cfg = await registry.resolveConfig("cs_quark_AAQ69oQ5Vj9Myt5R0uGt7omX");
    expect(cfg.taskId).toBe("cs_quark_AAQ69oQ5Vj9Myt5R0uGt7omX");
    expect(cfg.storageId).toBe("cs_quark_AAQ69oQ5Vj9Myt5R0uGt7omX");
    expect(cfg.provider).toBe("quark");
    expect(cfg.deliveryMode).toBe("proxy");
    expect(cfg.accountId).toBe("acct_quark_live");
    expect(cfg.isActive).toBe(true);

    // 存储前缀直通：无需执行无谓的 getTaskById 查询
    expect(getTaskSpy).not.toHaveBeenCalled();
    expect(getStorageSpy).toHaveBeenCalledTimes(1);

    // 第二次命中内存字典缓存
    const cfgCached = await registry.resolveConfig("cs_quark_AAQ69oQ5Vj9Myt5R0uGt7omX");
    expect(cfgCached).toBe(cfg);
    expect(getStorageSpy).toHaveBeenCalledTimes(1);
  });

  it("多态存储驱动被冻结时，生成的虚拟配置 isActive 为 false", async () => {
    const registry = new StrmTaskConfigRegistry({
      getTaskById: async () => null,
      getStorageById: async () => ({
        provider: "pan115",
        status: "frozen",
      }),
    });

    const cfg = await registry.resolveConfig("cs_pan115_frozen");
    expect(cfg.isActive).toBe(false);
  });

  it("任务与存储驱动均不存在时，明确抛出 NOT_FOUND 语义异常", async () => {
    const registry = new StrmTaskConfigRegistry({
      getTaskById: async () => null,
      getStorageById: async () => null,
    });

    await expect(registry.resolveConfig("non_existent_id")).rejects.toThrow(
      "STRM_TASK_OR_STORAGE_NOT_FOUND",
    );
  });
});

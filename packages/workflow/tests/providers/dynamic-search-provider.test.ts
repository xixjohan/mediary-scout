import { describe, expect, it, vi } from "vitest";
import { DynamicSearchProviderAdapter } from "../../src/extensions/dynamic-search-provider.js";
import { ForkSandboxRunner } from "../../src/extensions/fork-sandbox-runner.js";
import type { ExtensionEntity } from "../../src/extensions/extension-types.js";

describe("DynamicSearchProviderAdapter (动态资源提供商适配器)", () => {
  const dummyExtension: ExtensionEntity = {
    manifest: {
      id: "ext_test_search",
      name: "测试网盘搜索扩展",
      version: "1.0.0",
      entry: "index.js",
      type: "search-provider",
      author: "tester",
      description: "用于单元测试的动态扩展",
      enabled: true,
    },
    rootDir: "/tmp/ext_test_search",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  it("正确将各种盘搜类型映射为规范的 ResourceType", async () => {
    const rawCandidates = [
      { title: "Res 115", type: "115" },
      { title: "Res pan115", type: "pan115" },
      { title: "Res quark", type: "quark" },
      { title: "Res uc", type: "uc" },
      { title: "Res tianyi", type: "tianyi" },
      { title: "Res 123", type: "123" },
      { title: "Res guangya", type: "guangya" },
      { title: "Res magnet", type: "magnet" },
      { title: "Res thunder", type: "thunder" },
      { title: "Res ed2k", type: "ed2k" },
      { title: "Res other", type: "unknown_cloud" },
    ];

    vi.spyOn(ForkSandboxRunner, "executeMethod").mockResolvedValueOnce({
      success: true,
      data: { candidates: rawCandidates },
      durationMs: 42,
    });

    const adapter = new DynamicSearchProviderAdapter(dummyExtension);
    const snapshot = await adapter.search({ keyword: "流浪地球", workflowRunId: "run_manual_1" });

    expect(snapshot.provider).toBe("dynamic:ext_test_search");
    expect(snapshot.keyword).toBe("流浪地球");
    expect(snapshot.candidates.length).toBe(11);

    expect(snapshot.candidates[0]!.type).toBe("115");
    expect(snapshot.candidates[1]!.type).toBe("115");
    expect(snapshot.candidates[2]!.type).toBe("quark");
    expect(snapshot.candidates[3]!.type).toBe("uc");
    expect(snapshot.candidates[4]!.type).toBe("tianyi");
    expect(snapshot.candidates[5]!.type).toBe("123");
    expect(snapshot.candidates[6]!.type).toBe("guangya");
    expect(snapshot.candidates[7]!.type).toBe("magnet");
    expect(snapshot.candidates[8]!.type).toBe("magnet");
    expect(snapshot.candidates[9]!.type).toBe("magnet");
    expect(snapshot.candidates[10]!.type).toBe("manual"); // 未知类型回退为 manual
  });

  it("当沙箱执行失败时抛出包含扩展名称和具体原因的格式化错误", async () => {
    vi.spyOn(ForkSandboxRunner, "executeMethod").mockResolvedValueOnce({
      success: false,
      error: "SyntaxError: Unexpected token in extension script",
      durationMs: 10,
    });

    const adapter = new DynamicSearchProviderAdapter(dummyExtension);
    await expect(adapter.search({ keyword: "三体" })).rejects.toThrow(
      "动态资源提供商 [测试网盘搜索扩展] 执行失败: SyntaxError: Unexpected token in extension script"
    );
  });

  it("自动为未提供 workflowRunId 的查询生成唯一 snapshotId 与候选 candidateId", async () => {
    vi.spyOn(ForkSandboxRunner, "executeMethod").mockResolvedValueOnce({
      success: true,
      data: {
        candidates: [
          {
            title: "星际穿越 4K Remux",
            type: "pan115",
            source: "阿里云/115聚合",
            payload: { url: "https://115.com/s/xxx", password: "abcd" },
          },
        ],
      },
      durationMs: 25,
    });

    const adapter = new DynamicSearchProviderAdapter(dummyExtension);
    const snapshot = await adapter.search({ keyword: "星际穿越" });

    expect(snapshot.id).toMatch(/^snap_ext_test_search_\d+$/);
    expect(snapshot.candidates[0]!.id).toBe(`${snapshot.id}_c_0`);
    expect(snapshot.candidates[0]!.index).toBe(0);
    expect(snapshot.candidates[0]!.source).toBe("阿里云/115聚合");
    expect(snapshot.candidates[0]!.providerPayload).toEqual({
      url: "https://115.com/s/xxx",
      password: "abcd",
    });
  });

  it("当沙箱返回空候选列表或 null 时能安全兜底并产生有效空快照", async () => {
    vi.spyOn(ForkSandboxRunner, "executeMethod").mockResolvedValueOnce({
      success: true,
      data: undefined,
      durationMs: 15,
    });

    const adapter = new DynamicSearchProviderAdapter(dummyExtension);
    const snapshot = await adapter.search({ keyword: "冷门影片" });

    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.keyword).toBe("冷门影片");
    expect(snapshot.createdAt).toBeDefined();
  });

  it("构造函数支持传入自定义配置并正确转发给 ForkSandboxRunner", async () => {
    const customConfig = { apiKey: "secret_123", enableVip: true };
    const executeSpy = vi.spyOn(ForkSandboxRunner, "executeMethod").mockResolvedValueOnce({
      success: true,
      data: { candidates: [] },
      durationMs: 5,
    });

    const adapter = new DynamicSearchProviderAdapter(dummyExtension, customConfig);
    await adapter.search({ keyword: "阿凡达" });

    expect(executeSpy).toHaveBeenCalledWith(
      expect.stringContaining("index.js"),
      "search",
      { keyword: "阿凡达", config: customConfig },
      { timeoutMs: 8000 }
    );
  });
});

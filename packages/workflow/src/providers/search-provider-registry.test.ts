import { describe, expect, it, vi } from "vitest";
import type { ResourceCandidate, ResourceSnapshot } from "../domain/domain.js";
import type { ResourceProvider } from "../domain/ports.js";
import { SearchProviderRegistry } from "./search-provider-registry.js";

function makeCandidate(title: string, index = 0): ResourceCandidate {
  return {
    id: `c_${index}`,
    snapshotId: "snap_1",
    index,
    title,
    type: "115",
    source: "mock-source",
    providerPayload: {},
  };
}

class MockProvider implements ResourceProvider {
  public callCount = 0;
  constructor(
    public readonly name: string,
    private readonly handler: (keyword: string) => Promise<ResourceSnapshot>,
  ) {}

  async search(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    this.callCount += 1;
    return this.handler(input.keyword);
  }
}

describe("SearchProviderRegistry — Provider Management", () => {
  it("注册、注销与启用开关", () => {
    const registry = new SearchProviderRegistry();
    const mock = new MockProvider("test1", async (kw) => ({
      id: "s1",
      provider: "test1",
      keyword: kw,
      candidates: [makeCandidate("Sample 1")],
      createdAt: new Date().toISOString(),
    }));

    registry.registerProvider({ id: "p1", name: "test1", provider: mock });
    expect(registry.listProviders()).toHaveLength(1);
    expect(registry.getProvider("p1")?.enabled).toBe(true);

    registry.setProviderEnabled("p1", false);
    expect(registry.getProvider("p1")?.enabled).toBe(false);

    registry.unregisterProvider("p1");
    expect(registry.listProviders()).toHaveLength(0);
  });
});

describe("SearchProviderRegistry — Execution Strategies", () => {
  it("parallel 模式：聚合多个提供商结果并去重", async () => {
    const registry = new SearchProviderRegistry({ strategy: "parallel" });
    const p1 = new MockProvider("source-a", async (kw) => ({
      id: "s_a",
      provider: "source-a",
      keyword: kw,
      candidates: [makeCandidate("Item 1", 0), makeCandidate("Item 2", 1)],
      createdAt: new Date().toISOString(),
    }));
    const p2 = new MockProvider("source-b", async (kw) => ({
      id: "s_b",
      provider: "source-b",
      keyword: kw,
      candidates: [makeCandidate("Item 2", 0), makeCandidate("Item 3", 1)],
      createdAt: new Date().toISOString(),
    }));

    registry.registerProvider({ id: "p1", name: "source-a", provider: p1 });
    registry.registerProvider({ id: "p2", name: "source-b", provider: p2 });

    const snapshot = await registry.search({ keyword: "Breaking Bad" });
    expect(snapshot.candidates).toHaveLength(3); // Item 1, Item 2, Item 3 (Item 2 deduped)
    expect(snapshot.sourceHealth?.status).toBe("healthy");
  });

  it("race 模式：优先返回最快响应且含候选的提供商", async () => {
    const registry = new SearchProviderRegistry({ strategy: "race" });
    const slow = new MockProvider("slow", async (kw) => {
      await new Promise((r) => setTimeout(r, 50));
      return {
        id: "s_slow",
        provider: "slow",
        keyword: kw,
        candidates: [makeCandidate("Slow Item")],
        createdAt: new Date().toISOString(),
      };
    });
    const fast = new MockProvider("fast", async (kw) => ({
      id: "s_fast",
      provider: "fast",
      keyword: kw,
      candidates: [makeCandidate("Fast Item")],
      createdAt: new Date().toISOString(),
    }));

    registry.registerProvider({ id: "slow", name: "slow", provider: slow });
    registry.registerProvider({ id: "fast", name: "fast", provider: fast });

    const snapshot = await registry.search({ keyword: "test" });
    expect(snapshot.candidates[0]?.title).toBe("Fast Item");
  });

  it("waterfall 模式：首选成功且有结果后不再调用后续降级源", async () => {
    const registry = new SearchProviderRegistry({ strategy: "waterfall" });
    const p1 = new MockProvider("primary", async (kw) => ({
      id: "s1",
      provider: "primary",
      keyword: kw,
      candidates: [makeCandidate("Primary Item")],
      createdAt: new Date().toISOString(),
    }));
    const p2 = new MockProvider("secondary", async (kw) => ({
      id: "s2",
      provider: "secondary",
      keyword: kw,
      candidates: [makeCandidate("Secondary Item")],
      createdAt: new Date().toISOString(),
    }));

    registry.registerProvider({ id: "p1", name: "primary", provider: p1 });
    registry.registerProvider({ id: "p2", name: "secondary", provider: p2 });

    const snapshot = await registry.search({ keyword: "test" });
    expect(snapshot.candidates[0]?.title).toBe("Primary Item");
    expect(p1.callCount).toBe(1);
    expect(p2.callCount).toBe(0); // waterfall 成功时次级源不触发
  });
});

describe("SearchProviderRegistry — FSM 状态机熔断器与 SingleFlight", () => {
  it("连续 3 次失败触发 circuit_open，休眠期内直接跳过", async () => {
    const registry = new SearchProviderRegistry({
      strategy: "parallel",
      circuitFailureThreshold: 3,
      circuitCoolDownMs: 1000,
    });

    let fail = true;
    const flakey = new MockProvider("flakey", async (kw) => {
      if (fail) throw new Error("Connection refused 502");
      return {
        id: "s_flakey",
        provider: "flakey",
        keyword: kw,
        candidates: [makeCandidate("Recovered Item")],
        createdAt: new Date().toISOString(),
      };
    });

    registry.registerProvider({ id: "flakey", name: "flakey", provider: flakey });

    // 连续失败 3 次
    await registry.search({ keyword: "q1" });
    await registry.search({ keyword: "q2" });
    await registry.search({ keyword: "q3" });

    const entry = registry.getProvider("flakey");
    expect(entry?.circuit.status).toBe("circuit_open");
    expect(flakey.callCount).toBe(3);

    // 第 4 次检索：处于冷却期，应当直接跳过该源，callCount 不增加
    await registry.search({ keyword: "q4" });
    expect(flakey.callCount).toBe(3);

    // 模拟冷却时间已过，进入 half_open 探活
    if (entry) entry.circuit.coolDownUntil = Date.now() - 10;
    fail = false; // 探活恢复

    const snap = await registry.search({ keyword: "q5" });
    expect(flakey.callCount).toBe(4);
    expect(entry?.circuit.status).toBe("healthy");
    expect(snap.candidates[0]?.title).toBe("Recovered Item");
  });

  it("SingleFlight 保证同一检索关键词并发请求合并", async () => {
    const registry = new SearchProviderRegistry({ strategy: "parallel" });
    const provider = new MockProvider("shared", async (kw) => {
      await new Promise((r) => setTimeout(r, 20));
      return {
        id: "s_shared",
        provider: "shared",
        keyword: kw,
        candidates: [makeCandidate("Shared Result")],
        createdAt: new Date().toISOString(),
      };
    });
    registry.registerProvider({ id: "shared", name: "shared", provider });

    // 并发触发 3 次相同的搜索请求
    const [res1, res2, res3] = await Promise.all([
      registry.search({ keyword: "Interstellar", workflowRunId: "test-run" }),
      registry.search({ keyword: "Interstellar", workflowRunId: "test-run" }),
      registry.search({ keyword: "Interstellar", workflowRunId: "test-run" }),
    ]);

    expect(provider.callCount).toBe(1); // 仅发起了一次实际检索
    expect(res1.candidates).toEqual(res2.candidates);
    expect(res2.candidates).toEqual(res3.candidates);
  });
});

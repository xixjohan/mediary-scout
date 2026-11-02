import { describe, expect, it, vi } from "vitest";
import type { ResourceCandidate } from "../../src/domain/domain.js";
import {
  Pan115ShareInspectorAdapter,
  QuarkShareInspectorAdapter,
  ShareInspectorRegistry,
} from "../../src/inspectors/index.js";

function mockCandidate(type: "quark" | "115" | "magnet", payload: Record<string, unknown>): ResourceCandidate {
  return {
    id: `cand-${Math.random().toString(36).slice(2)}`,
    snapshotId: "snap-test",
    index: 0,
    title: "进击的巨人",
    type,
    source: `test-${type}`,
    providerPayload: payload,
  };
}

describe("QuarkShareInspectorAdapter (适配器模式)", () => {
  it("夸克分享正常时提取文件节点与总字节", async () => {
    const mockFetch = vi.fn()
      // Step 1: token 请求
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ code: 0, data: { stoken: "stoken-123" } }),
      })
      // Step 2: detail 请求
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            list: [
              { fid: "f-1", file_name: "EP01.mkv", size: 1048576, file_type: 1 },
              { fid: "f-2", file_name: "EP02.mkv", size: 2097152, file_type: 1 },
              { fid: "d-1", file_name: "Subs", file_type: 0 },
            ],
            total: 3,
          },
        }),
      });

    const adapter = new QuarkShareInspectorAdapter(mockFetch as unknown as typeof fetch);
    const candidate = mockCandidate("quark", {
      url: "https://pan.quark.cn/s/abcdef123456",
      password: "pass",
    });

    const result = await adapter.inspect(candidate);
    expect(result.status).toBe("valid");
    expect(result.fileCount).toBe(3);
    expect(result.totalSizeBytes).toBe(1048576 + 2097152);
    expect(result.files).toHaveLength(3);
    expect(result.files![0]!.name).toBe("EP01.mkv");
    expect(result.files![2]!.isDir).toBe(true);
  });

  it("夸克链接已被取消时映射为 invalid 状态", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      json: async () => ({ code: 40004, message: "该分享已被取消" }),
    });

    const adapter = new QuarkShareInspectorAdapter(mockFetch as unknown as typeof fetch);
    const candidate = mockCandidate("quark", {
      url: "https://pan.quark.cn/s/deadbeef",
    });

    const result = await adapter.inspect(candidate);
    expect(result.status).toBe("invalid");
  });

  it("夸克需要提取码或提取码错误时映射为 password_required", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      json: async () => ({ code: 40008, message: "提取码错误" }),
    });

    const adapter = new QuarkShareInspectorAdapter(mockFetch as unknown as typeof fetch);
    const candidate = mockCandidate("quark", {
      url: "https://pan.quark.cn/s/needpwd",
      password: "wrong",
    });

    const result = await adapter.inspect(candidate);
    expect(result.status).toBe("password_required");
  });
});

describe("Pan115ShareInspectorAdapter (适配器模式)", () => {
  it("115 分享正常时提取 snap_list 与体积", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        state: true,
        data: {
          count: 2,
          total_size: 5000000,
          snap_list: [
            { fid: "115-1", n: "Movie.mkv", s: 5000000, fc: 1 },
          ],
        },
      }),
    });

    const adapter = new Pan115ShareInspectorAdapter(mockFetch as unknown as typeof fetch);
    const candidate = mockCandidate("115", {
      url: "https://115.com/s/swxy8ab",
      password: "abcd",
    });

    const result = await adapter.inspect(candidate);
    expect(result.status).toBe("valid");
    expect(result.totalSizeBytes).toBe(5000000);
    expect(result.files![0]!.name).toBe("Movie.mkv");
  });
});

describe("ShareInspectorRegistry (单飞 Single-Flight 与 LRU 缓存)", () => {
  it("并发请求相同 candidate 仅触发一次探测", async () => {
    let callCount = 0;
    const fakeAdapter = {
      supportedTypes: ["quark"] as const,
      inspect: async (cand: ResourceCandidate) => {
        callCount += 1;
        await new Promise((r) => setTimeout(r, 20));
        return {
          candidateId: cand.id,
          status: "valid" as const,
          probedAt: new Date().toISOString(),
        };
      },
    };

    const registry = new ShareInspectorRegistry({
      customAdapters: [fakeAdapter],
    });

    const candidate = mockCandidate("quark", { url: "https://pan.quark.cn/s/singleflight" });

    // 并发 3 次请求
    const [r1, r2, r3] = await Promise.all([
      registry.inspect(candidate),
      registry.inspect(candidate),
      registry.inspect(candidate),
    ]);

    expect(callCount).toBe(1);
    expect(r1.status).toBe("valid");
    expect(r2.status).toBe("valid");
    expect(r3.status).toBe("valid");

    // 随后再次请求命中缓存
    const r4 = await registry.inspect(candidate);
    expect(callCount).toBe(1);
    expect(r4.status).toBe("valid");
  });
});

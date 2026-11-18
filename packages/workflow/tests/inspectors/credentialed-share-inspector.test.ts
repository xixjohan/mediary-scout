import { describe, expect, it, vi } from "vitest";
import type { ResourceCandidate } from "../../src/domain/domain.js";
import {
  CredentialedShareInspectorAdapter,
  GenericShareInspectorAdapter,
  classifyShareProbeErrorMessage,
} from "../../src/inspectors/index.js";
import { normalizeSearchBackends, searchBackendsKey, SEARCH_BACKENDS } from "../../src/providers/search-backends.js";

function candidate(type: ResourceCandidate["type"], payload: Record<string, unknown> = {}): ResourceCandidate {
  return {
    id: "c1",
    snapshotId: "s1",
    index: 0,
    title: "t",
    type,
    source: "s",
    providerPayload: { url: "https://115.com/s/abc", ...payload },
  };
}

describe("GenericShareInspectorAdapter —— 不再对未知盘谎报 valid", () => {
  it("磁力：有地址即 valid（存活仍由下载端确认）", async () => {
    const result = await new GenericShareInspectorAdapter().inspect(
      candidate("magnet", { url: "magnet:?xt=urn:btih:abc" }),
    );
    expect(result.status).toBe("valid");
  });

  it("123 / 天翼 / 光鸭：没有登录态探针时如实报 unknown，不冒充 valid", async () => {
    for (const type of ["123", "tianyi", "guangya"] as const) {
      const result = await new GenericShareInspectorAdapter().inspect(candidate(type));
      expect(result.status, `${type} 不得谎报 valid`).toBe("unknown");
      expect(result.message).toContain("登录态");
    }
  });

  it("空 URL 仍是 invalid（这不是猜，是确定性结论）", async () => {
    const result = await new GenericShareInspectorAdapter().inspect(candidate("manual", { url: "" }));
    expect(result.status).toBe("invalid");
  });
});

describe("CredentialedShareInspectorAdapter", () => {
  const files = [
    { name: "Show.S01E01.mkv", sizeBytes: 1024, isDir: false },
    { name: "Season 2", isDir: true },
  ];

  it("列出的文件成为有效结论 + 体积/文件数", async () => {
    const adapter = new CredentialedShareInspectorAdapter({
      types: ["115"],
      probe: async () => ({ kind: "listed", files }),
    });
    const result = await adapter.inspect(candidate("123"));
    expect(result.status).toBe("valid");
    expect(result.fileCount).toBe(2);
    expect(result.totalSizeBytes).toBe(1024);
    expect(result.files?.map((f) => f.name)).toEqual(["Show.S01E01.mkv", "Season 2"]);
  });

  it("空列表按 emptyMeans 判定：invalid（默认）或 unknown（光鸭式半失效）", async () => {
    const emptyProbe = async () => ({ kind: "listed" as const, files: [] });
    const strict = new CredentialedShareInspectorAdapter({ types: ["123"], probe: emptyProbe });
    expect((await strict.inspect(candidate("123"))).status).toBe("invalid");

    const lenient = new CredentialedShareInspectorAdapter({
      types: ["guangya"],
      probe: emptyProbe,
      emptyMeans: "unknown",
    });
    expect((await lenient.inspect(candidate("guangya"))).status).toBe("unknown");
  });

  it("探针抛错 → unknown（一次网络抖动不得把好资源判死）", async () => {
    const adapter = new CredentialedShareInspectorAdapter({
      types: ["123"],
      probe: async () => {
        throw new Error("socket hang up");
      },
    });
    const result = await adapter.inspect(candidate("123"));
    expect(result.status).toBe("unknown");
  });

  it("失效/提取码/限流三类结论各自透传", async () => {
    for (const kind of ["invalid", "password_required", "rate_limited"] as const) {
      const adapter = new CredentialedShareInspectorAdapter({
        types: ["123"],
        probe: async () => ({ kind, message: `${kind} reason` }),
      });
      const result = await adapter.inspect(candidate("123"));
      expect(result.status).toBe(kind);
    }
  });
});

describe("classifyShareProbeErrorMessage", () => {
  it("只识别确定的死亡信号；模糊错误留给 unknown", () => {
    expect(classifyShareProbeErrorMessage("分享已失效")).toBe("invalid");
    expect(classifyShareProbeErrorMessage("分享链接错误")).toBe("invalid");
    expect(classifyShareProbeErrorMessage("提取码错误")).toBe("password_required");
    expect(classifyShareProbeErrorMessage("ETIMEDOUT")).toBeNull();
    expect(classifyShareProbeErrorMessage("参数错误")).toBeNull();
  });
});

describe("search backends 模型", () => {
  it("规范化：去重 + 固定顺序 + 丢弃未知值", () => {
    expect(normalizeSearchBackends(["prowlarr", "nope", "pansou", "prowlarr"])).toEqual(["pansou", "prowlarr"]);
    expect(normalizeSearchBackends(undefined)).toEqual([]);
    expect(normalizeSearchBackends(["x"])).toEqual([]);
  });

  it("键：空 = all，子集按固定顺序，永不与 all 混同", () => {
    expect(searchBackendsKey([])).toBe("all");
    expect(searchBackendsKey(SEARCH_BACKENDS)).toBe([...SEARCH_BACKENDS].sort().join("+"));
    expect(searchBackendsKey(["prowlarr", "pansou"])).toBe(searchBackendsKey(["pansou", "prowlarr"]));
    expect(searchBackendsKey(["pansou"])).not.toBe("all");
  });
});

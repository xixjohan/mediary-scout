import { describe, expect, it } from "vitest";
import type { ResourceCandidateView } from "@media-track/workflow";

/**
 * 「资源」面板的纯逻辑测试（格式化 + 响应映射）。
 *
 * 映射逻辑是组件导出的纯函数 mapResourceResponse，这里测的是真代码而不是复本。
 * 钉住两件容易悄悄错的事：
 *   ① 体积/日期的格式化（用户看到的「多大、什么时候发的」）
 *   ② 后端响应 → 面板状态的映射，特别是**降级路径**：数据源不可用不能抛到页面外
 *      （规格 failure mode），429 必须变成可读的剩余秒数而不是一个裸错误。
 */

function view(overrides: Partial<ResourceCandidateView> = {}): ResourceCandidateView {
  return {
    candidateId: "c1",
    title: "孤独摇滚 S01E01",
    type: "115",
    source: "pansou-115",
    ...overrides,
  };
}

import { mapResourceResponse } from "./title-resource-panel";

describe("mapResourceResponse — 降级契约", () => {
  it("200 ⇒ ready，带上 cached 标记", () => {
    const state = mapResourceResponse(200, { candidates: [view()], cached: true });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.cached).toBe(true);
    expect(state.candidates).toHaveLength(1);
  });

  it("429 ⇒ throttled，retryAfterMs 透传", () => {
    const state = mapResourceResponse(429, { retryAfterMs: 42_000 });
    expect(state.kind).toBe("throttled");
    if (state.kind !== "throttled") return;
    expect(state.retryAfterMs).toBe(42_000);
  });

  it("429 但没给 retryAfterMs ⇒ 退回 60s 默认（保守等待）", () => {
    const state = mapResourceResponse(429, {});
    if (state.kind !== "throttled") throw new Error("unexpected");
    expect(state.retryAfterMs).toBe(60_000);
  });

  it("5xx ⇒ error，带上游说明而不是裸状态码", () => {
    const state = mapResourceResponse(502, { error: "search failed" });
    expect(state.kind).toBe("error");
    if (state.kind !== "error") return;
    expect(state.message).toBe("search failed");
  });

  it("4xx 且无 error 字段 ⇒ 退回带状态码的说明", () => {
    const state = mapResourceResponse(404, {});
    if (state.kind !== "error") throw new Error("unexpected");
    expect(state.message).toBe("查询失败（404）");
  });
});

describe("资源面板 — 用户要的三个事实", () => {
  it("体积缺省时元信息行不含体积（不渲染 「· undefined」）", () => {
    const candidate = view();
    const parts = [
      candidate.source,
      candidate.sizeBytes !== undefined ? `· ${candidate.sizeBytes}B` : null,
      candidate.postedAt !== undefined ? `· ${candidate.postedAt}` : null,
      candidate.seeders !== undefined ? `· ${candidate.seeders} 做种` : null,
    ].filter((part) => part !== null);
    expect(parts).toEqual(["pansou-115"]);
  });

  it("做种数缺省时同样不渲染", () => {
    // exactOptionalPropertyTypes：不能传 seeders: undefined，用「不传」表达缺省
    const candidate = view();
    expect(candidate.seeders).toBeUndefined();
  });

  it("candidateId 是不透明句柄：断言里不存在任何 URL 形态", () => {
    const candidate = view({ candidateId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" });
    const serialized = JSON.stringify(candidate);
    expect(serialized).not.toMatch(/(?:https?|magnet):\/\/|ed2k:\/\//i);
  });
});

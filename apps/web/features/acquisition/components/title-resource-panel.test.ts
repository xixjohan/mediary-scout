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

import {
  appendKeywordChip,
  mapImportResponse,
  mapResourceResponse,
  mapResourceStreamEvent,
  resourceTypeLabel,
} from "./title-resource-panel";

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

describe("mapResourceResponse — snapshotId 句柄", () => {
  it("带出 snapshotId（入库端点需要的不透明句柄）", () => {
    const state = mapResourceResponse(200, { candidates: [], cached: false, snapshotId: "snap-1" });
    if (state.kind !== "ready") throw new Error("unexpected");
    expect(state.snapshotId).toBe("snap-1");
  });

  it("**缓存命中 ⇒ snapshotId 为 null**（DB 才是权威，前端不重推导）", () => {
    // 这条钉住一个真实风险：缓存命中时后端刻意不回 snapshotId。若哪天后端开始回，
    // 而它回的是重新推导的那一份，前端就会拿着一个与 DB 不一致的句柄去入库。
    const state = mapResourceResponse(200, { candidates: [], cached: true });
    if (state.kind !== "ready") throw new Error("unexpected");
    expect(state.snapshotId).toBeNull();
  });
});

describe("mapImportResponse — 入库终局", () => {
  it("202 ⇒ queued", () => {
    expect(mapImportResponse(202, { status: "queued", workflowRunId: "r1" }).kind).toBe("queued");
  });

  it("200 already_running ⇒ 不是错误（什么都没新入队）", () => {
    const state = mapImportResponse(200, { status: "already_running", workflowRunId: "r1" });
    expect(state.kind).toBe("already_running");
  });

  it("410 ⇒ rejected 并带上 reason（客户端据此知道别原样重试）", () => {
    const state = mapImportResponse(410, { error: "搜索结果已超过 30 分钟", reason: "expired" });
    if (state.kind !== "rejected") throw new Error("unexpected");
    expect(state.reason).toBe("expired");
    expect(state.message).toContain("30 分钟");
  });

  it("400/404 ⇒ rejected，带上游说明", () => {
    for (const status of [400, 404]) {
      const state = mapImportResponse(status, { error: "boom" });
      if (state.kind !== "rejected") throw new Error("unexpected");
      expect(state.message).toBe("boom");
    }
  });

  it("无 error 字段 ⇒ 退回带状态码的说明", () => {
    const state = mapImportResponse(500, {});
    if (state.kind !== "rejected") throw new Error("unexpected");
    expect(state.message).toBe("入库失败（500）");
  });

  it("**没有任何终局形态会吐出 URL**（分享链自始至终不下前端）", () => {
    for (const [status, body] of [
      [202, { status: "queued", workflowRunId: "r1" }],
      [200, { status: "already_running", workflowRunId: "r1" }],
      [410, { error: "x", reason: "expired" }],
    ] as const) {
      expect(JSON.stringify(mapImportResponse(status, body))).not.toMatch(
        /(?:https?|magnet):\/\/|ed2k:\/\//i,
      );
    }
  });
});

describe("resourceTypeLabel — 候选行的资源类型标签", () => {
  /**
   * 网盘品牌名与设置页、连接组件里的叫法一致（115/夸克/天翼/123/光鸭），
   * 磁力叫「磁力」——pansou 结果的 source 字段已经带品牌，这枚标签让
   * pansou-115 与磁力候选在一眼里分得开。
   */
  it("每个 ResourceType 都有用户看得懂的中文标签", () => {
    expect(resourceTypeLabel("115")).toBe("115");
    expect(resourceTypeLabel("quark")).toBe("夸克");
    expect(resourceTypeLabel("tianyi")).toBe("天翼");
    expect(resourceTypeLabel("123")).toBe("123");
    expect(resourceTypeLabel("guangya")).toBe("光鸭");
    expect(resourceTypeLabel("magnet")).toBe("磁力");
    expect(resourceTypeLabel("manual")).toBe("手动");
  });

  it("标签里不含 URL 形态（不泄露、也不引导用户去拼分享链）", () => {
    for (const type of ["115", "quark", "tianyi", "123", "guangya", "magnet", "manual"] as const) {
      expect(resourceTypeLabel(type)).not.toMatch(/(?:https?|magnet):\/\/|ed2k:\/\//i);
    }
  });
});

describe("appendKeywordChip — 快捷词标签行为", () => {
  it("空白输入追加词时直接作为首个词", () => {
    expect(appendKeywordChip("", "4K")).toBe("4K");
    expect(appendKeywordChip("   ", "1080p")).toBe("1080p");
  });

  it("已有关键词追加新修饰词用空格隔开", () => {
    expect(appendKeywordChip("孤独摇滚", "4K")).toBe("孤独摇滚 4K");
    expect(appendKeywordChip("孤独摇滚 2024", "简日内嵌")).toBe("孤独摇滚 2024 简日内嵌");
  });

  it("已存在相同修饰词时不重复添加（大小写不敏感）", () => {
    expect(appendKeywordChip("孤独摇滚 4K", "4K")).toBe("孤独摇滚 4K");
    expect(appendKeywordChip("孤独摇滚 4k", "4K")).toBe("孤独摇滚 4k");
  });

  it("空修饰词时不修改原有关键词", () => {
    expect(appendKeywordChip("孤独摇滚", "")).toBe("孤独摇滚");
    expect(appendKeywordChip("孤独摇滚", "   ")).toBe("孤独摇滚");
  });
});

describe("mapResourceStreamEvent — 流式事件映射", () => {
  it("chunk 事件 ⇒ streaming 态，携带累积候选与进度", () => {
    const state = mapResourceStreamEvent({
      type: "chunk",
      newCandidates: [view({ candidateId: "c2" })],
      allCandidates: [view({ candidateId: "c1" }), view({ candidateId: "c2" })],
      progress: { done: 1, total: 3, currentKeyword: "流浪地球" },
    });
    expect(state.kind).toBe("streaming");
    if (state.kind === "streaming") {
      expect(state.candidates).toHaveLength(2);
      expect(state.progress.done).toBe(1);
      expect(state.progress.total).toBe(3);
    }
  });

  it("done 事件 ⇒ ready 态，携带快照句柄", () => {
    const state = mapResourceStreamEvent({
      type: "done",
      candidates: [view({ candidateId: "c1" })],
      cached: false,
      snapshotId: "snap_123",
    });
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(state.candidates).toHaveLength(1);
      expect(state.snapshotId).toBe("snap_123");
      expect(state.cached).toBe(false);
    }
  });

  it("error 事件 ⇒ 429 throttled 态或通用 error 态", () => {
    const throttled = mapResourceStreamEvent({
      type: "error",
      kind: "throttled",
      retryAfterMs: 45000,
    });
    expect(throttled.kind).toBe("throttled");
    if (throttled.kind === "throttled") {
      expect(throttled.retryAfterMs).toBe(45000);
    }

    const err = mapResourceStreamEvent({
      type: "error",
      kind: "error",
      detail: "网关超时",
    });
    expect(err.kind).toBe("error");
    if (err.kind === "error") {
      expect(err.message).toBe("网关超时");
    }
  });
});


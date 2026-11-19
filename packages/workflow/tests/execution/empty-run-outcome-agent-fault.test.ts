import { describe, expect, it } from "vitest";
import { emptyRunOutcome } from "../../src/domain/notification-report.js";

/**
 * 第四种「不是资源的问题」：智能体循环异常终止（model_error）。
 *
 * 事故原型（2026-11-18 生产实测，《咒术回战 第 1 季》）：
 *   resource_filter_applied { inputCount: 82, keptCount: 77, sourceStatus: "healthy" }
 *   loop_stopped            { stopReason: "model_error", steps: 1 }
 * 搜索取回 82 条、准入 77 条、源健康，仅因模型第一步报错就报「暂未找到可用资源」，
 * 而同一订阅在「预览」里能看到资源。
 *
 * 关键对照组：所有故障分支都不说话时，必须仍然是 no_coverage——
 * 一旦这条坏掉，产品就再也无法如实报告「确实没有」。
 */
const AGENT_FAULT = "AI 模型本轮没有产出任何可用步骤（上游空响应或报错），本次没有真正检索与评估资源。";

describe("emptyRunOutcome — 智能体异常终止要说真话", () => {
  it("模型崩了不再说「暂未找到可用资源」", () => {
    const out = emptyRunOutcome(null, null, null, AGENT_FAULT);

    expect(out.status).toBe("failed");
    expect(out.lines.join("")).not.toContain("暂未找到可用资源");
    expect(out.lines.join("")).toContain("AI 模型");
  });

  it("四个入参全空 → 仍是 no_coverage（不许把真·无覆盖也变成 failed）", () => {
    // 若这条断言坏掉，产品就再也无法如实报告「确实没有」—— 那比它要修的 bug 更糟。
    const out = emptyRunOutcome(null, null, null, null);
    expect(out.status).toBe("no_coverage");
    expect(out.lines).toEqual(["暂未找到可用资源 · 将持续尝试"]);
  });

  it("空串/空白的智能体故障原因不算故障（不因脏数据误报）", () => {
    expect(emptyRunOutcome(null, null, null, "").status).toBe("no_coverage");
    expect(emptyRunOutcome(null, null, null, "   ").status).toBe("no_coverage");
  });

  it("优先级：转存受阻 > 搜索源故障 > 规则全排除 > 智能体异常", () => {
    // 前三条都说「资源已经找到了」，对用户更有行动价值；agentFault 只在
    // 「连评估都没发生」时才说话。
    expect(emptyRunOutcome("配额不足", "源连不上", "规则排除", AGENT_FAULT).lines).toEqual([
      "转存失败:配额不足",
    ]);
    expect(emptyRunOutcome(null, "源连不上", "规则排除", AGENT_FAULT).lines).toEqual(["源连不上"]);
    expect(emptyRunOutcome(null, null, "规则排除", AGENT_FAULT).lines).toEqual(["规则排除"]);
    expect(emptyRunOutcome(null, null, null, AGENT_FAULT).lines).toEqual([AGENT_FAULT]);
  });

  it("前三参保持既有行为（未被第四参破坏）", () => {
    expect(emptyRunOutcome("登录过期", null, null, null).lines).toEqual(["转存失败:登录过期"]);
    expect(emptyRunOutcome(null, "源连不上", null, null).lines).toEqual(["源连不上"]);
    expect(emptyRunOutcome(null, null, "规则排除", null).lines).toEqual(["规则排除"]);
  });
});

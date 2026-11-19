import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../../src/domain.js";
import { classifyAgentFault } from "../../src/acquisition-v2/agent-fault.js";

/**
 * 智能体异常终止的分类边界。
 *
 * 事故原型（2026-11-18 生产实测，《咒术回战 第 1 季》）：
 *   resource_filter_applied { inputCount: 82, keptCount: 77, sourceStatus: "healthy" }
 *   loop_stopped            { stopReason: "model_error", steps: 1 }
 * 搜索成功、候选 77 条在盘上，模型第一步就崩；下游按集数判 no_coverage，
 * 用户读到「暂未找到可用资源」。
 *
 * 本模块最重要的边界是**不误判**：真实的「搜完了确实没有」落 candidate_exhausted，
 * 必须返回 null——把真·无覆盖也说成系统故障，比它要修的 bug 更糟。
 */

function loopStopped(stopReason: string, steps: number): AuditEvent {
  return {
    type: "loop_stopped",
    message: `智能体循环结束：${stopReason}（共 ${steps} 步）`,
    data: { stopReason, steps },
  };
}

function filterApplied(keptCount: number, inputCount = keptCount): AuditEvent {
  return {
    type: "resource_filter_applied",
    message: "候选准入结果",
    data: { keyword: "kw", inputCount, keptCount, policyDropped: 0, sourceStatus: "healthy" },
  };
}

describe("classifyAgentFault", () => {
  it("model_error + 1 步 + 未取回候选 → 报「没有产出任何可用步骤」", () => {
    const fault = classifyAgentFault([loopStopped("model_error", 1)]);
    expect(fault).not.toBeNull();
    expect(fault!.steps).toBe(1);
    expect(fault!.searchedCandidateCount).toBe(0);
    expect(fault!.reason).toContain("没有产出任何可用步骤");
    // 结论式措辞一个字都不能出现：那是把系统故障报成内容事实。
    expect(fault!.reason).not.toContain("暂未找到");
    expect(fault!.reason).not.toContain("没有资源");
  });

  it("model_error + 已取回候选 → 文案指出去哪看，并报出候选数", () => {
    const fault = classifyAgentFault([filterApplied(77, 82), loopStopped("model_error", 1)]);
    expect(fault).not.toBeNull();
    expect(fault!.searchedCandidateCount).toBe(77);
    expect(fault!.reason).toContain("77");
    expect(fault!.reason).toContain("资源");
    expect(fault!.reason).not.toContain("暂未找到");
  });

  it("model_error 但跑了多步 → null（替换运行用 reportReplacement 收尾，不能反过来说它崩了）", () => {
    // 判据：只认「模型只产出过一轮且毫无作为」。多步后结束的运行可能是
    // reportReplacement 正常收尾（替换请求的终结声明），把它报成 AI 异常是反向撒谎。
    expect(classifyAgentFault([loopStopped("model_error", 7)])).toBeNull();
    expect(classifyAgentFault([filterApplied(30), loopStopped("model_error", 3)])).toBeNull();
  });

  it("candidate_exhausted（真·搜完了没找到）→ null，必须保留 no_coverage", () => {
    expect(classifyAgentFault([filterApplied(0, 82), loopStopped("candidate_exhausted", 5)])).toBeNull();
  });

  it("coverage_met（真成功）→ null", () => {
    expect(classifyAgentFault([loopStopped("coverage_met", 12)])).toBeNull();
  });

  it("其余机械停止原因（step_limit / repetition_guard / io_budget）→ null", () => {
    for (const reason of ["step_limit", "repetition_guard", "io_budget", "time_budget", "provider_block"]) {
      expect(classifyAgentFault([loopStopped(reason, 60)])).toBeNull();
    }
  });

  it("没有 loop_stopped 事件（旧数据 / 非 agent 路径）→ null", () => {
    expect(classifyAgentFault([])).toBeNull();
    expect(classifyAgentFault(undefined)).toBeNull();
    expect(classifyAgentFault([filterApplied(50)])).toBeNull();
  });

  it("多条 loop_stopped 时取最后一条（重试链叠加）", () => {
    const fault = classifyAgentFault([
      loopStopped("model_error", 3),
      loopStopped("candidate_exhausted", 5),
    ]);
    expect(fault).toBeNull();
  });
});

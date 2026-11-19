import { describe, expect, it } from "vitest";
import { bridgeV2WorkflowToResult } from "../../src/acquisition-v2/workflow-v2-bridge.js";
import type { RunAcquisitionV2WorkflowResult } from "../../src/acquisition-v2/workflow-v2.js";
import type { AuditEvent, MediaTitle } from "../../src/domain.js";

/**
 * 端到端接线守卫：审计证据 → 报告状态 → 通知 kind。
 *
 * 事故原型（2026-11-18 生产实测，《咒术回战 第 1 季》）：
 *   resource_filter_applied { inputCount: 82, keptCount: 77, sourceStatus: "healthy" }
 *   loop_stopped            { stopReason: "model_error", steps: 1 }
 * 消费者最终看到的是 `no_coverage / 暂无资源`。本文件断言同一条审计证据现在会
 * 产出 `failed / agent_error`，且**真实无覆盖仍保持 no_coverage**（对照组）。
 */

const title = {
  id: "tmdb_tv_95479",
  tmdbId: 95479,
  type: "tv",
  title: "咒术回战",
  year: 2020,
  aliases: [],
} as unknown as MediaTitle;

function v2Result(over: Partial<RunAcquisitionV2WorkflowResult>): RunAcquisitionV2WorkflowResult {
  return {
    directories: { showDirectoryId: "show_1", seasonDirectoryIds: { 1: "season_1_dir" }, stagingDirectoryId: "staging_1" },
    missingBefore: ["S01E01", "S01E02"],
    outcome: { resourceSnapshots: [], decisions: [], transferAttempts: [] },
    agentText: "",
    stillMissing: ["S01E01", "S01E02"],
    obtained: [],
    providerAhead: [],
    auditEvents: [],
    ...over,
  };
}

function loopStopped(stopReason: string, steps: number): AuditEvent {
  return { type: "loop_stopped", message: `智能体循环结束：${stopReason}`, data: { stopReason, steps } };
}

function filterApplied(keptCount: number, inputCount = keptCount): AuditEvent {
  return {
    type: "resource_filter_applied",
    message: "候选准入结果",
    data: { keyword: "咒术回战", inputCount, keptCount, policyDropped: 0, sourceStatus: "healthy" },
  };
}

function bridge(auditEvents: AuditEvent[], mode: "type3" | "type2" | "series" = "type3") {
  return bridgeV2WorkflowToResult({
    title,
    mode,
    seasons: [{ seasonNumber: 1, totalEpisodes: 59, latestAiredEpisode: 59, qualityPreference: "4K" }],
    v2: v2Result({ auditEvents }),
    workflowRunId: "run-1",
    now: () => "2026-11-18T22:01:42.935Z",
  });
}

describe("agent_error 端到端接线", () => {
  it("model_error + 有候选 → failed / agent_error，文案不再说「暂未找到」", () => {
    const result = bridge([filterApplied(77, 82), loopStopped("model_error", 1)]);

    expect(result.status).toBe("no_coverage"); // 集数算术不变（缺集是事实）
    expect(result.notification.report?.status).toBe("failed"); // 但报告状态变诚实
    expect(result.notification.kind).toBe("agent_error");

    const lines = result.notification.report!.lines.join("");
    expect(lines).not.toContain("暂未找到可用资源");
    expect(lines).toContain("77");
  });

  it("model_error 且零候选 → 仍是 failed / agent_error，文案说「没有产出任何可用步骤」", () => {
    const result = bridge([filterApplied(0, 82), loopStopped("model_error", 1)]);
    expect(result.notification.kind).toBe("agent_error");
    expect(result.notification.report!.lines.join("")).toContain("没有产出任何可用步骤");
  });

  it("series 模式同样接线", () => {
    const result = bridge([filterApplied(77, 82), loopStopped("model_error", 1)], "series");
    expect(result.notification.kind).toBe("agent_error");
    expect(result.notification.report?.status).toBe("failed");
  });

  it("对照组：candidate_exhausted（真·搜完没找到）仍是 no_coverage / 暂无资源", () => {
    const result = bridge([filterApplied(0, 82), loopStopped("candidate_exhausted", 5)]);

    expect(result.notification.kind).toBe("no_coverage");
    expect(result.notification.report?.status).toBe("no_coverage");
    expect(result.notification.report!.lines).toEqual(["暂未找到可用资源 · 将持续尝试"]);
  });

  it("对照组：无任何审计事件（旧路径）仍是 no_coverage，不误判", () => {
    const result = bridge([]);
    expect(result.notification.kind).toBe("no_coverage");
    expect(result.notification.report?.status).toBe("no_coverage");
  });

  it("转存受阻优先于 agent 故障（能走到转存说明资源已找到）", () => {
    const result = bridgeV2WorkflowToResult({
      title,
      mode: "type3",
      seasons: [{ seasonNumber: 1, totalEpisodes: 59, latestAiredEpisode: 59, qualityPreference: "4K" }],
      v2: v2Result({
        auditEvents: [loopStopped("model_error", 1)],
        outcome: {
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [
            {
              id: "t1",
              workflowRunId: "run-1",
              candidateId: "c1",
              status: "failed",
              providerMessage: "115 云下载配额不足",
              materializedFileIds: [],
            } as never,
          ],
        },
      }),
      workflowRunId: "run-1",
      now: () => "2026-11-18T22:01:42.935Z",
    });

    expect(result.notification.kind).toBe("transfer_failed");
    expect(result.notification.report!.lines[0]).toContain("转存失败");
  });
});

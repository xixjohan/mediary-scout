import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2Workflow } from "../../src/acquisition-v2/workflow-v2.js";
import { FakeStorageExecutor } from "../../src/fakes.js";
import type { ResourceProvider } from "../../src/ports.js";
import type { ResourceSnapshot } from "../../src/domain.js";

/**
 * 任务单 S3.2 集成：workflow-v2 驱动生命周期状态机。
 * 契约：成功路径终态 completed 且补偿清单含暂存销毁；无事可做路径终态
 * nothingToDo；抛错路径经 Saga（FAIL→互检→COMPENSATED→failed）后原样上抛。
 */
const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function emptyProvider(): ResourceProvider {
  return {
    search: async ({ keyword }: { keyword: string }): Promise<ResourceSnapshot> => ({
      id: "snap_empty",
      provider: "pansou",
      keyword,
      candidates: [],
      createdAt: "2026-10-23T00:00:00.000Z",
    }),
  };
}

function tool(name: string, input: unknown, id: number) {
  return {
    content: [{ type: "tool-call" as const, toolCallId: `c${id}`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
    usage: USAGE,
    warnings: [],
  };
}

function request(executor: FakeStorageExecutor, model: MockLanguageModelV3, priorObtained?: string[]) {
  return {
    provider: emptyProvider(),
    executor,
    model,
    workflowRunId: "run-fsm",
    title: { name: "欺诈游戏", year: 2024, aliases: [], tmdbId: 42 },
    categoryParentId: "tv_root",
    seasons: [{ seasonNumber: 1, latestAiredEpisode: 1 }],
    qualityPreference: "1080p",
    ...(priorObtained ? { priorObtained } : {}),
  };
}

/** 协议合法的最小跑通：search → reportNoCoverage → 文本收尾。 */
function noCoverageModel(): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      step += 1;
      if (step === 1) return tool("searchResources", { keyword: "show" }, step);
      if (step === 2) return tool("reportNoCoverage", { reason: "no candidates" }, step);
      return {
        content: [{ type: "text" as const, text: "done" }],
        finishReason: { unified: "stop" as const, raw: "stop" as const },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

describe("workflow-v2 生命周期状态机集成（S3.2）", { timeout: 30_000 }, () => {
  it("成功路径：终态 completed，补偿清单含暂存目录销毁", async () => {
    const result = await runAcquisitionV2Workflow(request(new FakeStorageExecutor(), noCoverageModel()));
    expect(result.runState).toBe("completed");
    expect(result.compensations?.map((c) => c.kind)).toContain("staging_cleanup");
  });

  it("无事可做（DB 已是最新）：终态 nothingToDo，不跑 agent", async () => {
    // latestAired=1 且 priorObtained 已含 S01E01 → missing 为空
    const result = await runAcquisitionV2Workflow(
      request(new FakeStorageExecutor(), noCoverageModel(), ["S01E01"]),
    );
    expect(result.runState).toBe("nothingToDo");
    expect(result.agentText).toBe("");
  });

  it("抛错路径：Saga 记日志后原样上抛（staging 清理已由 withStagingCleanup 保证）", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("agent model unavailable");
        },
      });
      await expect(
        runAcquisitionV2Workflow(request(new FakeStorageExecutor(), model)),
      ).rejects.toThrow("agent model unavailable");
    } finally {
      console.log = originalLog;
    }
    const saga = logs.find((line) => line.includes("saga:"));
    expect(saga).toContain("staging_cleanup");
    expect(saga).toContain("failed");
  });
});

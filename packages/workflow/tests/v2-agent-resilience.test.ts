import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionAgent } from "../src/acquisition-v2/agent-loop.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

describe("AI 审查与 503 弹性容灾", () => {
  it("上游模型抛出 'The content you provided or machine outputted is blocked.' 时自动尝试纯净重试", async () => {
    const storage = new Storage115Simulator();
    const movieDirectoryId = await storage.createDirectory({ name: "Movie", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: {} }),
      storage,
      stagingDirectoryId: movieDirectoryId,
      targetMovieDirectoryId: movieDirectoryId,
      need: ["MOVIE"],
    });

    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("The content you provided or machine outputted is blocked.");
        }
        return {
          content: [{ type: "text", text: "Retried with clean prompt." }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    const result = await runAcquisitionAgent({
      sandbox,
      model,
      system: "Movie agent",
      prompt: "Get 流浪地球2",
      maxSteps: 5,
      movie: true,
    });

    expect(calls).toBe(2);
    expect(result.text).toContain("Retried with clean prompt");
  });

  it("当模型内容审查切断且沙盒内有候选时，自动通过确定性规则降级完成获取", async () => {
    const storage = new Storage115Simulator({
      packs: { full_pack: { files: [{ path: "Movie.mkv", sizeBytes: 100 }] } },
    });
    const movieDirectoryId = await storage.createDirectory({ name: "Movie", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({
        results: { "流浪地球2": [{ id: "full_pack", title: "流浪地球2 2023 2160p 4K UHD" }] },
      }),
      storage,
      stagingDirectoryId: movieDirectoryId,
      targetMovieDirectoryId: movieDirectoryId,
      need: ["MOVIE"],
    });

    // 预置候选快照进入沙盒
    await sandbox.searchResources("流浪地球2");

    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        return {
          content: [{ type: "text", text: "Stopped by filter." }],
          finishReason: { unified: "content-filter", raw: "content-filter" },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    const result = await runAcquisitionAgent({
      sandbox,
      model,
      system: "Movie agent",
      prompt: "Get 流浪地球2",
      maxSteps: 5,
      movie: true,
    });

    expect(result.text).toContain("Deterministic Fallback");
    expect(result.text).toContain("流浪地球2 2023 2160p 4K UHD");
  });
});

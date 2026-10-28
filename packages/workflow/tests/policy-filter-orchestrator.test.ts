import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2, type RunAcquisitionV2Request } from "../src/acquisition-v2/orchestrator.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceCandidate } from "../src/domain.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import { InMemoryWorkflowRepository } from "../src/repository.js";
import { matchPolicy, EMPTY_POLICY, type SubscriptionPolicy } from "../src/subscription-policy.js";

/** The last tool-result for `toolName`, from the prompt. See v2-orchestrator-replace.test.ts. */
function lastToolOutput(prompt: unknown, toolName: string): any {
  const messages = prompt as Array<{ role: string; content: unknown }>;
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]!;
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ type: string; toolName?: string; output?: { value?: unknown } }>) {
      if (part.type === "tool-result" && part.toolName === toolName) return part.output?.value;
    }
  }
  return undefined;
}

/**
 * Batch 5：策略层必须在 **agent 看到候选之前** 就把它过滤掉。
 *
 * 主线断言：策略过滤器和死链、用户拒绝**同一个位置**（RealResourceProviderV2 的
 * search 里），所以预热快照与 agent 的每次搜索共用它。一条交给 agent 去"记得忽略"
 * 的策略，就是会在最要紧的那次搜索上被忘掉的策略。
 */

const NOW = "2026-09-20T00:00:00.000Z";
const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;
const tool = (name: string, input: unknown, i: number) => ({
  content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
  usage: USAGE,
  warnings: [],
});

const GOOD = "Show.S01E01.2160p.BluRay.WEB-DL.mkv";
const JUNK = "Show.S01E02.CAM.枪版.mkv";
const OTHER_SEASON = "Show.S02E01.2160p.BluRay.WEB-DL.mkv";

/** A provider returning all three, so a filter that drops one is observable. */
function provider(): ResourceProvider {
  return {
    search: async ({ keyword }) => {
      const snapshotId = `snap_${keyword}`;
      const candidates: ResourceCandidate[] = [
        { id: "c_good", snapshotId, index: 0, title: GOOD, type: "magnet", source: "pansou", providerPayload: { url: `magnet:?xt=urn:btih:${"a".repeat(40)}` } },
        { id: "c_junk", snapshotId, index: 1, title: JUNK, type: "magnet", source: "pansou", providerPayload: { url: `magnet:?xt=urn:btih:${"b".repeat(40)}` } },
        { id: "c_other", snapshotId, index: 2, title: OTHER_SEASON, type: "magnet", source: "pansou", providerPayload: { url: `magnet:?xt=urn:btih:${"c".repeat(40)}` } },
      ];
      return { id: snapshotId, provider: "pansou", keyword, candidates, createdAt: NOW };
    },
  };
}

function baseRequest(model: RunAcquisitionV2Request["model"]): RunAcquisitionV2Request {
  return {
    provider: provider(),
    executor: new FakeStorageExecutor({}),
    model,
    workflowRunId: "run_policy",
    target: { kind: "movie", title: "Film", aliases: [], year: 2010, qualityPreference: "high", tmdbId: 7 },
    stagingDirectoryId: "film",
    targetMovieDirectoryId: "film",
    userRequest: {
      requestedEpisodes: ["MOVIE"],
      prompt: { messages: [{ body: "假片", episodeTags: [], createdAt: NOW }], rejected: [], pending: [] },
      rejectedStore: { list: async () => [], add: async () => undefined },
    },
  };
}

/**
 * Capture the titles the agent was actually shown in its snapshot view.
 *
 * The snapshot's tool output lands in the NEXT turn's prompt as a `role: "tool"` message
 * — so it is read on turn 2, not turn 1. Reading the prompt of turn 1 instead would
 * silently report "the agent saw nothing" and make every filter look like it worked.
 */
async function titlesAgentSaw(policy: SubscriptionPolicy | undefined): Promise<string[]> {
  const seen: string[] = [];
  let i = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      i += 1;
      if (i === 1) return tool("viewResourceSnapshot", {}, i);
      if (i === 2) {
        // The snapshot is a rendered document, not the raw candidate list.
        const document = String(lastToolOutput(options.prompt, "viewResourceSnapshot").document);
        for (const title of [GOOD, JUNK, OTHER_SEASON]) {
          if (document.includes(title)) seen.push(title);
        }
        return tool("reportReplacement", { results: [{ episode: "MOVIE", outcome: "not_found", note: "没有" }] }, i);
      }
      if (i === 3) return tool("finish", {}, i);
      return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: USAGE, warnings: [] };
    },
  });
  const request = baseRequest(model);
  if (policy === undefined) {
    delete (request as { policyFilter?: RunAcquisitionV2Request["policyFilter"] }).policyFilter;
  } else {
    request.policyFilter = { accept: (candidate) => matchPolicy(policy, candidate).matched };
  }
  await runAcquisitionV2(request);
  return seen;
}

describe("批次 5 — 策略过滤器在 agent 之前生效", () => {
  it("无策略 ⇒ 三个候选都让过（基线：不是把一切都挡了）", async () => {
    expect(await titlesAgentSaw(undefined)).toEqual([GOOD, JUNK, OTHER_SEASON]);
  });

  it("**mustNotContain 命中的在 agent 看到之前就没了**", async () => {
    const saw = await titlesAgentSaw({ ...EMPTY_POLICY, mustNotContain: ["CAM"] });
    expect(saw).toContain(GOOD);
    expect(saw).not.toContain(JUNK);
    expect(saw).toContain(OTHER_SEASON);
  });

  it("**episodeFilter 在 agent 之前就收窄**", async () => {
    const saw = await titlesAgentSaw({ ...EMPTY_POLICY, episodeFilter: "S01" });
    expect(saw).toContain(GOOD);
    expect(saw).not.toContain(OTHER_SEASON);
  });

  it("**过滤不是把一切都挡了：好资源仍在**", async () => {
    const saw = await titlesAgentSaw({ ...EMPTY_POLICY, mustContain: ["2160p"] });
    expect(saw).toEqual([GOOD, OTHER_SEASON]);
  });

  it("**被策略拒的候选根本无法被转存**（连 id 都拿不到）", async () => {
    // The agent reads the snapshot and tries to transfer the CAM copy. The strategy
    // already dropped it, so its candidate id is not in the snapshot at all — the
    // transfer is refused rather than silently landing a rejected resource.
    let transferError = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("viewResourceSnapshot", {}, i);
        if (i === 2) return tool("transferCandidate", { snapshotId: "snap_Film", candidateId: "c_junk" }, i);
        if (i === 3) {
          transferError = String(lastToolOutput(options.prompt, "transferCandidate")?.error ?? "");
          return tool("reportReplacement", { results: [{ episode: "MOVIE", outcome: "not_found", note: "没有" }] }, i);
        }
        if (i === 4) return tool("finish", {}, i);
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: USAGE, warnings: [] };
      },
    });
    const request = baseRequest(model);
    request.policyFilter = { accept: (candidate) => matchPolicy({ ...EMPTY_POLICY, mustNotContain: ["CAM"] }, candidate).matched };
    await runAcquisitionV2(request);
    expect(transferError).not.toBe("");
  });
});

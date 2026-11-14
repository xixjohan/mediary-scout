import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { coverageGatedActiveTools, runAcquisitionAgent } from "../../src/acquisition-v2/agent-loop.js";
import { TaskSandbox } from "../../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../../src/acquisition-v2/storage-115-simulator.js";

const TV_TOOLS = [
  "readSkill",
  "viewResourceSnapshot",
  "searchResources",
  "inspectStaging",
  "inspectTargetDir",
  "transferCandidate",
  "moveToSeason",
  "deleteFiles",
  "flattenMovie",
  "discardStaging",
  "markObtained",
  "finish",
  "reportNoCoverage",
];

const MOVIE_TOOLS = [...TV_TOOLS, "transferUntilLanded"];

// The finish-only recovery turn carries no acquisition tools at all.
const RECOVERY_TOOLS = [
  "readSkill",
  "inspectStaging",
  "inspectTargetDir",
  "moveToSeason",
  "deleteFiles",
  "flattenMovie",
  "markObtained",
  "finish",
  "reportNoCoverage",
];

describe("coverageGatedActiveTools — hide the acquisition surface once coverage is met", () => {
  it("does not gate while coverage is still missing (the agent may still search/transfer)", () => {
    expect(coverageGatedActiveTools(TV_TOOLS, false)).toBeUndefined();
    expect(coverageGatedActiveTools(MOVIE_TOOLS, false)).toBeUndefined();
  });

  it("drops the TV search/transfer tools post-coverage, keeping observe/organize/commit/finish", () => {
    const gated = coverageGatedActiveTools(TV_TOOLS, true);
    expect(gated).toBeDefined();
    expect(gated).not.toContain("viewResourceSnapshot");
    expect(gated).not.toContain("searchResources");
    expect(gated).not.toContain("transferCandidate");
    // The organize → mark → finish surface stays fully available.
    for (const name of ["inspectStaging", "inspectTargetDir", "moveToSeason", "markObtained", "finish", "readSkill"]) {
      expect(gated).toContain(name);
    }
  });

  it("also drops the movie-only transferUntilLanded post-coverage", () => {
    const gated = coverageGatedActiveTools(MOVIE_TOOLS, true);
    expect(gated).not.toContain("transferUntilLanded");
    expect(gated).not.toContain("transferCandidate");
    expect(gated).toContain("flattenMovie");
    expect(gated).toContain("finish");
  });

  it("leaves the soft subtitle goal and guidance tools visible (not part of the video acquisition surface)", () => {
    const gated = coverageGatedActiveTools([...TV_TOOLS, "viewSubtitleSnapshot", "transferSubtitle", "readMemory"], true);
    expect(gated).toContain("viewSubtitleSnapshot");
    expect(gated).toContain("transferSubtitle");
    expect(gated).toContain("readMemory");
  });

  it("returns undefined when no acquisition tool is present (recovery turn — nothing to gate)", () => {
    expect(coverageGatedActiveTools(RECOVERY_TOOLS, true)).toBeUndefined();
  });

  it("preserves the relative order of the remaining tools", () => {
    const gated = coverageGatedActiveTools(TV_TOOLS, true)!;
    const expected = TV_TOOLS.filter((n) => !["viewResourceSnapshot", "searchResources", "transferCandidate"].includes(n));
    expect(gated).toEqual(expected);
  });
});

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

async function coveredSandbox(cover: boolean) {
  const provider = new FakeResourceProviderV2({ results: { show: [{ id: "cand", title: "Show" }] } });
  const storage = new Storage115Simulator({ packs: { cand: { files: [{ path: "Show - 01.mkv", sizeBytes: 9 }] } } });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId },
    need: ["S01E01"],
  });
  if (cover) {
    const search = await sandbox.searchResources("show");
    const transfer = await sandbox.transferCandidate({ snapshotId: search.snapshot!.id, candidateId: "cand" });
    const fileIds = (transfer.staging as Array<{ id: string }>).map((f) => f.id);
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds }] });
    await sandbox.markObtained({ codes: ["S01E01"] });
  }
  return sandbox;
}

/** One inspectStaging step (capturing the tools the model is offered), then stop. */
function observingModel(seen: Array<string[]>) {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.push((options.tools ?? []).map((t) => t.name));
      i += 1;
      if (i === 1) {
        return {
          content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "inspectStaging", input: "{}" }],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
          usage: USAGE,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "done" }],
        finishReason: { unified: "stop" as const, raw: "stop" as const },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

describe("runAcquisitionAgent — coverage gating reaches the model's active tools", () => {
  it("offers the acquisition tools while coverage is still missing", async () => {
    const sandbox = await coveredSandbox(false);
    const seen: Array<string[]> = [];
    await runAcquisitionAgent({ sandbox, model: observingModel(seen), system: "s", prompt: "p", maxSteps: 3 });
    expect(seen[0]).toContain("transferCandidate");
    expect(seen[0]).toContain("searchResources");
  });

  it("hides search/transfer from the model once coverage is met, keeping organize/commit/finish", async () => {
    const sandbox = await coveredSandbox(true);
    const seen: Array<string[]> = [];
    await runAcquisitionAgent({ sandbox, model: observingModel(seen), system: "s", prompt: "p", maxSteps: 3 });
    expect(seen[0]).not.toContain("transferCandidate");
    expect(seen[0]).not.toContain("searchResources");
    expect(seen[0]).not.toContain("viewResourceSnapshot");
    expect(seen[0]).toContain("inspectStaging");
    expect(seen[0]).toContain("markObtained");
    expect(seen[0]).toContain("finish");
  });
});
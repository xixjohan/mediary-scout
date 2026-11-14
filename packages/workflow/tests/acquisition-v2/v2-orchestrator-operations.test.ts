import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2 } from "../../src/acquisition-v2/orchestrator.js";
import { FakeStorageExecutor } from "../../src/domain/fakes.js";
import { AcquisitionOperationStore } from "../../src/persistence/acquisition-operations.js";
import { claimOperationsSession } from "../../src/acquisition-v2/operations-session.js";
import { resourceLinkKey } from "../../src/acquisition-v2/resource-link.js";
import type { ResourceProvider } from "../../src/domain/ports.js";
import type { VerifiedFile } from "../../src/domain.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;
const tool = (name: string, input: unknown, i: number) => ({
  content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
  usage: USAGE,
  warnings: [],
});
const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: "stop" as const },
  usage: USAGE,
  warnings: [],
});

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

function file(id: string): VerifiedFile {
  return { id, storageDirectoryId: "staging", name: `${id}.mkv`, sizeBytes: 10, episodeCode: "S01E01", providerFileId: id };
}

const URL = "https://115.com/s/abc";
const SCOPE = "account:drive:title";
const INTENT_KEY = `staging:${resourceLinkKey(URL)}`;

const provider: ResourceProvider = {
  search: async ({ keyword }) => ({
    id: "snap",
    provider: "pansou",
    keyword,
    createdAt: "2026-11-14T00:00:00.000Z",
    candidates: [
      { id: "cand", snapshotId: "snap", index: 0, title: "Show (2026)", type: "115", source: "pansou", providerPayload: { url: URL } },
    ],
  }),
};

/** A model that views the snapshot, transfers the first candidate, then reports no coverage. */
function transferThenReportModel() {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      i += 1;
      if (i === 1) return tool("viewResourceSnapshot", {}, i);
      if (i === 2) {
        const doc = String(lastToolOutput(options.prompt, "viewResourceSnapshot").document);
        const alias = [...doc.matchAll(/\[(s\d+-\d+)\]/g)].map((m) => m[1]!)[0]!;
        return tool("transferCandidate", { snapshotId: alias.split("-")[0], candidateId: alias }, i);
      }
      if (i === 3) return tool("reportNoCoverage", { reason: "done" }, i);
      return text("done");
    },
  });
}

const target = { kind: "tv" as const, title: "Show", aliases: [], seasons: [1], missingEpisodes: ["S01E01"], qualityPreference: "1080p" };

describe("runAcquisitionV2 — durable operation ledger wired through the orchestrator", () => {
  it("registers the intent and finishes it with the typed outcome (accepted_pending stays unresolved)", async () => {
    const db = new Database(":memory:");
    const store = new AcquisitionOperationStore(db);
    const session = claimOperationsSession({ store, scope: SCOPE, runId: "run1", attemptId: "a1", ttlMs: 60000 })!;
    const exec = new FakeStorageExecutor({
      directories: { staging: [], season: [] },
      transferOutcomes: { cand: { status: "no_target_change", outcome: "accepted_pending", providerMessage: "pending", files: [] } },
    });

    await runAcquisitionV2({
      provider, executor: exec, model: transferThenReportModel(), workflowRunId: "run1",
      target, stagingDirectoryId: "staging", targetSeasonDirectoryIds: { 1: "season" }, operations: session,
    });

    const unresolved = store.unresolved(SCOPE);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({ status: "accepted_pending", runId: "run1", key: INTENT_KEY });
    session.release();
    db.close();
  });

  it("refuses a cross-run resubmission of an unresolved operation (the production 5x-resubmit guard)", async () => {
    const db = new Database(":memory:");
    const store = new AcquisitionOperationStore(db);
    // A prior run left the side effect unresolved (accepted but never landed).
    const prior = claimOperationsSession({ store, scope: SCOPE, runId: "run0", attemptId: "a0", ttlMs: 60000 })!;
    prior.begin({ key: INTENT_KEY, kind: "transfer", directoryId: "staging", resourceKey: resourceLinkKey(URL)!, fileIds: [] });
    prior.release();

    const session = claimOperationsSession({ store, scope: SCOPE, runId: "run2", attemptId: "a2", ttlMs: 60000 })!;
    const exec = new FakeStorageExecutor({
      directories: { staging: [], season: [] },
      transferOutcomes: { cand: { status: "succeeded", providerMessage: "ok", files: [file("ep1")] } },
    });

    const result = await runAcquisitionV2({
      provider, executor: exec, model: transferThenReportModel(), workflowRunId: "run2",
      target, stagingDirectoryId: "staging", targetSeasonDirectoryIds: { 1: "season" }, operations: session,
    });

    // The adapter refused before any provider call: no transfer attempt was recorded.
    expect(result.outcome.transferAttempts).toEqual([]);
    expect(store.unresolved(SCOPE)).toHaveLength(1); // still the prior run's intent
    session.release();
    db.close();
  });
});
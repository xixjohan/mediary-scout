import { describe, expect, it, vi } from "vitest";
import { makeAgentTraceSink, combineToolEventSinks } from "../../src/acquisition-v2/agent-trace-sink.js";
import type { AgentToolEvent } from "../../src/acquisition-v2/activity.js";
import { InMemoryWorkflowRepository } from "../../src/index.js";
import type { AgentStep } from "../../src/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const ev = (toolName: string, args: Record<string, unknown>): AgentToolEvent => ({
  toolName,
  args,
  activity: "x",
  phase: "search",
});

describe("makeAgentTraceSink", () => {
  it("appends one ordered step per event with apiCalls + ts", async () => {
    const appended: Array<{ id: string; step: AgentStep }> = [];
    const sink = makeAgentTraceSink({
      repository: {
        appendAgentStep: async (id, step) => {
          appended.push({ id, step });
        },
        listAgentSteps: async () => [],
        updateAgentStepEnd: async () => {},
      },
      workflowRunId: "run1",
      apiCallCount: () => (appended.length === 0 ? 3 : 7),
      now: () => "2026-06-22T00:00:00.000Z",
    });
    sink(ev("searchResources", { keyword: "莉可丽丝" }));
    sink(ev("transferCandidate", { candidateId: "c1" }));
    // fire-and-forget; let the microtasks flush
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appended.map((a) => a.step.ordinal)).toEqual([0, 1]);
    expect(appended[0]!.id).toBe("run1");
    expect(appended[0]!.step.toolName).toBe("searchResources");
    expect(appended[0]!.step.args.keyword).toBe("莉可丽丝");
    expect(appended[0]!.step.apiCalls).toBe(3);
    expect(appended[0]!.step.at).toBe("2026-06-22T00:00:00.000Z");
  });

  it("omits apiCalls when no counter, and swallows repo errors", () => {
    const sink = makeAgentTraceSink({
      repository: {
        appendAgentStep: async () => {
          throw new Error("db down");
        },
        listAgentSteps: async () => [],
        updateAgentStepEnd: async () => {},
      },
      workflowRunId: "run1",
    });
    expect(() => sink(ev("searchResources", {}))).not.toThrow();
  });

  it("caps pathologically large args", async () => {
    const appended: AgentStep[] = [];
    const sink = makeAgentTraceSink({
      repository: {
        appendAgentStep: async (_id, step) => { appended.push(step); },
        listAgentSteps: async () => [],
        updateAgentStepEnd: async () => {},
      },
      workflowRunId: "run1",
    });
    const huge = { moves: Array.from({ length: 5000 }, (_, i) => ({ fileIds: [`f${i}`] })) };
    sink(ev("moveToSeason", huge));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appended[0]!.args).toEqual({ _truncated: true });
  });

  it("a retried run (fresh sink, same runId) retains both attempts", async () => {
    const repo = new InMemoryWorkflowRepository();
    const first = makeAgentTraceSink({ repository: repo, workflowRunId: "run1", attemptId: "a1" });
    first(ev("searchResources", { keyword: "first" }));
    first(ev("transferCandidate", { candidateId: "c" }));
    first(ev("markObtained", { codes: ["S01E01"] }));
    await tick();
    expect((await repo.listAgentSteps("run1")).length).toBe(3);

    const retry = makeAgentTraceSink({ repository: repo, workflowRunId: "run1", attemptId: "a2" });
    retry(ev("searchResources", { keyword: "second" }));
    retry(ev("reportNoCoverage", { reason: "none" }));
    await tick();

    const steps = await repo.listAgentSteps("run1");
    // Both attempts survive, ordinals continue (no collision), each tagged by attempt.
    expect(steps.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(steps[0]!.args.keyword).toBe("first");
    expect(steps[3]!.args.keyword).toBe("second");
    expect(steps.slice(0, 3).every((s) => s.attemptId === "a1")).toBe(true);
    expect(steps.slice(3).every((s) => s.attemptId === "a2")).toBe(true);
  });

  it("appends stay ordered even though writes are fire-and-forget", async () => {
    const repo = new InMemoryWorkflowRepository();
    const sink = makeAgentTraceSink({ repository: repo, workflowRunId: "run1" });
    for (let i = 0; i < 6; i++) sink(ev("searchResources", { keyword: `k${i}` }));
    await tick();
    const steps = await repo.listAgentSteps("run1");
    expect(steps.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("routes an end event to updateAgentStepEnd by callId without consuming an ordinal", async () => {
    const appended: AgentStep[] = [];
    const ends: Array<{ callId: string; end: { endedAt: string; status: string; error?: string } }> = [];
    const sink = makeAgentTraceSink({
      repository: {
        appendAgentStep: async (_id, step) => { appended.push(step); },
        listAgentSteps: async () => [],
        updateAgentStepEnd: async (_id, callId, end) => { ends.push({ callId, end }); },
      },
      workflowRunId: "run1",
    });
    sink({ ...ev("searchResources", { keyword: "k" }), callId: "c1", kind: "start" });
    sink({
      ...ev("searchResources", { keyword: "k" }),
      callId: "c1",
      kind: "end",
      status: "failed",
      endedAt: "2026-06-22T00:00:01.000Z",
      error: "boom",
    });
    sink({ ...ev("transferCandidate", {}), callId: "c2", kind: "start" });
    await tick();
    // The end event consumed no ordinal: the second start still lands at 1.
    expect(appended.map((s) => s.ordinal)).toEqual([0, 1]);
    expect(appended[0]!.callId).toBe("c1");
    expect(ends).toEqual([
      { callId: "c1", end: { endedAt: "2026-06-22T00:00:01.000Z", status: "failed", error: "boom" } },
    ]);
  });

  it("ignores an end event with no callId (nothing to correlate)", async () => {
    const ends: string[] = [];
    const sink = makeAgentTraceSink({
      repository: {
        appendAgentStep: async () => {},
        listAgentSteps: async () => [],
        updateAgentStepEnd: async (_id, callId) => { ends.push(callId); },
      },
      workflowRunId: "run1",
    });
    sink({ ...ev("searchResources", {}), kind: "end", status: "succeeded" });
    await tick();
    expect(ends).toEqual([]);
  });

  it("merges the end outcome onto the persisted start step", async () => {
    const repo = new InMemoryWorkflowRepository();
    const sink = makeAgentTraceSink({ repository: repo, workflowRunId: "run1" });
    sink({ ...ev("searchResources", { keyword: "k" }), callId: "c1", kind: "start" });
    sink({
      ...ev("searchResources", { keyword: "k" }),
      callId: "c1",
      kind: "end",
      status: "succeeded",
      endedAt: "2026-06-22T00:00:01.000Z",
    });
    await tick();
    const steps = await repo.listAgentSteps("run1");
    expect(steps).toHaveLength(1);
    expect(steps[0]!.callId).toBe("c1");
    expect(steps[0]!.status).toBe("succeeded");
    expect(steps[0]!.endedAt).toBe("2026-06-22T00:00:01.000Z");
  });
});

describe("combineToolEventSinks", () => {
  it("fans out to every sink and isolates a throwing one", () => {
    const a = vi.fn();
    const b = vi.fn((_event: AgentToolEvent) => {
      throw new Error("boom");
    });
    const c = vi.fn();
    const combined = combineToolEventSinks(a, (e) => b(e), c);
    expect(() => combined(ev("searchResources", {}))).not.toThrow();
    expect(a).toHaveBeenCalledOnce();
    expect(c).toHaveBeenCalledOnce();
  });
});

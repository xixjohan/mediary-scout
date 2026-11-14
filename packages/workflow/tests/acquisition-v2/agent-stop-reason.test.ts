import { describe, expect, it } from "vitest";
import { deriveLoopStopReason } from "../../src/acquisition-v2/agent-stop-reason.js";

type Step = {
  toolCalls?: Array<{ toolName: string; input: unknown }>;
  toolResults?: Array<{ output: unknown }>;
};

const finishStep: Step = {
  toolCalls: [{ toolName: "finish", input: {} }],
  toolResults: [{ output: { coverageMet: true } }],
};
const noCoverageStep: Step = {
  toolCalls: [{ toolName: "reportNoCoverage", input: { reason: "none" } }],
  toolResults: [{ output: { reason: "none" } }],
};
const blockStep: Step = {
  toolCalls: [{ toolName: "transferCandidate", input: {} }],
  toolResults: [{ output: { systemicBlock: { reason: "quota" } } }],
};
const searchStep = (keyword: string): Step => ({
  toolCalls: [{ toolName: "searchResources", input: { keyword } }],
  toolResults: [{ output: { snapshot: { id: "s" } } }],
});

describe("deriveLoopStopReason", () => {
  it("labels a successful finish coverage_met", () => {
    expect(deriveLoopStopReason({ steps: [finishStep], stepLimit: 60 })).toBe("coverage_met");
  });

  it("labels a successful no-coverage report candidate_exhausted", () => {
    expect(deriveLoopStopReason({ steps: [noCoverageStep], stepLimit: 60 })).toBe("candidate_exhausted");
  });

  it("labels a systemic transfer block with nothing landed provider_block", () => {
    expect(deriveLoopStopReason({ steps: [blockStep], stepLimit: 60 })).toBe("provider_block");
  });

  it("labels four identical action-observation steps repetition_guard", () => {
    const steps = [searchStep("a"), searchStep("a"), searchStep("a"), searchStep("a")];
    expect(deriveLoopStopReason({ steps, stepLimit: 60 })).toBe("repetition_guard");
  });

  it("labels a run that hit the step ceiling step_limit", () => {
    const steps = [searchStep("a"), searchStep("b"), searchStep("c")];
    expect(deriveLoopStopReason({ steps, finishReason: "stop", stepLimit: 3 })).toBe("step_limit");
  });

  it("labels an exhausted hard budget io_budget", () => {
    expect(
      deriveLoopStopReason({ steps: [searchStep("a")], stepLimit: 60, apiCallsSpent: 300, hardBudget: 300 }),
    ).toBe("io_budget");
  });

  it("does not label io_budget when the hard budget is unknown", () => {
    expect(deriveLoopStopReason({ steps: [searchStep("a")], stepLimit: 60, apiCallsSpent: 300 })).toBe(
      "model_error",
    );
  });

  it("labels a content-filter finish model_error", () => {
    expect(deriveLoopStopReason({ steps: [finishStep], finishReason: "content-filter", stepLimit: 60 })).toBe(
      "model_error",
    );
  });

  it("labels a bare model stop with no terminal declaration model_error", () => {
    expect(deriveLoopStopReason({ steps: [searchStep("a")], finishReason: "stop", stepLimit: 60 })).toBe(
      "model_error",
    );
  });

  it("lets a terminal declaration win over the step ceiling", () => {
    const steps = [finishStep, searchStep("a"), searchStep("b")];
    expect(deriveLoopStopReason({ steps, stepLimit: 3 })).toBe("coverage_met");
  });
});
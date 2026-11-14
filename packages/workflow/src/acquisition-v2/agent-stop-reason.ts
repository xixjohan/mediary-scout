import {
  hasSuccessfulFinish,
  hasSuccessfulNoCoverageReport,
  hasSystemicTransferBlock,
  toStepSignature,
} from "./agent-loop-guards.js";
import { shouldStopForRepetition } from "./repetition-stop.js";

/**
 * Why the agent loop ended (研究文档 §11.1 `loopStopReason`). The SDK finishReason
 * and the business stop reason are kept separate: this answers the business side
 * ("why did it stop"), not "what did the model emit". Pure → unit-testable.
 */
export type LoopStopReason =
  | "coverage_met"
  | "candidate_exhausted"
  | "repetition_guard"
  | "step_limit"
  | "io_budget"
  | "time_budget"
  | "provider_block"
  | "pending_handoff"
  | "cancelled"
  | "model_error";

/** Minimal structural view of an AI-SDK step — matches the loop guards' StepLike. */
interface StepLike {
  toolCalls?: ReadonlyArray<{ toolName: string; input: unknown }>;
  toolResults?: ReadonlyArray<{ output: unknown }>;
}

export interface LoopStopInput {
  steps: ReadonlyArray<StepLike>;
  /** AI SDK finishReason of the final turn ("stop" | "tool-calls" | "content-filter" | "error" | …). */
  finishReason?: string;
  stepLimit: number;
  apiCallsSpent?: number;
  /** Agent-facing hard budget; io_budget is only derivable when both are known. */
  hardBudget?: number;
}

/**
 * Derive the business stop reason from the final step history + SDK finishReason.
 * Terminal declarations win over mechanical guards (a run that finished honestly is
 * coverage_met even if it also brushed the step cap). A content-filter / error
 * finish is model_error; so is a bare model stop with no terminal declaration — the
 * agent ended without finishing or honestly reporting no coverage.
 */
export function deriveLoopStopReason(input: LoopStopInput): LoopStopReason {
  const { steps, finishReason, stepLimit, apiCallsSpent, hardBudget } = input;
  if (finishReason === "content-filter" || finishReason === "error") {
    return "model_error";
  }
  if (hasSuccessfulFinish(steps)) {
    return "coverage_met";
  }
  if (hasSuccessfulNoCoverageReport(steps)) {
    return "candidate_exhausted";
  }
  if (hasSystemicTransferBlock(steps)) {
    return "provider_block";
  }
  if (
    typeof apiCallsSpent === "number" &&
    typeof hardBudget === "number" &&
    apiCallsSpent >= hardBudget
  ) {
    return "io_budget";
  }
  if (shouldStopForRepetition(steps.map(toStepSignature))) {
    return "repetition_guard";
  }
  if (steps.length >= stepLimit) {
    return "step_limit";
  }
  return "model_error";
}
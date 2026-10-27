import type { AgentStep } from "./domain.js";
import { redactAgentStepArgs } from "./agent-step-redaction.js";

/**
 * Step view model for the activity page's agent timeline (W4 L1).
 *
 * L1 is 「activity/run 详情页内嵌 listAgentSteps 时间线。零新表、零新接口」 — the
 * steps ride the EXISTING /api/activity response, so no new endpoint and no new
 * table. The only new code is this projection, which is where redaction is applied.
 *
 * Why redaction lives HERE and not at the trace sink: `agent_steps.args` is the raw
 * tool input, captured pre-execution, and it can carry a drive cookie. Redacting on
 * write would destroy the forensic value the trace exists for
 * (agent-trace-integration.test.ts asserts the real keyword stays reviewable).
 * Redacting on read protects the UI surface — the browser, the network, the
 * browser history — while a maintainer with DB access keeps the original.
 *
 * `args` is therefore the ONLY field that changes shape; the rest are display
 * fields that never held a secret.
 */
export interface AgentStepView {
  ordinal: number;
  toolName: string;
  /** Human-readable one-liner (「搜索 孤独摇滚」). */
  activity: string;
  phase: AgentStep["phase"];
  /** Cumulative drive API calls before this step — the cost the user actually feels. */
  apiCalls?: number;
  at: string;
  /** Redacted tool args. Credentials and URLs are gone by construction. */
  args: Record<string, unknown>;
}

/** A run can log hundreds of steps; the panel is a timeline, not a firehose. */
export const MAX_TIMELINE_STEPS = 50;

/**
 * Project steps for display, newest last (the order they happened). Redaction is
 * applied per step; the input is never mutated.
 */
export function toAgentStepViews(steps: readonly AgentStep[]): AgentStepView[] {
  return steps.map((step) => ({
    ordinal: step.ordinal,
    toolName: step.toolName,
    activity: step.activity,
    phase: step.phase,
    ...(typeof step.apiCalls === "number" ? { apiCalls: step.apiCalls } : {}),
    at: step.at,
    args: redactAgentStepArgs(step.args),
  }));
}

/**
 * The tail of the trace, for a bounded timeline. Takes the LAST `limit` steps —
 * the end of a run is what a user watching 活动 wants (the transfer/verify tail),
 * not the search fan-out at the start.
 */
export function tailAgentStepViews(
  steps: readonly AgentStep[],
  limit: number = MAX_TIMELINE_STEPS,
): AgentStepView[] {
  const bounded = Math.max(0, Math.floor(limit));
  const tail = bounded >= steps.length ? steps : steps.slice(steps.length - bounded);
  return toAgentStepViews(tail);
}

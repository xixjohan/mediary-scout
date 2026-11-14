import { randomUUID } from "node:crypto";
import type { WorkflowRepository } from "../persistence/repository.js";
import type { AgentStep } from "../domain.js";
import type { AgentToolEvent } from "./activity.js";

const MAX_ARGS_JSON = 2000;

/** Defensive cap: a pathologically large args object (e.g. a giant moveToSeason
 *  plan) collapses to a marker so one trace row can't bloat unbounded. */
function cappedArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    if (JSON.stringify(args).length <= MAX_ARGS_JSON) {
      return args;
    }
  } catch {
    // non-serializable → fall through to marker
  }
  return { _truncated: true };
}

/**
 * A tool-event sink that appends each agent tool call to the durable step trace.
 * Fire-and-forget + error-swallowing: observability MUST NEVER fail an acquisition.
 * Fires from `onToolCall` (pre-execution), so even a tool that then throws/hangs
 * (e.g. a 115 budget exhaustion) still leaves its step — crash-safe by construction.
 * `apiCallCount` (optional) stamps the cumulative 115 API calls so far, making the
 * budget-burn curve visible across the trace.
 *
 * Retention: a manual retry / auto-requeue re-runs under the SAME run id. Rather
 * than clearing the prior attempt, this sink CONTINUES the ordinal from the
 * persisted step count and stamps a fresh `attemptId`, so both attempts stay
 * visible and distinguishable in the timeline. Ordinals are assigned inside the
 * serialized write chain (seeded by the existing count), so concurrent tool
 * events never collide and the agent itself never awaits any of this.
 *
 * Each invocation emits a "start" event (appends the step) and an "end" event
 * (merges the post-execution outcome onto that step by callId). Both ride the same
 * serialized chain, so an end update always lands after its start append. End
 * events consume no ordinal.
 */
export function makeAgentTraceSink(input: {
  repository: Pick<WorkflowRepository, "appendAgentStep" | "listAgentSteps" | "updateAgentStepEnd">;
  workflowRunId: string;
  attemptId?: string;
  apiCallCount?: () => number | undefined;
  now?: () => string;
}): (event: AgentToolEvent) => void {
  const now = input.now ?? (() => new Date().toISOString());
  const attemptId = input.attemptId ?? randomUUID();
  // Seed the next ordinal from the persisted step count so a retry appends after
  // the prior attempt instead of colliding with it. A read failure degrades to 0
  // (best-effort); the chain below still serializes every append in order.
  let tail: Promise<number> = input.repository
    .listAgentSteps(input.workflowRunId)
    .then((steps) => steps.length)
    .catch(() => 0);
  return (event: AgentToolEvent) => {
    if (event.kind === "end") {
      const callId = event.callId;
      const endedAt = event.endedAt ?? now();
      const status = event.status ?? "succeeded";
      const error = event.error;
      tail = tail
        .then((ordinal) => {
          if (!callId) {
            return ordinal;
          }
          return input.repository
            .updateAgentStepEnd(input.workflowRunId, callId, {
              endedAt,
              status,
              ...(error === undefined ? {} : { error }),
            })
            .then(() => ordinal)
            .catch(() => ordinal);
        })
        .catch(() => 0);
      return;
    }
    const apiCalls = input.apiCallCount?.();
    const at = now();
    const callId = event.callId;
    tail = tail
      .then((ordinal) => {
        const step: AgentStep = {
          ordinal,
          attemptId,
          toolName: event.toolName,
          args: cappedArgs(event.args),
          activity: event.activity,
          phase: event.phase,
          ...(callId === undefined ? {} : { callId }),
          ...(typeof apiCalls === "number" ? { apiCalls } : {}),
          at,
        };
        return input.repository
          .appendAgentStep(input.workflowRunId, step)
          .then(() => ordinal + 1)
          .catch(() => ordinal + 1);
      })
      .catch(() => 0);
  };
}

/** Run several tool-event sinks for one event; each is isolated so one throwing
 *  sink never starves the others (progress must survive a trace failure & vice versa). */
export function combineToolEventSinks(
  ...sinks: Array<(event: AgentToolEvent) => void>
): (event: AgentToolEvent) => void {
  return (event: AgentToolEvent) => {
    for (const sink of sinks) {
      try {
        sink(event);
      } catch {
        // isolate: a misbehaving sink must not break the others
      }
    }
  };
}

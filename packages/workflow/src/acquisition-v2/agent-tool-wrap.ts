import { randomUUID } from "node:crypto";
import type { ToolSet } from "ai";

/**
 * Tool-call observability wrapper, split out of the agent loop harness so the
 * loop file stays focused on orchestration. Two concerns live here:
 *   (a) a cleaned progress event per invocation for the activity page (always,
 *       when `onToolCall` is given), and
 *   (b) opt-in raw stdout logging (MEDIA_TRACK_AGENT_LOG=1) so live e2e is not a
 *       black box. Off by default (silent in tests).
 */

/** Per-invocation trace metadata emitted alongside each tool call: a stable
 *  callId correlating the start/end pair, plus the end-only outcome. */
export interface ToolCallMeta {
  callId: string;
  kind: "start" | "end";
  status?: "succeeded" | "failed";
  endedAt?: string;
  error?: string;
}

/** A guard refusal surfaces as `{ error }` evidence (never a throw). Treat a
 *  non-empty string error as a failed outcome; partial per-item `errors` arrays
 *  are NOT a whole-call failure. */
function resultErrorText(result: unknown): string | undefined {
  if (result && typeof result === "object" && "error" in result) {
    const error = (result as { error?: unknown }).error;
    if (typeof error === "string" && error.length > 0) {
      return error;
    }
  }
  return undefined;
}

/** Run one tool, capturing a throw as evidence so the end event still fires
 *  (crash-safe) and the original error is re-thrown unchanged afterwards. */
async function runToolCapturing(
  execute: (args: unknown, options: unknown) => Promise<unknown>,
  args: unknown,
  executeOptions: unknown,
): Promise<{ threw: boolean; error: unknown; result: unknown }> {
  try {
    return { threw: false, error: undefined, result: await execute(args, executeOptions) };
  } catch (error) {
    return { threw: true, error, result: undefined };
  }
}

/** Build the end-event meta from a captured outcome: a throw or a guard-refusal
 *  `{ error }` is "failed" (with the structured message); anything else succeeded. */
function endMetaOf(callId: string, outcome: { threw: boolean; error: unknown; result: unknown }): ToolCallMeta {
  const errorText = outcome.threw
    ? outcome.error instanceof Error
      ? outcome.error.message
      : String(outcome.error)
    : resultErrorText(outcome.result);
  return {
    callId,
    kind: "end",
    status: errorText === undefined ? "succeeded" : "failed",
    endedAt: new Date().toISOString(),
    ...(errorText === undefined ? {} : { error: errorText }),
  };
}

/**
 * Wrap every tool's execute so each call can emit progress and (optionally) log.
 * The wrapper is a passthrough when neither is active. The progress emit is
 * best-effort — a throw in `onToolCall` must never break the agent's tool
 * execution.
 *
 * Each invocation emits a "start" event pre-execution (crash-safe) and an "end"
 * event post-execution carrying the outcome, correlated by a per-call callId.
 */
export function wrapTools(
  tools: ToolSet,
  options: { onToolCall?: (toolName: string, args: Record<string, unknown>, meta: ToolCallMeta) => void; log: boolean },
): ToolSet {
  if (!options.onToolCall && !options.log) {
    return tools;
  }
  const wrapped: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as { execute: (args: unknown, options: unknown) => Promise<unknown> }).execute;
    wrapped[name] = {
      ...(tool as object),
      execute: async (args: unknown, executeOptions: unknown) => {
        const callId = randomUUID();
        const safeArgs = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
        const emit = (meta: ToolCallMeta) => {
          if (!options.onToolCall) {
            return;
          }
          try {
            options.onToolCall(name, safeArgs, meta);
          } catch {
            // progress is a display nicety — never let it break a tool call
          }
        };
        emit({ callId, kind: "start" });
        if (options.log) {
          const argStr =
            Object.keys(safeArgs).length > 0 ? ` ${JSON.stringify(safeArgs).slice(0, 240)}` : "";
          console.log(`[agent] → ${name}${argStr}`);
        }
        const outcome = await runToolCapturing(execute, args, executeOptions);
        emit(endMetaOf(callId, outcome));
        if (options.log) {
          console.log(`[agent] ← ${name}: ${JSON.stringify(outcome.result).slice(0, 400)}`);
        }
        if (outcome.threw) {
          throw outcome.error;
        }
        return outcome.result;
      },
    };
  }
  return wrapped as ToolSet;
}
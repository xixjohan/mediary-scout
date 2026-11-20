import { generateText, InvalidToolInputError, NoSuchToolError, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import { agentChoiceAudit, agentModelDiagnosticEvent, rememberAgentModelDiagnostics } from "../domain/agent-model-diagnostics.js";
import type { AuditEvent } from "../domain/domain.js";
import type { LoopStopReason } from "./agent-stop-reason.js";

type TurnResult = Awaited<ReturnType<typeof generateText>>;

/** Peak single-request input usage across every step in one generateText turn. */
export function peakInputTokensOf(turn: unknown): number | undefined {
  if (!turn || typeof turn !== "object") return undefined;
  const record = turn as {
    usage?: { inputTokens?: unknown };
    steps?: unknown;
  };
  const values: number[] = [];
  const add = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) values.push(value);
  };
  add(record.usage?.inputTokens);
  if (Array.isArray(record.steps)) {
    for (const step of record.steps) {
      if (step && typeof step === "object") {
        add((step as { usage?: { inputTokens?: unknown } }).usage?.inputTokens);
      }
    }
  }
  return values.length > 0 ? Math.max(...values) : undefined;
}

const READ_ONLY_RECOVERY_TIMEOUT_MS = 15_000;

async function recoverInitialModelTurn(
  model: LanguageModel,
  viewResourceSnapshot: ToolSet[string],
): Promise<AuditEvent> {
  const startedAt = performance.now();
  const deadline = AbortSignal.timeout(READ_ONLY_RECOVERY_TIMEOUT_MS);
  let outcome: "snapshot_observed" | "no_tool_result" | "timed_out" | "failed";
  try {
    // The acquisition loop has already ended. Only read the existing snapshot;
    // a fresh full turn would put transfer and file mutation tools back in scope.
    const result = await generateText({
      model,
      prompt: "The acquisition stopped before inspecting the prefetched search results. Call viewResourceSnapshot now with {}.",
      tools: { viewResourceSnapshot },
      toolChoice: { type: "tool", toolName: "viewResourceSnapshot" },
      stopWhen: stepCountIs(1),
      maxRetries: 0,
      abortSignal: deadline,
    });
    outcome = result.toolResults.some((item) => item.toolName === "viewResourceSnapshot")
      ? "snapshot_observed"
      : "no_tool_result";
  } catch {
    outcome = deadline.aborted ? "timed_out" : "failed";
  }
  return {
    type: "agent_read_only_recovery",
    message: "AI 首轮提前结束，尝试只读查看候选快照",
    data: {
      toolName: "viewResourceSnapshot",
      outcome,
      deadlineMs: READ_ONLY_RECOVERY_TIMEOUT_MS,
      elapsedMs: Math.round(performance.now() - startedAt),
    },
  };
}

/** Collect diagnostics across a run, including model retries and read-only recovery. */
export function createAgentTurnDiagnostics(model: LanguageModel) {
  const diagnosticEvents: AuditEvent[] = [];
  let completedSteps = 0;
  let toolResults = 0;
  let turnStartedAt = performance.now();
  const recordDiagnostic = (outcome: Parameters<typeof agentModelDiagnosticEvent>[0]["outcome"]) => {
    const event = agentModelDiagnosticEvent({
      model,
      steps: completedSteps,
      toolResults,
      elapsedMs: Math.round(performance.now() - turnStartedAt),
      outcome,
    });
    diagnosticEvents.push(event);
    return event;
  };
  const recordReturnedDiagnostic = (result: Awaited<ReturnType<typeof generateText>>) => {
    return recordDiagnostic({
      finishReason: result.finishReason,
      rawFinishReason: result.rawFinishReason,
      textProduced: Boolean(result.text?.trim()),
      toolCalls: result.toolCalls?.length ?? 0,
      invalidToolCall: result.content?.some((part) => part.type === "tool-error" &&
        (InvalidToolInputError.isInstance(part.error) || NoSuchToolError.isInstance(part.error))) ?? false,
      response: result.response ?? {},
    });
  };

  function observeStep(step: { toolResults: readonly unknown[] }): void {
    completedSteps += 1;
    toolResults += step.toolResults.length;
  }

  function rememberFailure(error: unknown): void {
    rememberAgentModelDiagnostics(error, diagnosticEvents);
  }

  async function runTurn<T>(generate: () => Promise<T>): Promise<T> {
    turnStartedAt = performance.now();
    try {
      return await agentChoiceAudit.run((event) => diagnosticEvents.push(event), generate);
    } catch (error) {
      recordDiagnostic({ error });
      rememberFailure(error);
      throw error;
    }
  }

  async function recordFinalResult(result: TurnResult, stopReason: LoopStopReason, diagnosedResult: TurnResult | undefined, viewSnapshot: ToolSet[string] | undefined): Promise<void> {
    if ((stopReason !== "model_error" && result.rawFinishReason !== "error") ||
      result.finishReason === undefined || result === diagnosedResult) return;
    const firstTurn = !diagnosticEvents.some((event) => event.type === "agent_model_diagnostic") &&
      completedSteps === 1 && toolResults === 0;
    const event = recordReturnedDiagnostic(result);
    if (firstTurn && event.data?.["category"] === "no_terminal_action" &&
      event.data["toolCalls"] === 0 && viewSnapshot) {
      const recovery = await agentChoiceAudit.run(
        (choice) => diagnosticEvents.push(choice),
        () => recoverInitialModelTurn(model, viewSnapshot),
      );
      diagnosticEvents.push(recovery);
    }
  }

  return { diagnosticEvents, observeStep, rememberFailure, recordReturnedDiagnostic, runTurn, recordFinalResult };
}

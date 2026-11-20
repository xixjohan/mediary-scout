import { APICallError, InvalidResponseDataError, RetryError, TypeValidationError, type LanguageModel } from "ai";
import { AsyncLocalStorage } from "node:async_hooks";
import { extractHttpStatus, isTransientAcquisitionError } from "../acquisition-v2/transient-error.js";
import { isContentBlockedError } from "../acquisition-v2/prompt-sanitizer.js";
import type { AuditEvent } from "./domain.js";

type ModelConfigSource = "db" | "env" | "free-preset";
export const modelConfigSources = new WeakMap<object, ModelConfigSource>();
const diagnosticsByError = new WeakMap<object, readonly AuditEvent[]>();
export const agentChoiceAudit = new AsyncLocalStorage<(event: AuditEvent) => void>();

export function rememberAgentModelDiagnostics(error: unknown, events: readonly AuditEvent[]): void {
  if (typeof error === "object" && error !== null) diagnosticsByError.set(error, [...events]);
}

export function agentModelDiagnosticsOf(error: unknown): readonly AuditEvent[] {
  return typeof error === "object" && error !== null ? diagnosticsByError.get(error) ?? [] : [];
}

const failureMessages: Record<string, string> = {
  auth: "认证失败，请检查 API Key 和权限",
  model_not_found: "未找到模型或接口",
  rate_limit: "请求受限，请稍后重试",
  quota_exhausted: "模型额度不足",
  upstream_unavailable: "上游模型服务暂不可用",
  timeout: "请求超时",
  content_filtered: "模型请求被内容审查中断",
  protocol_error: "模型接口返回异常",
  transport_error: "模型连接中断",
};

export function modelFailureMessage(category: unknown): string {
  return typeof category === "string" && Object.hasOwn(failureMessages, category)
    ? failureMessages[category]!
    : "模型请求失败，请检查接口和模型设置";
}

export function diagnosedAgentErrorMessage(error: unknown): string | undefined {
  const last = agentModelDiagnosticsOf(error).at(-1);
  if (!last) return undefined;
  const category = isContentBlockedError(error) ? "content_filtered" : last.data?.["category"];
  return `AI 模型调用失败：${modelFailureMessage(category)}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function readErrorEnvelope(body: unknown): Record<string, unknown> | undefined {
  return record(record(body)?.["error"]);
}

function httpStatus(value: unknown): number | undefined {
  const status = typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : value;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function statusCategory(status: number | undefined, errorCode: unknown) {
  if (errorCode === "insufficient_quota") return "quota_exhausted";
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || errorCode === "model_not_found") return "model_not_found";
  if (status === 429) return "rate_limit";
  if (status === 408) return "timeout";
  if (status !== undefined && status >= 500) return "upstream_unavailable";
}

export function requestIdentifier(headers: Record<string, string> | undefined, id: unknown): string | undefined {
  const candidate = headers?.["x-request-id"] ?? headers?.["request-id"] ?? id;
  // Accept known ID prefixes and UUIDs. Other strings may contain credentials.
  return typeof candidate === "string" &&
    /^(?:(?:req_|chatcmpl-|gen-)[a-zA-Z0-9_-]{3,80}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(candidate)
    ? candidate
    : undefined;
}

const finishReasons = new Set([
  "stop", "length", "tool-calls", "tool_calls", "function_call", "content-filter", "content_filter",
  "error", "other", "end_turn", "max_tokens", "stop_sequence",
]);

function safeFinishReason(value: string | undefined): string | undefined {
  return value === undefined || finishReasons.has(value) ? value : "unrecognized";
}

function failureCategory(error: unknown, status: number | undefined, errorCode: unknown) {
  if (isContentBlockedError(error)) return "content_filtered";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (InvalidResponseDataError.isInstance(error) || TypeValidationError.isInstance(error) || status === 200) {
    return "protocol_error";
  }
  return statusCategory(status, errorCode)
    ?? (isTransientAcquisitionError(error) ? "transport_error" : undefined);
}

function readFailure(error: unknown) {
  const api = APICallError.isInstance(error) ? error : undefined;
  const envelope = readErrorEnvelope(api?.data);
  const errorCode = envelope?.["code"] ?? envelope?.["type"] ?? record(api?.data)?.["code"];
  const status = httpStatus(extractHttpStatus(error));
  const category = failureCategory(error, status, errorCode);
  if (!category && !api && status === undefined) return undefined;
  return {
    category: category ?? "unknown",
    httpStatus: status,
    requestId: requestIdentifier(api?.responseHeaders, undefined),
    sdkRetryable: api?.isRetryable,
  };
}

export function describeModelCallFailure(error: unknown) {
  const retries = RetryError.isInstance(error) ? error : undefined;
  const failure = retries ? retries.lastError : error;
  const sdkAttempts = retries?.errors.length;
  let current = failure;
  // SDK errors can wrap a network cause or a nested API failure.
  for (let depth = 0; depth < 6 && current !== undefined; depth += 1) {
    const details = readFailure(current);
    if (details) return { ...details, sdkAttempts };
    current = record(current)?.["cause"];
  }
  return {
    category: isTransientAcquisitionError(failure) ? "transport_error" : "unknown",
    sdkAttempts,
  };
}

export function agentModelDiagnosticEvent(input: {
  model: LanguageModel;
  elapsedMs: number;
  steps: number;
  toolResults: number;
  outcome: { error: unknown } | {
    finishReason: string;
    rawFinishReason?: string | undefined;
    textProduced: boolean;
    toolCalls: number;
    invalidToolCall: boolean;
    response: { id?: string; headers?: Record<string, string>; body?: unknown };
  };
}): AuditEvent {
  const { model, elapsedMs, steps, toolResults, outcome } = input;
  const thrown = "error" in outcome;
  const diagnostics = thrown ? describeModelCallFailure(outcome.error) : (() => {
    const { finishReason, rawFinishReason, response } = outcome;
    const envelope = readErrorEnvelope(response.body);
    const upstreamStatus = httpStatus(envelope?.["code"] ?? envelope?.["status"]);
    return {
      category: statusCategory(upstreamStatus, envelope?.["code"])
        ?? (finishReason === "content-filter" ? "content_filtered" : undefined)
        ?? (outcome.invalidToolCall ? "tool_call_invalid" : undefined)
        ?? (envelope || finishReason === "error" || rawFinishReason === "error" ? "protocol_error" : "no_terminal_action"),
      finishReason: safeFinishReason(finishReason),
      rawFinishReason: safeFinishReason(rawFinishReason),
      textProduced: outcome.textProduced,
      toolCalls: outcome.toolCalls,
      upstreamStatus,
      requestId: requestIdentifier(response.headers, response.id),
    };
  })();
  return {
    type: "agent_model_diagnostic",
    message: "AI 模型调用诊断",
    data: {
      ...diagnostics,
      phase: thrown ? "thrown" : "returned",
      steps, toolResults, elapsedMs,
      configSource: typeof model === "object" ? modelConfigSources.get(model) ?? "unknown" : "unknown",
    },
  };
}

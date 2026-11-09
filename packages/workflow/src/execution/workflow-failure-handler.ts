import type { NotificationEvent, NotificationReport } from "../domain/domain.js";
import type { PersistedWorkflowRunSnapshot, WorkflowRepository } from "../persistence/repository.js";
import {
  AUTO_REQUEUE_BACKOFF_MS,
  AUTO_REQUEUE_MAX,
  failWorkflowRun,
  requeueWorkflowRunForRetry,
} from "../persistence/repository.js";
import { isTransientAcquisitionError } from "../acquisition-v2/transient-error.js";
import { stagingFailureAuditEvents } from "../acquisition-v2/directory-lifecycle.js";
import {
  describeAgentRunError,
  isLlmAuthError,
  isLlmHttpStatusError,
  isLlmModelGoneError,
  isLlmRateLimitError,
  isLlmServerError,
  summarizeErrorForNotification,
} from "../domain/agent-error.js";
import { isFreeLlmPreset } from "../domain/agent-model.js";
import { formatReportPushText } from "../domain/notification-report.js";
import { maybeFreezeOnBrandAuthError } from "../storage/storage-auth-error.js";

function failureReport(
  claimed: PersistedWorkflowRunSnapshot,
  status: "failed" | "retrying",
  lines: string[],
): NotificationReport {
  return {
    titleName: claimed.title.title,
    seasonLabel:
      claimed.title.type !== "movie" && claimed.workflowRun.kind !== "replace_request" && claimed.season.seasonNumber
        ? `第 ${claimed.season.seasonNumber} 季`
        : null,
    status,
    lines,
    newlyObtained: [],
    realMissing: [],
    posterPath: claimed.title.posterPath ?? null,
    tmdbId: claimed.title.tmdbId,
    mediaType: claimed.title.type,
    year: claimed.title.year,
  };
}

export const FREE_LLM_POOL_FAILURE_LINE =
  "AI 模型调用失败：Kilo 公共免费池暂时不可用（限速或服务波动）。可稍后重试，或在 设置 → AI 模型 换成自己的服务。";

export const FREE_LLM_MODEL_GONE_LINE =
  "内置免费模型已失效（Kilo 池变动）。请到 设置 → AI 模型 换一个模型或换成自己的服务。";

function failureHeadline(input: {
  error: unknown;
  llmConfig: { baseURL?: string; modelId?: string } | undefined;
}): string | null {
  if (!isFreeLlmPreset(input.llmConfig ?? {})) {
    return null;
  }
  if (isLlmModelGoneError(input.error)) {
    return FREE_LLM_MODEL_GONE_LINE;
  }
  if (
    isLlmRateLimitError(input.error) ||
    isLlmAuthError(input.error) ||
    isLlmServerError(input.error)
  ) {
    return FREE_LLM_POOL_FAILURE_LINE;
  }
  return null;
}

export function isTransientForRun(
  error: unknown,
  llmConfig: { baseURL?: string; modelId?: string } | undefined,
): boolean {
  const httpStatusClassified =
    isFreeLlmPreset(llmConfig ?? {}) &&
    (isLlmModelGoneError(error) ||
      isLlmRateLimitError(error) ||
      isLlmAuthError(error) ||
      isLlmServerError(error) ||
      isLlmHttpStatusError(error));
  return isTransientAcquisitionError(
    error,
    0,
    httpStatusClassified ? { httpStatusClassified: true } : undefined,
  );
}

function buildFailureOutcome(
  claimed: PersistedWorkflowRunSnapshot,
  error: unknown,
  errorMessage: string,
  nowIso: string,
  transient: boolean,
  willRetry: boolean,
  priorCount: number,
  llmConfig?: { baseURL?: string; modelId?: string },
) {
  const leakEvents = stagingFailureAuditEvents(error);
  const claimedRun =
    leakEvents.length === 0
      ? claimed.workflowRun
      : { ...claimed.workflowRun, auditEvents: [...claimed.workflowRun.auditEvents, ...leakEvents] };

  if (willRetry) {
    const workflowRun = requeueWorkflowRunForRetry(claimedRun, errorMessage, nowIso);
    const minutes = Math.round((AUTO_REQUEUE_BACKOFF_MS[priorCount] ?? 0) / 60_000);
    const report = failureReport(claimed, "retrying", [
      `网络波动 · 第 ${priorCount + 1} 次自动重试,约 ${minutes} 分钟后`,
      `原因:${summarizeErrorForNotification(errorMessage)}`,
    ]);
    return { workflowRun, report };
  }

  const workflowRun = failWorkflowRun(claimedRun, errorMessage, nowIso);
  const headline = failureHeadline({ error, llmConfig });
  const report = failureReport(claimed, "failed", [
    headline ?? (transient ? `网络中断,已自动重试 ${priorCount} 次仍失败` : "获取失败"),
    summarizeErrorForNotification(errorMessage),
  ]);
  return { workflowRun, report };
}

async function persistFailureSnapshot(
  repository: Pick<WorkflowRepository, "saveWorkflowRunSnapshot">,
  claimed: PersistedWorkflowRunSnapshot,
  workflowRun: any,
  report: NotificationReport,
  willRetry: boolean,
  priorCount: number,
  nowIso: string,
  notificationTrigger?: "user" | "scheduled",
) {
  const notification: NotificationEvent = {
    id: `notification_${claimed.workflowRun.id}_${willRetry ? `retry${priorCount + 1}` : "failed"}`,
    workflowRunId: claimed.workflowRun.id,
    kind: claimed.workflowRun.kind,
    title: claimed.title.title,
    body: formatReportPushText(report),
    createdAt: nowIso,
    trigger: notificationTrigger ?? "user",
    report,
  };

  const silent = claimed.workflowRun.kind === "staging_recovery";
  const manualSubscription = claimed.workflowRun.kind === "type3_monitor" &&
    claimed.workflowRun.auditEvents.some((event) => event.type === "manual_subscription_search_queued");
  const keepEpisodes = willRetry || claimed.workflowRun.kind === "replace_request";
  await repository.saveWorkflowRunSnapshot({
    accountId: claimed.accountId,
    connectedStorageId: claimed.connectedStorageId,
    title: claimed.title,
    season: claimed.season,
    workflowRun,
    episodes: keepEpisodes ? claimed.episodes : [],
    resourceSnapshots: willRetry ? claimed.resourceSnapshots : [],
    decisions: willRetry ? claimed.decisions : [],
    transferAttempts: willRetry ? claimed.transferAttempts : [],
    notifications: silent ? [] : [notification],
    ...(silent || manualSubscription ? { keepCurrentEpisodes: true } : {}),
    ...(manualSubscription ? { requireTrackedSeason: true, requireRunningWorkflowRun: true } : {}),
  });
}

export async function handleWorkflowRunFailure(input: {
  claimed: PersistedWorkflowRunSnapshot;
  error: unknown;
  repository: Pick<WorkflowRepository, "saveWorkflowRunSnapshot">;
  now: () => string;
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  notificationTrigger?: "user" | "scheduled";
  llmConfig?: { baseURL?: string; modelId?: string };
}): Promise<{ status: "auto_requeued" | "failed"; workflowRunId: string; errorMessage: string }> {
  const { claimed, error, repository } = input;
  const nowIso = input.now();
  const errorMessage = describeAgentRunError(error);
  const priorCount = claimed.workflowRun.autoRequeueCount ?? 0;
  const transient = isTransientForRun(error, input.llmConfig);
  const willRetry = transient && priorCount < AUTO_REQUEUE_MAX;

  const { workflowRun, report } = buildFailureOutcome(
    claimed,
    error,
    errorMessage,
    nowIso,
    transient,
    willRetry,
    priorCount,
    input.llmConfig,
  );

  console.log(
    `[workflow] run ${claimed.workflowRun.id} ${claimed.workflowRun.kind} ${willRetry ? "auto_requeued" : "failed"}` +
      ` (storage ${claimed.connectedStorageId ?? "-"}): ${summarizeErrorForNotification(errorMessage)}`,
  );

  await persistFailureSnapshot(
    repository,
    claimed,
    workflowRun,
    report,
    willRetry,
    priorCount,
    nowIso,
    input.notificationTrigger,
  );

  await maybeFreezeOnBrandAuthError({
    connectedStorageId: claimed.connectedStorageId,
    error,
    ...(input.onAuthErrorFreeze === undefined ? {} : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
  });
  return {
    status: willRetry ? "auto_requeued" : "failed",
    workflowRunId: claimed.workflowRun.id,
    errorMessage,
  };
}

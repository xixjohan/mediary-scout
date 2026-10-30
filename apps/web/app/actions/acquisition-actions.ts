"use server";

import { revalidatePath } from "next/cache";
import { queueCandidateSeries, queueCandidateTracking, reserveCandidate } from "../../lib/workflow-runtime";
import { assertNotDemo } from "../../lib/demo-mode";

/**
 * Acquire-time LLM pre-check (issue #52) — NARROWED with the shipped free preset:
 * 零配置时 resolveAgentModelConfig 回落 FREE_LLM_PRESET，不再拦截（开箱即用）；
 * acquireLlmPreflightError 只拦半截配置（baseURL/modelId 一空一非空）——那种
 * run 入队后会在 claim 前死于 llmConfigError 且无人收尸（ghost run），所以在
 * 点击时用同一条文案友好拦下（详见其注释）。
 */
export async function acquireLlmNotConfigured(): Promise<RequestTrackingActionResult | null> {
  const { getCurrentAccountId, acquireLlmPreflightError } = await import("../../lib/workflow-runtime");
  const message = await acquireLlmPreflightError(await getCurrentAccountId());
  return message ? { status: "llm_not_configured", message } : null;
}


export interface RequestTrackingActionResult {
  status:
    | "requested"
    | "already_tracked"
    | "active_workflow"
    | "reserved"
    | "unsupported"
    // Acquire-time LLM pre-check (issue #52): no live model configured, so nothing
    // was enqueued. The UI surfaces `message` and keeps the 获取 control clickable
    // (NOT flipped to 获取中/已请求) — it is a not-started result, like `unsupported`.
    | "llm_not_configured";
  message: string;
}

export async function requestTrackingAction(input?: {
  candidateId?: string;
  currentState?: "can_request" | "already_tracked" | "active_workflow" | "can_reserve" | "reserved";
  /** Tree model: the active workspace drive — acquisition lands HERE, not the primary. */
  storageId?: string;
}): Promise<RequestTrackingActionResult> {
  assertNotDemo();
  if (input?.currentState === "already_tracked") {
    return {
      status: "already_tracked",
      message: "已追踪，后台会继续按缺集状态检查。",
    };
  }

  if (input?.currentState === "active_workflow") {
    return {
      status: "active_workflow",
      message: "获取任务已在运行中，不会重复创建。",
    };
  }

  if (input?.currentState === "reserved") {
    return {
      status: "reserved",
      message: "已预定，上映后会自动获取并通知你。",
    };
  }

  // 预定 an unreleased film — track it without running the agent now.
  if (input?.currentState === "can_reserve" && input?.candidateId) {
    const request = await reserveCandidate(input.candidateId, input.storageId);
    if (request.status === "unsupported") {
      return { status: "unsupported", message: request.message };
    }
    if (request.status === "already_running") {
      return { status: "active_workflow", message: "获取任务已在运行中，不会重复创建。" };
    }
    if (request.status === "already_tracked") {
      return { status: "already_tracked", message: "已追踪，后台会继续按缺集状态检查。" };
    }
    revalidatePath("/");
    return { status: "reserved", message: "已预定，上映后会自动获取并通知你。" };
  }

  if (input?.candidateId) {
    const preflight = await acquireLlmNotConfigured();
    if (preflight) {
      return preflight;
    }
    const request = await queueCandidateTracking(input.candidateId, input.storageId);
    if (request.status === "already_tracked") {
      return {
        status: "already_tracked",
        message: "已追踪，后台会继续按缺集状态检查。",
      };
    }
    if (request.status === "already_running") {
      return {
        status: "active_workflow",
        message: "获取任务已在运行中，不会重复创建。",
      };
    }
    if (request.status === "unsupported") {
      return {
        status: "unsupported",
        message: request.message,
      };
    }

    revalidatePath("/");
    return {
      status: "requested",
      message: "已加入后台队列，完成后会通知你。",
    };
  }

  return {
    status: "requested",
    message: "已收到获取请求。",
  };
}

export async function requestSeriesAction(input: {
  candidateId: string;
  // Tree model: the active workspace drive — REQUIRED (value may be undefined =
  // primary) so a non-primary acquisition can't silently mis-route. See note on
  // requestSeasonAction.
  storageId: string | undefined;
}): Promise<RequestTrackingActionResult> {
  assertNotDemo();
  const preflight = await acquireLlmNotConfigured();
  if (preflight) {
    return preflight;
  }
  const request = await queueCandidateSeries(input.candidateId, input.storageId);
  if (request.status === "already_tracked") {
    return { status: "already_tracked", message: "全剧已追踪，后台会继续按缺集状态检查。" };
  }
  if (request.status === "already_running") {
    return { status: "active_workflow", message: "全剧获取任务已在运行中。" };
  }
  if (request.status === "unsupported") {
    return { status: "unsupported", message: request.message };
  }
  revalidatePath("/");
  return { status: "requested", message: "全剧获取已加入后台队列。" };
}

export interface ForeignWorkImportActionResult {
  status: "imported" | "failed";
  message: string;
}

export async function importForeignWorkAction(input: {
  providerFileIds: string[];
  movieTitle: string;
  year: number;
}): Promise<ForeignWorkImportActionResult> {
  assertNotDemo();
  const movieTitle = input.movieTitle.trim();
  const year = Number(input.year);
  if (!movieTitle || !Number.isInteger(year) || year < 1880 || year > 2100) {
    return { status: "failed", message: "请填写有效的电影名称与年份。" };
  }
  if (input.providerFileIds.length === 0) {
    return { status: "failed", message: "没有可入库的文件。" };
  }
  const { importForeignWorkFiles, isUpdateInProgress, UpdateInProgressError } = await import("../../lib/workflow-runtime");
  // A container swap mid-import leaves a half-moved folder the retry can't finish. Refuse
  // upfront while the updater holds new work; importForeignWorkFiles rechecks the hold once
  // it is counted in flight and throws UpdateInProgressError if the hold was taken in the
  // gap between here and there, so the swap handshake cannot win that race.
  if (isUpdateInProgress()) {
    return { status: "failed", message: "正在更新，更新完成后再入库。" };
  }
  try {
    await importForeignWorkFiles({
      providerFileIds: input.providerFileIds,
      movieTitle,
      year,
    });
    revalidatePath("/notifications");
    return {
      status: "imported",
      message: `已入库到 ${movieTitle} (${year})。`,
    };
  } catch (error) {
    if (error instanceof UpdateInProgressError) {
      return { status: "failed", message: "正在更新，更新完成后再入库。" };
    }
    return { status: "failed", message: `入库失败：${String(error)}` };
  }
}

export async function requestSeasonAction(input: {
  tmdbId: number;
  seasonNumber: number;
  // Tree model: the active workspace drive — acquisition lands HERE, not the
  // primary. REQUIRED (value may be undefined = primary) so every call site must
  // consciously thread the workspace; an omitted storageId silently mis-routes a
  // non-primary (e.g. quark) acquisition to the primary drive and the run never
  // shows on the workspace the user is looking at.
  storageId: string | undefined;
}): Promise<RequestTrackingActionResult> {
  assertNotDemo();
  const preflight = await acquireLlmNotConfigured();
  if (preflight) {
    return preflight;
  }
  const { queueSeasonTracking } = await import("../../lib/title-hub");
  const request = await queueSeasonTracking(input.tmdbId, input.seasonNumber, input.storageId);
  if (request.status === "already_tracked") {
    return { status: "already_tracked", message: "本季已追踪。" };
  }
  if (request.status === "already_running") {
    return { status: "active_workflow", message: "本季获取任务已在运行中。" };
  }
  if (request.status === "unsupported") {
    return { status: "unsupported", message: request.message };
  }
  revalidatePath(`/show/${input.tmdbId}`);
  revalidatePath("/");
  return { status: "requested", message: `第 ${input.seasonNumber} 季已加入后台队列。` };
}

export async function requestRemainingAction(input: {
  tmdbId: number;
  // Tree model: the active workspace drive — REQUIRED (value may be undefined =
  // primary) so a non-primary acquisition can't silently mis-route. See note on
  // requestSeasonAction.
  storageId: string | undefined;
}): Promise<RequestTrackingActionResult> {
  assertNotDemo();
  const preflight = await acquireLlmNotConfigured();
  if (preflight) {
    return preflight;
  }
  const { queueRemainingSeasons } = await import("../../lib/title-hub");
  const request = await queueRemainingSeasons(input.tmdbId, input.storageId);
  if (request.status === "already_tracked") {
    return { status: "already_tracked", message: "所有季都已在追踪。" };
  }
  if (request.status === "already_running") {
    return { status: "active_workflow", message: "获取任务已在运行中。" };
  }
  if (request.status === "unsupported") {
    return { status: "unsupported", message: request.message };
  }
  revalidatePath(`/show/${input.tmdbId}`);
  revalidatePath("/");
  return { status: "requested", message: "剩余季已加入后台队列。" };
}

export async function untrackTitleAction(input: {
  tmdbId: number;
  // Tree model: REQUIRED (value may be undefined = primary) so the active
  // workspace is always threaded — untrack must act on the drive being viewed.
  storageId: string | undefined;
  // Disambiguates TMDB's movie/tv id namespaces (same number can be both) so
  // untracking a series never deletes a movie with the same id, and vice versa.
  mediaKind: "movie" | "tv";
  seasonNumber?: number;
}): Promise<{ status: "untracked" | "not_found" | "in_flight"; message: string }> {
  assertNotDemo();
  const { untrackTrackedTitle } = await import("../../lib/workflow-runtime");
  const result = await untrackTrackedTitle(
    input.tmdbId,
    input.storageId,
    input.mediaKind,
    input.seasonNumber,
  );
  revalidatePath("/");
  revalidatePath(`/show/${input.tmdbId}`);
  if (result.status === "in_flight") {
    return { status: "in_flight", message: "获取进行中，完成或在活动页取消后再取消追踪。" };
  }
  if (result.status === "not_found") {
    return { status: "not_found", message: "该剧未在当前网盘追踪。" };
  }
  return { status: "untracked", message: "已取消追踪（网盘文件已保留）。" };
}

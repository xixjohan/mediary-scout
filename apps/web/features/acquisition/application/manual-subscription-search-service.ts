import {
  isRegisteredStorageProvider,
  queueTrackedSubscriptionSearch,
  resolveQueueStorageChoice,
  type ManualSubscriptionSearchSource,
} from "@media-track/workflow";
import { getWorkflowRepository } from "../../../composition/runtime-container";
import { acquireLlmPreflightError } from "./acquisition-service";

export type ManualSubscriptionSearchServiceResult = {
  status:
    | "queued"
    | "already_running"
    | "not_tracked"
    | "no_missing"
    | "not_ready"
    | "invalid_target"
    | "invalid_storage"
    | "storage_frozen"
    | "not_configured";
  message: string;
  workflowRunId?: string;
  trackedSeasonId?: string;
};

/** Shared entry for Server Actions and MCP; all identity and drive checks stay server-side. */
export async function triggerManualSubscriptionSearch(input: {
  accountId: string;
  tmdbId: number;
  mediaType: "movie" | "tv" | "anime";
  seasonNumber?: number;
  storageId?: string | null;
  source: ManualSubscriptionSearchSource;
  sourceWorkflowRunId?: string;
}): Promise<ManualSubscriptionSearchServiceResult> {
  const repository = getWorkflowRepository();
  const storages = (await repository.listConnectedStorages(input.accountId)).filter((storage) =>
    isRegisteredStorageProvider(storage.provider),
  );
  if (input.storageId === null && storages.length > 0) {
    return { status: "invalid_storage", message: "该任务没有绑定具体网盘，无法安全确定搜索位置。请在对应网盘下打开作品详情并重新触发。" };
  }
  const storageChoice = resolveQueueStorageChoice(storages, input.storageId);
  if (storageChoice.unknown) {
    return { status: "invalid_storage", message: "当前网盘不存在或不属于此账号。" };
  }
  if (storageChoice.frozen) {
    return { status: "storage_frozen", message: "网盘授权已失效，请先重新连接后再搜索。" };
  }

  const llmError = await acquireLlmPreflightError(input.accountId);
  if (llmError) return { status: "not_configured", message: llmError };

  const result = await queueTrackedSubscriptionSearch({
    repository,
    accountId: input.accountId,
    connectedStorageId: storageChoice.id,
    tmdbId: input.tmdbId,
    mediaType: input.mediaType,
    ...(input.seasonNumber === undefined ? {} : { seasonNumber: input.seasonNumber }),
    source: input.source,
    ...(input.sourceWorkflowRunId === undefined ? {} : { sourceWorkflowRunId: input.sourceWorkflowRunId }),
  });

  switch (result.status) {
    case "queued":
      return { ...result, message: "已加入后台队列，完成后可在活动页查看结果。" };
    case "already_running":
      return { ...result, message: "该目标已有任务在排队或运行中。" };
    case "not_tracked":
      return { status: result.status, message: "当前网盘尚未追踪这个作品或季度。" };
    case "no_missing":
      return { status: result.status, message: "当前没有待搜索的已播缺失资源。" };
    case "not_ready":
      return { status: result.status, message: "影片尚未上映，暂不能手动补搜。" };
    case "invalid_target":
      return { status: result.status, message: "作品类型或季数无效，请刷新后重试。" };
    default:
      return { status: "invalid_target", message: "作品类型或季数无效，请刷新后重试。" };
  }
}

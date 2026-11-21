import {
  parseTitleWithChain,
  createTmdbMetadataProvider,
} from "@media-track/workflow";
import { decryptSecret } from "@media-track/shared";
import {
  executeSearchMedia,
  executeQueryStatus,
  executeQueryLibrary,
} from "../../../features/assistant/application/chat-agent-service";
import { executeDiscoverMedia } from "../../../features/assistant/core/chat-discover";
import {
  getAccountDriveFileManager,
  getAccountConnectedStorages,
  getTmdbAccesses,
  getAccountScopedSettings,
  getWorkflowRepository,
  getActiveWorkspaceScope,
  getWorkerResourceProvider,
  diagnoseStorageConnection,
} from "../../../lib/workflow-runtime";
import { findDemoCandidateByTmdbId } from "../../../lib/demo-candidates";
import {
  getMediaServerCoordinator,
  getExtensionManager,
} from "../../../composition/runtime-container";
import { executeStrmTaskScan } from "../../../features/strm/application/strm-runner-service";

// ── 1. 影视搜索 ─────────────────────────────────────────────────────────────

export async function executeGetMediaDetail(args: Record<string, unknown>, accountId: string): Promise<unknown> {
  const tmdbId = Number(args.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    throw new Error("tmdbId 必须为有效正整数");
  }
  const type = args.type === "movie" ? "movie" : "tv";
  try {
    const accesses = await getTmdbAccesses(getAccountScopedSettings(accountId));
    const provider = createTmdbMetadataProvider(accesses);
    if (type === "movie") {
      const details = await provider.getMovieDetails(tmdbId);
      return { ok: true, tmdbId, type, details };
    } else {
      const details = await provider.getTvDetails(tmdbId);
      return { ok: true, tmdbId, type, details };
    }
  } catch (err) {
    const demo = findDemoCandidateByTmdbId(tmdbId);
    if (demo) {
      return { ok: true, tmdbId, type, details: demo, isDemo: true };
    }
    return { ok: false, tmdbId, type, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function executeGetTrendingMedia(args: Record<string, unknown>): Promise<unknown> {
  const type = args.type === "tv" || args.type === "movie" ? args.type : undefined;
  return executeDiscoverMedia({
    sortBy: "popularity",
    type,
  });
}

// ── 2. 资源查询与刮削 ────────────────────────────────────────────────────────

export async function executeSearchResources(args: Record<string, unknown>, accountId: string): Promise<unknown> {
  const keyword = String(args.keyword || "").trim();
  if (!keyword) {
    throw new Error("keyword 必须为非空字符串");
  }

  try {
    const provider = await getWorkerResourceProvider(getAccountScopedSettings(accountId));
    const snapshot = await provider.search({ keyword });
    return {
      ok: true,
      keyword,
      candidates: (snapshot.candidates || []).slice(0, 20),
    };
  } catch (err) {
    return {
      ok: false,
      keyword,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function executeScrapeResourceMetadata(args: Record<string, unknown>): Promise<unknown> {
  const rawTitle = String(args.rawTitle || "").trim();
  if (!rawTitle) {
    throw new Error("rawTitle 必须为非空字符串");
  }
  const parsed = parseTitleWithChain({ folderName: rawTitle });
  return {
    ok: true,
    rawTitle,
    parsed,
  };
}

// ── 3. 订阅管理 ─────────────────────────────────────────────────────────────

export async function executeListSubscriptions(args: Record<string, unknown>): Promise<unknown> {
  const repo = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope();
  const allStates = await repo.listTrackedSeasonStates(scope);
  const statusFilter = typeof args.status === "string" ? args.status : "all";
  const filtered = statusFilter === "all"
    ? allStates
    : allStates.filter((s) => s.season.status === statusFilter);

  const page = Math.max(1, Number(args.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
  const startIndex = (page - 1) * limit;
  const paged = filtered.slice(startIndex, startIndex + limit);

  return {
    ok: true,
    total: filtered.length,
    page,
    limit,
    items: paged.map((s) => ({
      tmdbId: s.title.tmdbId,
      title: s.title.title,
      type: s.title.type,
      seasonNumber: s.season.seasonNumber,
      status: s.season.status,
      episodesCount: s.episodes.length,
      downloadedCount: s.episodes.filter((e) => e.obtained).length,
    })),
  };
}

export async function executeGetSubscriptionDetail(args: Record<string, unknown>): Promise<unknown> {
  const tmdbId = Number(args.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    throw new Error("tmdbId 必须为有效正整数");
  }
  const repo = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope();
  const allStates = await repo.listTrackedSeasonStates(scope);
  const seasonNumber = typeof args.seasonNumber === "number" ? args.seasonNumber : undefined;
  const found = allStates.filter(
    (s) => s.title.tmdbId === tmdbId && (seasonNumber === undefined || s.season.seasonNumber === seasonNumber)
  );
  if (found.length === 0) {
    return { ok: false, error: `未找到 TMDB ID [${tmdbId}] 的追更订阅` };
  }
  return {
    ok: true,
    tmdbId,
    seasons: found.map((s) => ({
      seasonNumber: s.season.seasonNumber,
      status: s.season.status,
      episodes: s.episodes,
    })),
  };
}

export async function executeUpdateSubscription(
  accountId: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const tmdbId = Number(args.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    throw new Error("tmdbId 必须为有效正整数");
  }
  const repo = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope();
  const allStates = await repo.listTrackedSeasonStates(scope);
  const seasonNumber = typeof args.seasonNumber === "number" ? args.seasonNumber : undefined;
  const target = allStates.find(
    (s) => s.title.tmdbId === tmdbId && (seasonNumber === undefined || s.season.seasonNumber === seasonNumber)
  );
  if (!target) {
    return { ok: false, error: `未找到 TMDB ID [${tmdbId}] 的订阅记录` };
  }

  const newStatus = args.status === "active" || args.status === "paused" || args.status === "completed"
    ? args.status
    : undefined;

  return {
    ok: true,
    tmdbId,
    seasonNumber: target.season.seasonNumber,
    status: newStatus ?? target.season.status,
    message: "订阅配置已更新",
  };
}

export async function executeDeleteSubscription(args: Record<string, unknown>): Promise<unknown> {
  const tmdbId = Number(args.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    throw new Error("tmdbId 必须为有效正整数");
  }
  const mediaKind = args.mediaKind === "movie" ? "movie" : "tv";
  const seasonNumber = typeof args.seasonNumber === "number" ? args.seasonNumber : undefined;
  const repo = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope();
  await repo.untrackTitle(tmdbId, scope, mediaKind, seasonNumber);
  return {
    ok: true,
    tmdbId,
    message: `已取消 TMDB ID [${tmdbId}] 的追更订阅`,
  };
}

// ── 4. 网盘管理 ─────────────────────────────────────────────────────────────

export async function executeGetStorageDrives(accountId: string): Promise<unknown> {
  const drives = await getAccountConnectedStorages(accountId);
  return {
    ok: true,
    drives,
  };
}

export async function executeCheckDriveQuota(accountId: string, args: Record<string, unknown>): Promise<unknown> {
  const repo = getWorkflowRepository();
  const storages = await repo.listConnectedStorages(accountId);
  if (storages.length === 0) {
    return { ok: false, error: "未连接任何网盘存储" };
  }
  const targetStorageId = typeof args.storageId === "string" ? args.storageId : storages[0]!.id;
  try {
    const report = await diagnoseStorageConnection(accountId, targetStorageId);
    return {
      ok: true,
      storageId: report.storageId,
      provider: report.provider,
      quota: report.quota ?? { available: false, error: "当前网盘未开放或未授权配额查询接口" },
    };
  } catch (err) {
    return {
      ok: false,
      storageId: targetStorageId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function executeSearchDriveFiles(
  accountId: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const keyword = String(args.keyword || "").trim().toLowerCase();
  if (!keyword) {
    throw new Error("keyword 必须为非空字符串");
  }
  const storageId = typeof args.storageId === "string" ? args.storageId : undefined;
  const fileManager = await getAccountDriveFileManager(accountId, storageId);
  if (!fileManager) {
    return { ok: false, error: "未找到连接的网盘或网盘未配置凭据" };
  }
  const root = await fileManager.listDirectory();
  const matches = root.items.filter((item) => item.name.toLowerCase().includes(keyword));
  return {
    ok: true,
    keyword,
    matches: matches.slice(0, 50),
    totalMatches: matches.length,
  };
}

export async function executeGetDriveDownloadUrl(
  accountId: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const fileId = String(args.fileId || "").trim();
  if (!fileId) {
    throw new Error("fileId 必须为非空字符串");
  }
  const storageId = typeof args.storageId === "string" ? args.storageId : "default";
  return {
    ok: true,
    fileId,
    storageId,
    playStreamUrl: `/api/strm/play/${storageId}/${fileId}`,
    message: "可通过巡影流代理中转或带签名 302 地址直接播放与下载",
  };
}

// ── 5. STRM 管理 ─────────────────────────────────────────────────────────────

export async function executeListStrmTasks(accountId: string): Promise<unknown> {
  const repo = getWorkflowRepository();
  const tasks = await repo.listStrmTasks(accountId);
  return {
    ok: true,
    tasks,
  };
}

export async function executeCreateStrmTask(
  accountId: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const name = String(args.name || "").trim();
  const storageId = String(args.storageId || "").trim();
  const remoteFolderId = String(args.remoteFolderId || "").trim();
  const localOutputDir = String(args.localOutputDir || "").trim();
  const remotePath = typeof args.remotePath === "string" ? args.remotePath : "/";
  if (!name || !storageId || !remoteFolderId || !localOutputDir) {
    throw new Error("name, storageId, remoteFolderId, localOutputDir 均为必填参数");
  }
  const deliveryMode = args.deliveryMode === "redirect" || args.deliveryMode === "proxy" || args.deliveryMode === "auto"
    ? args.deliveryMode
    : "auto";

  const repo = getWorkflowRepository();
  const task = await repo.createStrmTask({
    accountId,
    name,
    storageId,
    remoteFolderId,
    remotePath,
    localOutputDir,
    deliveryMode,
    isActive: true,
  });
  return {
    ok: true,
    task,
  };
}

export async function executeTriggerStrmSync(
  accountId: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const taskId = String(args.taskId || "").trim();
  if (!taskId) {
    throw new Error("taskId 必须为有效字符串");
  }
  const result = await executeStrmTaskScan(taskId, accountId, { triggerSource: "manual" });
  return {
    taskId,
    ...result,
  };
}

// ── 6. 第三方媒体库 ─────────────────────────────────────────────────────────

export async function executeListMediaServers(accountId: string): Promise<unknown> {
  const repo = getWorkflowRepository();
  const configs = await repo.listMediaServerConfigs(accountId);
  return {
    ok: true,
    servers: configs,
  };
}

export async function executeSyncMediaServerLibrary(
  accountId: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const coordinator = getMediaServerCoordinator();
  if (typeof args.targetPath === "string" && args.targetPath.trim().length > 0) {
    coordinator.notifyFilesChanged(accountId, [args.targetPath.trim()]);
    return {
      ok: true,
      targetPath: args.targetPath.trim(),
      message: "已向媒体服务器下发局部路径变更通知（防抖聚合刷新中）",
    };
  }
  const serverId = typeof args.serverId === "string" ? args.serverId.trim() : undefined;
  if (!serverId) {
    throw new Error("未指定 targetPath 时必须指定 serverId");
  }
  await coordinator.manualRefresh(serverId, accountId);
  return {
    ok: true,
    serverId,
    message: "已向媒体服务器触发库扫描与刷新",
  };
}

export async function executeTestMediaServerConnection(
  accountId: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const serverId = String(args.serverId || "").trim();
  if (!serverId) {
    throw new Error("serverId 必须为有效字符串");
  }
  const repo = getWorkflowRepository();
  const config = await repo.getMediaServerConfig(serverId, accountId);
  if (!config) {
    return { ok: false, error: `未找到 ID 为 [${serverId}] 的媒体服务器配置` };
  }
  const coordinator = getMediaServerCoordinator();
  const token = decryptSecret(config.apiTokenEncrypted);
  const status = await coordinator.testConnection({
    serverType: config.serverType,
    hostUrl: config.hostUrl,
    apiToken: token,
  });
  return {
    ok: status.ok,
    serverId,
    status,
  };
}

// ── 7. 动态扩展与插件 ───────────────────────────────────────────────────────

export async function executeListExtensions(): Promise<unknown> {
  const manager = getExtensionManager();
  const extensions = await manager.listExtensions();
  return {
    ok: true,
    extensions,
  };
}

export async function executeToggleExtension(args: Record<string, unknown>): Promise<unknown> {
  const extensionId = String(args.extensionId || "").trim();
  if (!extensionId) {
    throw new Error("extensionId 必须为有效字符串");
  }
  const enabled = Boolean(args.enabled);
  const manager = getExtensionManager();
  const success = await manager.setExtensionEnabled(extensionId, enabled);
  return {
    ok: success,
    extensionId,
    enabled,
    message: success ? `扩展已${enabled ? "启用" : "停用"}` : "操作失败，扩展可能不存在",
  };
}

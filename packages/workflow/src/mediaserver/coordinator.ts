import { nativePath as path } from "../domain/native-require.js";
import { decryptSecret, isCredentialCryptoInitialized } from "@media-track/shared";
import { DebounceQueue } from "../strm/debounce-queue.js";
import { EmbyAdapter } from "./emby-adapter.js";
import { PlexAdapter } from "./plex-adapter.js";
import type {
  CreateMediaServerConfigInput,
  MediaServerConfig,
  MediaServerConnectionStatus,
  MediaServerRefreshResult,
  MediaServerStore,
  MediaServerType,
  PathMapping,
  ResolvedMediaServerTarget,
  StrmTaskFileChangeContext,
} from "./mediaserver-types.js";

const BLOCKED_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "100.100.100.200",
  "fd00:ec2::254",
  "0.0.0.0",
]);

export function assertValidMediaServerUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`MEDIA_SERVER_URL_INVALID: 无效的服务器 URL [${rawUrl}]`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `MEDIA_SERVER_SSRF_BLOCKED: 仅允许 HTTP 或 HTTPS 协议 (当前协议: ${parsed.protocol})`,
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) {
    throw new Error("MEDIA_SERVER_URL_INVALID: URL 主机名不能为空");
  }

  if (
    BLOCKED_METADATA_HOSTS.has(hostname) ||
    hostname.startsWith("169.254.") ||
    hostname.endsWith(".metadata.google.internal")
  ) {
    throw new Error(
      `MEDIA_SERVER_SSRF_BLOCKED: 禁止访问保留的云元数据或链路本地地址 [${hostname}]`,
    );
  }

  if (parsed.port) {
    const portNum = Number(parsed.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error(`MEDIA_SERVER_URL_INVALID: 端口号超出合法范围 1-65535 [${parsed.port}]`);
    }
  }
}

export function normalizePathSeparators(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/**
 * 路径映射转换器
 * 根据配置将本地 STRM 物理路径转换成媒体服务器容器内部挂载路径。
 */
export function mapLocalToRemote(localPath: string, mappings: PathMapping[] = []): string {
  const normLocal = normalizePathSeparators(localPath);
  if (!mappings || mappings.length === 0) {
    return normLocal;
  }

  // 按 localPath 长度倒序，优先匹配最长前缀
  const sorted = [...mappings].sort(
    (a, b) => b.localPath.trim().length - a.localPath.trim().length,
  );

  for (const m of sorted) {
    const fromPrefix = normalizePathSeparators(m.localPath.trim()).replace(/\/$/, "");
    const toPrefix = normalizePathSeparators(m.remotePath.trim()).replace(/\/$/, "");

    if (!fromPrefix) continue;

    if (normLocal === fromPrefix || normLocal.startsWith(fromPrefix + "/")) {
      const remainder = normLocal.slice(fromPrefix.length);
      return (toPrefix + remainder).replace(/\/+/g, "/");
    }
  }

  return normLocal;
}

function matchExplicitPathMappings(
  normLocalDir: string,
  normSubPath: string,
  mappings: PathMapping[] = [],
): string | null {
  for (const m of mappings) {
    const fromPrefix = normalizePathSeparators(m.localPath.trim()).replace(/\/+$/, "");
    const toPrefix = normalizePathSeparators(m.remotePath.trim()).replace(/\/+$/, "");
    if (!fromPrefix) continue;
    if (normLocalDir === fromPrefix || normLocalDir.startsWith(fromPrefix + "/")) {
      const remainder = normLocalDir.slice(fromPrefix.length);
      const remoteBase = (toPrefix + remainder).replace(/\/+/g, "/");
      return path.posix.join(remoteBase, normSubPath);
    }
  }
  return null;
}

function matchLibraryByTask(
  libraries: import("./mediaserver-types.js").MediaLibrary[],
  task: { localOutputDir: string; name: string; mediaType?: "movie" | "show" | undefined },
  normLocalDir: string,
): import("./mediaserver-types.js").MediaLibrary | undefined {
  const normTaskName = task.name.toLowerCase();
  const taskDirBasename = path.posix.basename(normLocalDir).toLowerCase();
  const isMovie =
    task.mediaType === "movie" ||
    normTaskName.includes("电影") ||
    normTaskName.includes("movie") ||
    taskDirBasename.includes("movie");
  const isTv =
    task.mediaType === "show" ||
    normTaskName.includes("剧") ||
    normTaskName.includes("tv") ||
    normTaskName.includes("show") ||
    taskDirBasename.includes("tv");

  return (
    libraries.find((lib) => {
      if (isMovie && lib.type === "movie") return true;
      if (isTv && lib.type === "show") return true;
      const libLoc = (lib.locations[0] || "").toLowerCase();
      return libLoc.endsWith(taskDirBasename) || libLoc.includes(taskDirBasename);
    }) ?? libraries[0]
  );
}

/**
 * STRM 任务与媒体库路径自适应自动匹配推导器
 */
export function autoResolveMediaServerTarget(
  task: { localOutputDir: string; name: string; mediaType?: "movie" | "show" | undefined },
  subPath: string,
  config: MediaServerConfig,
): ResolvedMediaServerTarget {
  const normLocalDir = normalizePathSeparators(task.localOutputDir);
  const normSubPath = normalizePathSeparators(subPath).replace(/^\/+/, "");

  // 1. 优先使用用户显式配置的精确 pathMappings
  const explicitRemotePath = matchExplicitPathMappings(
    normLocalDir,
    normSubPath,
    config.pathMappings,
  );
  if (explicitRemotePath) {
    return { remotePath: explicitRemotePath };
  }

  // 2. 自动匹配模式：根据已发现媒体库 (detectedLibraries) 自适应推导
  const libraries = config.detectedLibraries || [];
  if (libraries.length > 0) {
    const matchedLib = matchLibraryByTask(libraries, task, normLocalDir);
    if (matchedLib && matchedLib.locations.length > 0) {
      const primaryLoc = normalizePathSeparators(matchedLib.locations[0]!).replace(/\/+$/, "");
      return {
        libraryId: matchedLib.id,
        remotePath: path.posix.join(primaryLoc, normSubPath),
      };
    }
  }

  // 3. 兜底策略：若完全无任何信息，拼接标准相对路径
  return { remotePath: normalizePathSeparators(path.posix.join(normLocalDir, normSubPath)) };
}

export type ChangedMediaItem =
  | { kind: "path"; path: string }
  | { kind: "context"; context: StrmTaskFileChangeContext };

export interface MediaServerCoordinatorOptions {
  store: MediaServerStore;
  debounceMs?: number | undefined;
  maxWaitMs?: number | undefined;
  decryptFn?: ((ciphertext: string) => string) | undefined;
  fetchFn?: typeof fetch | undefined;
}

function resolveContextTargets(
  ctx: StrmTaskFileChangeContext,
  config: MediaServerConfig,
): ResolvedMediaServerTarget[] {
  // 1. 若任务显式绑定了媒体服务器，且不是当前 config，坚决跳过，绝不骚扰其它服务器
  if (ctx.mediaServerId && ctx.mediaServerId !== config.id) {
    return [];
  }

  const subPaths = ctx.relativeSubPaths.length > 0
    ? ctx.relativeSubPaths
    : ctx.generatedPaths.map((p) => path.posix.basename(normalizePathSeparators(p)));

  // 2. 若任务显式绑定了目标具体媒体库 ID
  if (ctx.mediaLibraryId) {
    const matchedLib = (config.detectedLibraries || []).find((l) => l.id === ctx.mediaLibraryId);
    const baseLoc = matchedLib?.locations?.[0]
      ? normalizePathSeparators(matchedLib.locations[0]).replace(/\/+$/, "")
      : "";

    return subPaths.map((sub) => {
      const normSub = normalizePathSeparators(sub);
      const dir = path.posix.extname(normSub) ? path.posix.dirname(normSub) : normSub;
      return {
        libraryId: ctx.mediaLibraryId ?? undefined,
        remotePath: baseLoc ? path.posix.join(baseLoc, dir) : undefined,
      };
    });
  }

  // 3. 兜底回退：智能自适应路径推导
  return subPaths.map((sub) => {
    const normSub = normalizePathSeparators(sub);
    const dir = path.posix.extname(normSub) ? path.posix.dirname(normSub) : normSub;
    return autoResolveMediaServerTarget(
      {
        localOutputDir: ctx.localOutputDir,
        name: ctx.taskName,
        mediaType: ctx.mediaType,
      },
      dir,
      config,
    );
  });
}

export class MediaServerCoordinator {
  private readonly store: MediaServerStore;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly decryptFn: (ciphertext: string) => string;
  private readonly fetchFn?: typeof fetch | undefined;
  private readonly accountQueues = new Map<string, DebounceQueue<ChangedMediaItem>>();

  constructor(options: MediaServerCoordinatorOptions) {
    this.store = options.store;
    this.debounceMs = options.debounceMs ?? 3000;
    this.maxWaitMs = options.maxWaitMs ?? 15000;
    this.fetchFn = options.fetchFn;
    this.decryptFn =
      options.decryptFn ??
      ((val: string) => {
        try {
          if (isCredentialCryptoInitialized()) {
            return decryptSecret(val);
          }
        } catch {
          // ignore decryption failure for mock/raw strings
        }
        return val;
      });
  }

  private createAdapter(
    serverType: MediaServerType,
    hostUrl: string,
    token: string,
  ): PlexAdapter | EmbyAdapter {
    if (serverType === "plex") {
      return new PlexAdapter({
        hostUrl,
        token,
        ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
      });
    }
    return new EmbyAdapter({
      hostUrl,
      token,
      serverType,
      ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
    });
  }

  /**
   * 测试连通性
   */
  async testConnection(
    config:
      | CreateMediaServerConfigInput
      | { serverType: MediaServerType; hostUrl: string; apiToken: string },
  ): Promise<MediaServerConnectionStatus> {
    assertValidMediaServerUrl(config.hostUrl);
    const adapter = this.createAdapter(config.serverType, config.hostUrl, config.apiToken);
    return adapter.testConnection();
  }

  /**
   * 探测并列出未保存凭据或指定配置的媒体库列表 (Sections)
   */
  async probeLibraries(options: {
    serverType: MediaServerType;
    hostUrl: string;
    apiToken: string;
  }): Promise<import("./mediaserver-types.js").MediaLibrary[]> {
    assertValidMediaServerUrl(options.hostUrl);
    const adapter = this.createAdapter(options.serverType, options.hostUrl, options.apiToken);
    return adapter.listLibraries();
  }

  /**
   * 列出已保存配置的全部媒体库列表 (Sections)
   */
  async listLibraries(configId: string, accountId: string): Promise<import("./mediaserver-types.js").MediaLibrary[]> {
    const config = await this.store.getMediaServerConfig(configId, accountId);
    if (!config) {
      throw new Error("媒体服务器配置不存在");
    }
    const token = this.decryptFn(config.apiTokenEncrypted);
    const adapter = this.createAdapter(config.serverType, config.hostUrl, token);
    return adapter.listLibraries();
  }

  /**
   * 立即手动刷新媒体服务器，并持久化刷新执行记录
   */
  async manualRefresh(
    configId: string,
    accountId: string,
    targetPath?: string,
    triggerSource: "manual" | "strm_sync" | "pinpoint_ingest" | "debounced_queue" = "manual",
  ): Promise<MediaServerRefreshResult> {
    const config = await this.store.getMediaServerConfig(configId, accountId);
    if (!config) {
      return {
        ok: false,
        refreshedCount: 0,
        sectionsRefreshed: [],
        errorMessage: "媒体服务器配置不存在",
      };
    }

    const startTime = Date.now();
    let recordId: string | undefined;
    try {
      const record = await this.store.createMediaServerRefreshRecord({
        configId,
        serverName: config.name,
        serverType: config.serverType,
        accountId,
        triggerSource,
        targetPath: targetPath ?? null,
      });
      recordId = record.id;
    } catch {
      // non-blocking
    }

    try {
      const token = this.decryptFn(config.apiTokenEncrypted);
      const adapter = this.createAdapter(config.serverType, config.hostUrl, token);

      let remotePath: string | undefined = undefined;
      if (targetPath) {
        remotePath = mapLocalToRemote(targetPath, config.pathMappings);
      }

      const result = await adapter.refreshLibrary({
        ...(remotePath !== undefined ? { path: remotePath } : {}),
      });

      const durationMs = Date.now() - startTime;
      if (recordId) {
        await this.store
          .updateMediaServerRefreshRecord({
            id: recordId,
            status: result.ok ? "succeeded" : "failed",
            durationMs,
            sectionsRefreshed: result.sectionsRefreshed,
            errorMessage: result.errorMessage ?? null,
          })
          .catch(() => {});
      }

      if (result.ok) {
        await this.store.updateMediaServerConfig({
          id: config.id,
          accountId,
          lastSyncAt: new Date().toISOString(),
        });
      }
      return result;
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (recordId) {
        await this.store
          .updateMediaServerRefreshRecord({
            id: recordId,
            status: "failed",
            durationMs,
            errorMessage: errorMsg,
          })
          .catch(() => {});
      }
      return {
        ok: false,
        refreshedCount: 0,
        sectionsRefreshed: [],
        errorMessage: errorMsg,
      };
    }
  }

  /**
   * 变更事件通知（带防抖和最长等待锁机制）
   * 当 STRM 生成或入库完成时调用，自动合并多个文件的频繁刷新请求。
   */
  notifyFilesChanged(accountId: string, localPaths: string[]): void {
    if (localPaths.length === 0) return;
    const queue = this.getOrCreateQueue(accountId);
    for (const p of localPaths) {
      queue.push({ kind: "path", path: p });
    }
  }

  /**
   * STRM 任务精准文件变更通知
   */
  notifyTaskFilesChanged(context: StrmTaskFileChangeContext): void {
    if (context.generatedPaths.length === 0 && context.relativeSubPaths.length === 0) return;
    const queue = this.getOrCreateQueue(context.accountId);
    queue.push({ kind: "context", context });
  }

  private getOrCreateQueue(accountId: string): DebounceQueue<ChangedMediaItem> {
    let queue = this.accountQueues.get(accountId);
    if (!queue) {
      queue = new DebounceQueue<ChangedMediaItem>({
        debounceMs: this.debounceMs,
        maxWaitMs: this.maxWaitMs,
        keyFn: (item) => {
          if (item.kind === "path") return `path:${item.path}`;
          return `context:${item.context.taskId}:${item.context.relativeSubPaths.join(",")}`;
        },
        onFlush: async (items) => {
          await this.flushChangedItems(accountId, items);
        },
      });
      this.accountQueues.set(accountId, queue);
    }
    return queue;
  }

  private collectTargetsForConfig(
    config: MediaServerConfig,
    items: ChangedMediaItem[],
  ): ResolvedMediaServerTarget[] {
    const targets: ResolvedMediaServerTarget[] = [];
    for (const it of items) {
      if (it.kind === "path") {
        const norm = normalizePathSeparators(it.path);
        const dir = path.posix.extname(norm) ? path.posix.dirname(norm) : norm;
        targets.push({ remotePath: mapLocalToRemote(dir, config.pathMappings) });
      } else {
        targets.push(...resolveContextTargets(it.context, config));
      }
    }
    return targets;
  }

  private async executeRefreshForConfig(
    config: MediaServerConfig,
    items: ChangedMediaItem[],
    accountId: string,
  ): Promise<void> {
    const startTime = Date.now();
    let recordId: string | undefined;

    const targets = this.collectTargetsForConfig(config, items);
    if (targets.length === 0) return;

    // 去重 targets
    const uniqueMap = new Map<string, ResolvedMediaServerTarget>();
    for (const t of targets) {
      const key = `${t.libraryId || ""}:${t.remotePath || ""}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, t);
      }
    }
    const uniqueTargets = Array.from(uniqueMap.values());
    const displayPaths = uniqueTargets.map((t) => t.remotePath || t.libraryId || "section").join("; ");

    try {
      const record = await this.store.createMediaServerRefreshRecord({
        configId: config.id,
        serverName: config.name,
        serverType: config.serverType,
        accountId,
        triggerSource: "debounced_queue",
        targetPath: displayPaths,
      });
      recordId = record.id;
    } catch {
      // non-blocking
    }

    try {
      const token = this.decryptFn(config.apiTokenEncrypted);
      const adapter = this.createAdapter(config.serverType, config.hostUrl, token);
      const sectionsRefreshed: string[] = [];

      for (const t of uniqueTargets) {
        const res = await adapter.refreshLibrary({
          libraryId: t.libraryId,
          path: t.remotePath,
        });
        if (res.sectionsRefreshed) {
          sectionsRefreshed.push(...res.sectionsRefreshed);
        }
      }

      await this.store.updateMediaServerConfig({
        id: config.id,
        accountId,
        lastSyncAt: new Date().toISOString(),
      });

      if (recordId) {
        await this.store
          .updateMediaServerRefreshRecord({
            id: recordId,
            status: "succeeded",
            durationMs: Date.now() - startTime,
            sectionsRefreshed: Array.from(new Set(sectionsRefreshed)),
          })
          .catch(() => {});
      }
    } catch (err: unknown) {
      console.error(`[MediaServerCoordinator] Error refreshing config ${config.id}:`, err);
      if (recordId) {
        await this.store
          .updateMediaServerRefreshRecord({
            id: recordId,
            status: "failed",
            durationMs: Date.now() - startTime,
            errorMessage: err instanceof Error ? err.message : String(err),
          })
          .catch(() => {});
      }
    }
  }

  /**
   * 批量刷新执行核心，记录防抖队列刷新历史
   */
  private async flushChangedItems(accountId: string, items: ChangedMediaItem[]): Promise<void> {
    const configs = await this.store.listMediaServerConfigs(accountId);
    const activeConfigs = configs.filter((c) => c.isActive);
    if (activeConfigs.length === 0) return;

    for (const config of activeConfigs) {
      await this.executeRefreshForConfig(config, items, accountId);
    }
  }

  dispose(): void {
    for (const queue of this.accountQueues.values()) {
      queue.dispose();
    }
    this.accountQueues.clear();
  }
}

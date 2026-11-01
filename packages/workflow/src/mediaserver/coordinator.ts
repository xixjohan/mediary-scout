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
} from "./mediaserver-types.js";

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

export interface MediaServerCoordinatorOptions {
  store: MediaServerStore;
  debounceMs?: number | undefined;
  maxWaitMs?: number | undefined;
  decryptFn?: ((ciphertext: string) => string) | undefined;
  fetchFn?: typeof fetch | undefined;
}

export class MediaServerCoordinator {
  private readonly store: MediaServerStore;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly decryptFn: (ciphertext: string) => string;
  private readonly fetchFn?: typeof fetch | undefined;
  private readonly accountQueues = new Map<string, DebounceQueue<string>>();

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
    } catch (err: any) {
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

    let queue = this.accountQueues.get(accountId);
    if (!queue) {
      queue = new DebounceQueue<string>({
        debounceMs: this.debounceMs,
        maxWaitMs: this.maxWaitMs,
        onFlush: async (paths) => {
          await this.flushChangedPaths(accountId, paths);
        },
      });
      this.accountQueues.set(accountId, queue);
    }

    for (const p of localPaths) {
      queue.push(p);
    }
  }

  /**
   * 批量刷新执行核心，记录防抖队列刷新历史
   */
  private async flushChangedPaths(accountId: string, paths: string[]): Promise<void> {
    const configs = await this.store.listMediaServerConfigs(accountId);
    const activeConfigs = configs.filter((c) => c.isActive);
    if (activeConfigs.length === 0) return;

    // 目录去重：将同一目录下的多个文件合并为目录路径
    const uniqueDirs = Array.from(
      new Set(
        paths.map((p) => {
          const norm = normalizePathSeparators(p);
          return path.posix.extname(norm) ? path.posix.dirname(norm) : norm;
        }),
      ),
    );

    for (const config of activeConfigs) {
      const startTime = Date.now();
      let recordId: string | undefined;
      try {
        const record = await this.store.createMediaServerRefreshRecord({
          configId: config.id,
          serverName: config.name,
          serverType: config.serverType,
          accountId,
          triggerSource: "debounced_queue",
          targetPath: uniqueDirs.join("; "),
        });
        recordId = record.id;
      } catch {
        // non-blocking
      }

      try {
        const token = this.decryptFn(config.apiTokenEncrypted);
        const adapter = this.createAdapter(config.serverType, config.hostUrl, token);
        const sectionsRefreshed: string[] = [];

        for (const dir of uniqueDirs) {
          const remoteDir = mapLocalToRemote(dir, config.pathMappings);
          const res = await adapter.refreshLibrary({ path: remoteDir });
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
      } catch (err: any) {
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
  }

  dispose(): void {
    for (const queue of this.accountQueues.values()) {
      queue.dispose();
    }
    this.accountQueues.clear();
  }
}

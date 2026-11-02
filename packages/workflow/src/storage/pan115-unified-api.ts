/**
 * Pan115UnifiedStorageApi (115 双轨融合存储适配器)
 *
 * 采用适配器与策略派发设计模式 (Adapter & Strategy Pattern):
 * 对外实现标准的 Pan115StorageApi 接口，内部组合管辖 CookieSubdriver 与 OpenSubdriver:
 *   1. 分享转存 (receiveShare): 115 开放平台无此端点，严格路由至 Cookie 引擎;
 *   2. 媒体库大清单查询 (listItems): 优先路由至 Open 引擎 (单次 1000 项，无防封延迟)，失败自动降级至 Cookie;
 *   3. 目录与文件管理 (createFolder, move, delete, rename): 优先 Open 引擎 (官方合规低风控)，兜底 Cookie;
 *   4. 离线下载任务 (addOfflineTask, listOfflineTasks): 优先 Open 引擎，兜底 Cookie。
 */

import type {
  Pan115StorageApi,
  Pan115Item,
  Pan115DirectoryInfo,
  Pan115ActionResult,
  Pan115OfflineTask,
} from "./storage-115-executor.js";
import { Pan115OpenClient } from "./pan115-open-client.js";
import type { Pan115EngineMode } from "./account-credentials.js";

export interface Pan115UnifiedStorageApiOptions {
  cookieApi?: Pan115StorageApi | undefined;
  openApi?: Pan115OpenClient | undefined;
  mode?: Pan115EngineMode | undefined;
  onFallback?: ((operation: string, error: unknown) => void) | undefined;
}

export class Pan115UnifiedStorageApi implements Pan115StorageApi {
  private readonly cookieApi?: Pan115StorageApi | undefined;
  private readonly openApi?: Pan115OpenClient | undefined;
  private readonly mode: Pan115EngineMode;
  private readonly onFallback?: ((operation: string, error: unknown) => void) | undefined;

  constructor(options: Pan115UnifiedStorageApiOptions) {
    this.cookieApi = options.cookieApi;
    this.openApi = options.openApi;
    this.mode = options.mode ?? (options.openApi && options.cookieApi ? "dual_engine" : options.openApi ? "open_only" : "cookie_only");
    this.onFallback = options.onFallback;

    if (!this.cookieApi && !this.openApi) {
      throw new Error("[Pan115UnifiedStorageApi] At least one of cookieApi or openApi must be provided");
    }
  }

  /** 获取当前运行模式 */
  getEngineMode(): Pan115EngineMode {
    return this.mode;
  }

  /** 访问底层的 OpenClient 实例 (用于 STRM 直链解析等专用场景) */
  getOpenClient(): Pan115OpenClient | undefined {
    return this.openApi;
  }

  /** 访问底层的 CookieApi 实例 */
  getCookieApi(): Pan115StorageApi | undefined {
    return this.cookieApi;
  }

  // =========================================================================
  // 1. 分享转存: 强依赖 Cookie 引擎 (115 开放平台官方未开放接收他人分享的接口)
  // =========================================================================

  async receiveShare(input: {
    shareCode: string;
    receiveCode: string;
    directoryId: string;
  }): Promise<Pan115ActionResult> {
    if (!this.cookieApi) {
      throw new Error(
        "[115 驱动提示] 115 开放平台 (Open API) 暂未开放分享转存接口。若需自动订阅转存影视资源，请在存储设置中补充绑定 115 Web Cookie 开启双轨模式。",
      );
    }
    return this.cookieApi.receiveShare(input);
  }

  // =========================================================================
  // 2. 媒体库大清单查询: 优先 Open API (极速 1000 条，免 1200ms 防封延迟)，异常降级 Cookie
  // =========================================================================

  async listItems(input: { directoryId: string }): Promise<Pan115Item[]> {
    if (this.openApi) {
      try {
        return await this.openApi.listItems({ directoryId: input.directoryId, limit: 1000 });
      } catch (err) {
        if (this.cookieApi) {
          this.onFallback?.("listItems", err);
          return await this.cookieApi.listItems(input);
        }
        throw err;
      }
    }

    if (this.cookieApi) {
      return await this.cookieApi.listItems(input);
    }

    throw new Error("[Pan115UnifiedStorageApi] No available driver to listItems");
  }

  // =========================================================================
  // 3. 目录信息查询
  // =========================================================================

  async getDirectoryInfo(input: { directoryId: string }): Promise<Pan115DirectoryInfo | null> {
    if (this.cookieApi) {
      try {
        return await this.cookieApi.getDirectoryInfo(input);
      } catch (err) {
        this.onFallback?.("getDirectoryInfo", err);
      }
    }

    return {
      state: true,
      path: [{ cid: input.directoryId, name: "Folder" }],
    };
  }

  // =========================================================================
  // 4. 目录与文件写操作 (创建、移动、删除、重命名): 优先 Open API，兜底 Cookie
  // =========================================================================

  async createFolder(input: { name: string; parentId: string }): Promise<string> {
    if (this.openApi) {
      try {
        return await this.openApi.createFolder(input);
      } catch (err) {
        if (this.cookieApi) {
          this.onFallback?.("createFolder", err);
          return await this.cookieApi.createFolder(input);
        }
        throw err;
      }
    }

    if (this.cookieApi) {
      return await this.cookieApi.createFolder(input);
    }

    throw new Error("[Pan115UnifiedStorageApi] No available driver to createFolder");
  }

  async moveItems(input: {
    fileIds: string[];
    targetDirectoryId: string;
  }): Promise<Pan115ActionResult> {
    if (this.openApi) {
      try {
        return await this.openApi.moveItems(input);
      } catch (err) {
        if (this.cookieApi) {
          this.onFallback?.("moveItems", err);
          return await this.cookieApi.moveItems(input);
        }
        throw err;
      }
    }

    if (this.cookieApi) {
      return await this.cookieApi.moveItems(input);
    }

    throw new Error("[Pan115UnifiedStorageApi] No available driver to moveItems");
  }

  async deleteItems(input: { fileIds: string[] }): Promise<Pan115ActionResult> {
    if (this.openApi) {
      try {
        return await this.openApi.deleteItems(input);
      } catch (err) {
        if (this.cookieApi) {
          this.onFallback?.("deleteItems", err);
          return await this.cookieApi.deleteItems(input);
        }
        throw err;
      }
    }

    if (this.cookieApi) {
      return await this.cookieApi.deleteItems(input);
    }

    throw new Error("[Pan115UnifiedStorageApi] No available driver to deleteItems");
  }

  async renameFile(input: { fileId: string; newName: string }): Promise<Pan115ActionResult> {
    if (this.openApi) {
      try {
        return await this.openApi.renameFile(input);
      } catch (err) {
        if (this.cookieApi) {
          this.onFallback?.("renameFile", err);
          return await this.cookieApi.renameFile(input);
        }
        throw err;
      }
    }

    if (this.cookieApi) {
      return await this.cookieApi.renameFile(input);
    }

    throw new Error("[Pan115UnifiedStorageApi] No available driver to renameFile");
  }

  // =========================================================================
  // 5. 离线下载操作: 优先 Open API，兜底 Cookie
  // =========================================================================

  async addOfflineTask(input: { url: string; directoryId: string }): Promise<Pan115ActionResult> {
    if (this.openApi) {
      try {
        return await this.openApi.addOfflineTask(input);
      } catch (err) {
        if (this.cookieApi) {
          this.onFallback?.("addOfflineTask", err);
          return await this.cookieApi.addOfflineTask(input);
        }
        throw err;
      }
    }

    if (this.cookieApi) {
      return await this.cookieApi.addOfflineTask(input);
    }

    throw new Error("[Pan115UnifiedStorageApi] No available driver to addOfflineTask");
  }

  async removeOfflineTask(input: { infoHashes: string[] }): Promise<Pan115ActionResult> {
    if (this.cookieApi) {
      return await this.cookieApi.removeOfflineTask(input);
    }
    return { ok: true, message: "" };
  }

  async listOfflineTasks(input?: { page?: number }): Promise<Pan115OfflineTask[]> {
    if (this.openApi) {
      try {
        return await this.openApi.listOfflineTasks();
      } catch (err) {
        if (this.cookieApi) {
          this.onFallback?.("listOfflineTasks", err);
          return await this.cookieApi.listOfflineTasks(input);
        }
        throw err;
      }
    }

    if (this.cookieApi) {
      return await this.cookieApi.listOfflineTasks(input);
    }

    throw new Error("[Pan115UnifiedStorageApi] No available driver to listOfflineTasks");
  }
}

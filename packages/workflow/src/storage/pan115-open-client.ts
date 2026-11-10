/**
 * 115 开放平台 (115 Open API) REST 客户端与 Token 状态机
 *
 * 参考与借鉴:
 *   - LitePan-main (`drivers/115_Open/auth.go`, `transport.go`, `ops.go`)
 *   - AList (`drivers/115_open/driver.go`)
 *
 * 核心架构特性:
 *   1. Token 自动续期与生命周期轮转: POST https://passportapi.115.com/open/refreshToken
 *   2. SingleFlight + 可选 SQLite 租约: 合并进程内并发，并协调共享数据库的 Web/Worker 刷新
 *   3. 错误分类状态机 (classify115OpenError): 致命错误立即停止重试; 瞬态错误有限退避
 *   4. 超高清单拉取: 相比 Web Cookie 的 1200ms 防风控延时, 开放平台单次支持 1000 条极速返回
 */

import { SingleFlight } from "../strm/single-flight.js";
import type { Pan115OpenOAuthCredentials } from "./account-credentials.js";
import type {
  Pan115Item,
  Pan115ActionResult,
  Pan115OfflineTask,
} from "./storage-115-executor.js";

/** 115 开放平台鉴权与业务异常 */
export class Pan115OpenAuthError extends Error {
  readonly code: number;
  readonly isFatal: boolean;

  constructor(code: number, message: string, isFatal = true) {
    super(`[115 Open API Error] code=${code}: ${message}`);
    this.name = "Pan115OpenAuthError";
    this.code = code;
    this.isFatal = isFatal;
  }
}

/**
 * 借鉴 LitePan classifyRefreshError: 细粒度划分 115 开放平台错误码
 */
export function classify115OpenError(code: number, msg?: string): { isFatal: boolean; retryable: boolean } {
  void msg;
  // 致命失效: Token 不存在、已过期、用户登出或权限封禁撤销 -> 需重新授权
  if (
    code === 401 ||
    code === 40140115 || // token不存在
    code === 40140116 || // refresh_token已过期
    code === 40140119 || // 用户已被踢出登录
    code === 40140120 || // 授权已被撤销或封禁
    code === 40140137    // refresh_token 无效；必须重新授权
  ) {
    return { isFatal: true, retryable: false };
  }

  // 瞬态错误: 服务繁忙、限流并发、网关 502/504 -> 指数退避重试
  if (
    code === 429 ||
    code === 502 ||
    code === 503 ||
    code === 504 ||
    code === 40140117 || // 系统繁忙
    code === 40140121    // 刷新过于频繁短时被限流
  ) {
    return { isFatal: false, retryable: true };
  }

  // 其余业务错误
  return { isFatal: false, retryable: false };
}

export interface Pan115OpenClientOptions {
  credentials: Pan115OpenOAuthCredentials;
  fetchImpl?: typeof fetch | undefined;
  onCredentialsPersist?: ((creds: Pan115OpenOAuthCredentials) => Promise<void> | void) | undefined;
  coordinateTokenRefresh?: Pan115TokenRefreshCoordinator | undefined;
  authBaseUrl?: string | undefined;
  apiBaseUrl?: string | undefined;
}

export type Pan115TokenRefreshCoordinator = (
  refresh: (credentials: Pan115OpenOAuthCredentials) => Promise<Pan115OpenOAuthCredentials>,
) => Promise<Pan115OpenOAuthCredentials>;

type RefreshedPan115Token = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

// Separate application paths can construct distinct clients for the same
// rotating credential. Share in-flight redemptions across those instances.
const tokenRefreshFlights = new SingleFlight<RefreshedPan115Token>();
const MAX_CACHED_TOKEN_ROTATIONS = 512;
const rotatedTokenCache = new Map<string, RefreshedPan115Token>();

function rememberTokenRotation(key: string, credentials: RefreshedPan115Token): void {
  rotatedTokenCache.delete(key);
  rotatedTokenCache.set(key, { ...credentials });
  while (rotatedTokenCache.size > MAX_CACHED_TOKEN_ROTATIONS) {
    const oldestKey = rotatedTokenCache.keys().next().value;
    if (oldestKey === undefined) break;
    rotatedTokenCache.delete(oldestKey);
  }
}

function cachedTokenRotation(key: string): RefreshedPan115Token | undefined {
  const credentials = rotatedTokenCache.get(key);
  if (!credentials) return undefined;
  // Refreshing the insertion order makes this a small LRU cache for stale
  // client instances that still hold a recently rotated token.
  rotatedTokenCache.delete(key);
  rotatedTokenCache.set(key, credentials);
  return { ...credentials };
}

export interface Pan115OpenDownloadUrlResult {
  url: string;
  userAgent?: string | undefined;
  fileSize?: number | undefined;
  fileName?: string | undefined;
}

/** 115 开放平台官方 REST 端点字典 (严格对标 115 开放平台 OpenAPI 规范) */
export const PAN115_OPEN_ENDPOINTS = {
  // 认证与令牌
  REFRESH_TOKEN: "/open/refreshToken",

  // 文件系统与目录管理
  FILES_LIST: "/open/ufile/files",
  FOLDER_ADD: "/open/folder/add",
  FOLDER_GET_INFO: "/open/folder/get_info",
  FILE_MOVE: "/open/ufile/move",
  FILE_UPDATE: "/open/ufile/update",
  FILE_DELETE: "/open/ufile/delete",
  FILE_DOWN_URL: "/open/ufile/downurl",

  // 离线任务管理
  OFFLINE_ADD_URLS: "/open/offline/add_task_urls",
  OFFLINE_GET_TASK_LIST: "/open/offline/get_task_list",
  OFFLINE_DEL_TASK: "/open/offline/del_task",
} as const;

/** 断言 115 开放平台 Token 刷新响应正常 */
function assertTokenRefreshResponseOk(data: any): void {
  const code = Number(data?.code ?? 0);
  const state = Boolean(data?.state ?? (code === 0));

  if (!state || code !== 0) {
    const errMsg = String(data?.message || data?.msg || "Unknown refreshToken error");
    const classification = classify115OpenError(code, errMsg);
    throw new Pan115OpenAuthError(code, errMsg, classification.isFatal);
  }
}

/** 解析 115 开放平台 Token 响应载荷 */
function extractTokenPayload(
  data: any,
  fallbackRefreshToken: string,
): { accessToken: string; refreshToken: string; expiresInSeconds: number } {
  assertTokenRefreshResponseOk(data);

  const tokenData = data?.data || {};
  const accessToken = String(tokenData.access_token || "").trim();
  const nextRefreshToken = String(tokenData.refresh_token || fallbackRefreshToken).trim();
  const expiresInSeconds = Number(tokenData.expires_in || 7200);

  if (!accessToken) {
    throw new Pan115OpenAuthError(400, "Missing access_token in response data", true);
  }

  return { accessToken, refreshToken: nextRefreshToken, expiresInSeconds };
}

/** 单次执行 Token 换票网络请求，解析返回的 Token 实体 */
async function performSingleTokenRefresh(
  authBaseUrl: string,
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<{ accessToken: string; refreshToken: string; expiresInSeconds: number }> {
  const url = `${authBaseUrl}/open/refreshToken`;
  const bodyParams = new URLSearchParams();
  bodyParams.set("refresh_token", refreshToken.trim());

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "MediaryScout/1.0 (OpenAPI)",
    },
    body: bodyParams.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const classification = classify115OpenError(res.status);
    throw new Pan115OpenAuthError(res.status, `HTTP ${res.status} ${res.statusText}`, classification.isFatal);
  }

  const data = (await res.json()) as any;
  return extractTokenPayload(data, refreshToken);
}

function isItemDirectory(item: Record<string, unknown>): boolean {
  if (item["is_dir"] === 1 || item["is_dir"] === "1" || Boolean(item["isDirectory"])) return true;
  const hasFileId = Boolean(item["file_id"] ?? item["fid"]);
  if (hasFileId) return false;
  const fc = String(item["fc"] ?? item["file_category"] ?? "");
  if (fc === "0") return true;
  if (fc === "1") return false;
  return item["cid"] !== undefined || item["category_id"] !== undefined;
}

function getItemName(item: Record<string, unknown>): string {
  const val = item["file_name"] ?? item["fn"] ?? item["name"] ?? item["n"];
  return typeof val === "string" ? val : "";
}

function getItemSize(item: Record<string, unknown>): number {
  const val = item["file_size"] ?? item["size"] ?? item["s"];
  return typeof val === "number" ? val : Number(val) || 0;
}

/** 将 115 开放平台原始 item 格式化为内部 Pan115Item */
function formatPan115Item(item: Record<string, unknown>): Pan115Item {
  const name = getItemName(item);
  const size = getItemSize(item);
  const isDirectory = isItemDirectory(item);
  const baseItem: Pan115Item = { name, n: name, size, s: size, isDirectory };
  const fid = item["file_id"] ?? item["fid"] ?? item["id"];
  const cidVal = item["category_id"] ?? item["cid"];
  const idVal = isDirectory ? (cidVal ?? fid) : (fid ?? cidVal);
  if (idVal !== undefined && idVal !== null) {
    if (isDirectory) baseItem.cid = String(idVal);
    else if (fid !== undefined && fid !== null) baseItem.fid = String(idVal);
    else baseItem.cid = String(idVal);
    baseItem.id = String(idVal);
  }
  return baseItem;
}

export class Pan115OpenClient {
  private credentials: Pan115OpenOAuthCredentials;
  private pendingCredentialsPersist: Pan115OpenOAuthCredentials | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly onCredentialsPersist?: ((creds: Pan115OpenOAuthCredentials) => Promise<void> | void) | undefined;
  private readonly coordinateTokenRefresh?: Pan115TokenRefreshCoordinator | undefined;
  private readonly authBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly singleFlight = new SingleFlight<string>();

  constructor(options: Pan115OpenClientOptions) {
    this.credentials = { ...options.credentials };
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onCredentialsPersist = options.onCredentialsPersist;
    this.coordinateTokenRefresh = options.coordinateTokenRefresh;
    this.authBaseUrl = (options.authBaseUrl ?? "https://passportapi.115.com").replace(/\/$/, "");
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://proapi.115.com").replace(/\/$/, "");
  }

  /** 获取当前活跃的凭据只读镜像 */
  getCredentials(): Readonly<Pan115OpenOAuthCredentials> {
    return { ...this.credentials };
  }

  /** Whether a remote rotation still needs a durable credential write. */
  get hasPendingCredentialPersistence(): boolean {
    return this.pendingCredentialsPersist !== null;
  }

  /**
   * 确保 Access Token 处于有效状态。
   * 当 Token 已经过期或距离过期少于 5 分钟 (300 秒) 时，利用 SingleFlight 请求合并自动换票。
   */
  async ensureValidToken(): Promise<string> {
    const bufferMs = 5 * 60 * 1000;
    const hasValidAccessToken = (credentials = this.credentials) =>
      Boolean(credentials.accessToken) && credentials.expiresAt > Date.now() + bufferMs;

    if (hasValidAccessToken() && !this.pendingCredentialsPersist) {
      return this.credentials.accessToken;
    }

    return this.singleFlight.do("token_refresh", async () => {
      try {
        await this.persistPendingCredentials();
      } catch (error) {
        if (!this.coordinateTokenRefresh) throw error;
        const persistedCredentials = await this.coordinateTokenRefresh(async (credentials) => credentials);
        this.credentials = { ...persistedCredentials };
        this.pendingCredentialsPersist = null;
      }
      if (hasValidAccessToken()) {
        return this.credentials.accessToken;
      }

      const refreshIfNeeded = async (credentials: Pan115OpenOAuthCredentials) => {
        this.credentials = { ...credentials };
        if (hasValidAccessToken()) return { ...this.credentials };
        return this.refreshCredentialsFromCurrentToken();
      };
      const nextCredentials = this.coordinateTokenRefresh
        ? await this.coordinateTokenRefresh(refreshIfNeeded)
        : await refreshIfNeeded(this.credentials);
      this.credentials = { ...nextCredentials };
      if (!hasValidAccessToken()) {
        throw new Pan115OpenAuthError(504, "Unable to catch up with the current refresh-token rotation", false);
      }

      return this.credentials.accessToken;
    });
  }

  private async refreshCredentialsFromCurrentToken(): Promise<Pan115OpenOAuthCredentials> {
    let catchUpCount = 0;
    do {
      const refreshToken = this.credentials.refreshToken;
      const refreshKey = `${this.authBaseUrl}:${refreshToken}`;
      const refreshed = cachedTokenRotation(refreshKey) ?? await tokenRefreshFlights.do(
        refreshKey,
        async () => {
          const result = await this.executeTokenRefreshWithRetry(refreshToken);
          rememberTokenRotation(refreshKey, result);
          return result;
        },
      );
      this.credentials = {
        ...this.credentials,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      };
      await this.persistCurrentCredentials();
      catchUpCount++;
    } while (!this.hasValidAccessToken(this.credentials) && catchUpCount < 4);

    if (!this.hasValidAccessToken(this.credentials)) {
      throw new Pan115OpenAuthError(504, "Unable to catch up with the current refresh-token rotation", false);
    }
    return { ...this.credentials };
  }

  private hasValidAccessToken(credentials: Pan115OpenOAuthCredentials): boolean {
    return Boolean(credentials.accessToken) && credentials.expiresAt > Date.now() + 5 * 60 * 1000;
  }

  private async persistCurrentCredentials(): Promise<void> {
    if (!this.onCredentialsPersist) return;
    this.pendingCredentialsPersist = { ...this.credentials };
    try {
      await this.onCredentialsPersist({ ...this.pendingCredentialsPersist });
      this.pendingCredentialsPersist = null;
    } catch (err) {
      // CRITICAL: the provider has rotated the token, so the new value must be
      // persisted before a successful request can return to its caller.
      console.error(
        "[Pan115OpenClient] CRITICAL: Failed to persist refreshed OAuth credentials.",
        err,
      );
      throw err;
    }
  }

  private async persistPendingCredentials(): Promise<void> {
    const credentials = this.pendingCredentialsPersist;
    if (!credentials || !this.onCredentialsPersist) return;

    try {
      await this.onCredentialsPersist({ ...credentials });
      if (this.pendingCredentialsPersist === credentials) {
        this.pendingCredentialsPersist = null;
      }
    } catch (err) {
      console.error(
        "[Pan115OpenClient] CRITICAL: Failed to persist rotated OAuth credentials; " +
          "the refreshed token will not be used until persistence succeeds.",
        err,
      );
      throw err;
    }
  }

  /**
   * 执行 Token 刷新，附带针对瞬态错误的退避重试 (最多 3 次)
   */
  private async executeTokenRefreshWithRetry(
    refreshToken: string = this.credentials.refreshToken,
    maxRetries = 3,
  ): Promise<RefreshedPan115Token> {
    let attempt = 0;
    while (attempt < maxRetries) {
      attempt++;
      try {
        const result = await performSingleTokenRefresh(
          this.authBaseUrl,
          refreshToken,
          this.fetchImpl,
        );
        return {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: Date.now() + result.expiresInSeconds * 1000,
        };
      } catch (err) {
        const classification = err instanceof Pan115OpenAuthError
          ? classify115OpenError(err.code)
          : { isFatal: false, retryable: true };
        if (classification.isFatal || !classification.retryable || attempt >= maxRetries) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 500));
      }
    }

    throw new Pan115OpenAuthError(504, "Max retries exceeded while refreshing token", false);
  }

  /**
   * 发起开放平台签名请求，自动注入 Bearer Token 并在首遇 401 时自愈重试
   */
  async request<T = any>(
    path: string,
    init: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: URLSearchParams | string;
    } = {},
  ): Promise<T> {
    const makeCall = async (token: string): Promise<Response> => {
      const url = `${this.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
      const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "MediaryScout/1.0 (OpenAPI)",
        ...init.headers,
      };

      const reqInit: RequestInit = {
        method: init.method ?? (init.body ? "POST" : "GET"),
        headers,
      };
      if (init.body !== undefined) {
        reqInit.body = init.body.toString();
      }

      return this.fetchImpl(url, reqInit);
    };

    let token = await this.ensureValidToken();
    let res = await makeCall(token);

    if (res.status === 401) {
      this.credentials.expiresAt = 0;
      token = await this.ensureValidToken();
      res = await makeCall(token);
    }

    if (!res.ok) {
      const classification = classify115OpenError(res.status);
      throw new Pan115OpenAuthError(res.status, `HTTP ${res.status} on ${path}`, classification.isFatal);
    }

    const json = (await res.json()) as any;
    const code = Number(json?.code ?? 0);
    const state = Boolean(json?.state ?? (code === 0));

    if (!state && code !== 0) {
      const msg = String(json?.message || json?.msg || "115 Open API error");
      const classification = classify115OpenError(code, msg);
      throw new Pan115OpenAuthError(code, `${msg} (endpoint: ${path})`, classification.isFatal);
    }

    return json as T;
  }

  // =========================================================================
  // 核心开放平台业务接口
  // =========================================================================

  /**
   * 极速大清单查询: 获取指定目录下的文件和子目录 (单次支持拉取 1000 条，无需延时防封)
   */
  async listItems(input: {
    directoryId: string;
    limit?: number | undefined;
    offset?: number | undefined;
  }): Promise<Pan115Item[]> {
    const cid = String(input.directoryId || "0");
    const limit = Math.min(Math.max(input.limit ?? 1000, 1), 1000);
    const offset = input.offset ?? 0;

    const query = new URLSearchParams({
      cid,
      limit: String(limit),
      offset: String(offset),
      show_dir: "1",
    });

    const res = await this.request<{
      data?: Array<Record<string, unknown>>;
      count?: number;
    }>(`${PAN115_OPEN_ENDPOINTS.FILES_LIST}?${query.toString()}`);

    const rawList = Array.isArray(res.data) ? res.data : [];
    return rawList.map(formatPan115Item);
  }

  /**
   * 获取播放/下载直链: 调用 /open/ufile/downurl
   * 携带 pick_code 与目标 User-Agent (满足 115 开放平台防盗链要求)
   */
  async getDownloadUrl(input: {
    pickCode: string;
    userAgent?: string | undefined;
  }): Promise<Pan115OpenDownloadUrlResult> {
    const body = new URLSearchParams();
    body.set("pick_code", input.pickCode.trim());

    const ua = input.userAgent || "MediaryScout/1.0 (Infuse Compatible)";
    const res = await this.request<{
      data?: {
        url?: { url?: string } | string;
        file_name?: string;
        file_size?: number;
      };
    }>(PAN115_OPEN_ENDPOINTS.FILE_DOWN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": ua,
      },
      body,
    });

    let directUrl = "";
    if (typeof res.data?.url === "string") {
      directUrl = res.data.url;
    } else if (res.data?.url && typeof res.data.url.url === "string") {
      directUrl = res.data.url.url;
    }

    if (!directUrl) {
      throw new Error(`Failed to extract download URL for pick_code ${input.pickCode}`);
    }

    const result: Pan115OpenDownloadUrlResult = {
      url: directUrl,
      userAgent: ua,
    };
    if (res.data?.file_size !== undefined) {
      result.fileSize = res.data.file_size;
    }
    if (res.data?.file_name !== undefined) {
      result.fileName = res.data.file_name;
    }

    return result;
  }

  /**
   * 创建目录: 调用 /open/folder/add
   * 官方入参规范: pid (父目录ID), file_name (文件夹名称)
   */
  async createFolder(input: { name: string; parentId: string }): Promise<string> {
    const body = new URLSearchParams();
    body.set("file_name", input.name.trim());
    body.set("pid", String(input.parentId || "0"));
    // 冗余注入 cname 保持最强向后兼容
    body.set("cname", input.name.trim());

    const res = await this.request<{
      data?: { category_id?: string | number; file_id?: string | number; id?: string | number };
    }>(PAN115_OPEN_ENDPOINTS.FOLDER_ADD, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const createdId =
      res.data?.file_id ?? res.data?.category_id ?? res.data?.id;
    if (!createdId) {
      throw new Error(`Create folder succeeded but no directory ID returned for "${input.name}"`);
    }
    return String(createdId);
  }

  /**
   * 移动文件或目录: 调用 /open/ufile/move
   */
  async moveItems(input: {
    fileIds: string[];
    targetDirectoryId: string;
  }): Promise<Pan115ActionResult> {
    if (input.fileIds.length === 0) {
      return { ok: true, message: "" };
    }

    const body = new URLSearchParams();
    body.set("file_ids", input.fileIds.join(","));
    body.set("to_cid", String(input.targetDirectoryId || "0"));

    await this.request(PAN115_OPEN_ENDPOINTS.FILE_MOVE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    return { ok: true, message: "" };
  }

  /**
   * 删除文件或目录: 调用 /open/ufile/delete
   */
  async deleteItems(input: { fileIds: string[] }): Promise<Pan115ActionResult> {
    if (input.fileIds.length === 0) {
      return { ok: true, message: "" };
    }

    const body = new URLSearchParams();
    body.set("file_ids", input.fileIds.join(","));

    await this.request(PAN115_OPEN_ENDPOINTS.FILE_DELETE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    return { ok: true, message: "" };
  }

  /**
   * 重命名文件/目录: 调用 /open/ufile/update
   */
  async renameFile(input: { fileId: string; newName: string }): Promise<Pan115ActionResult> {
    const body = new URLSearchParams();
    body.set("file_id", input.fileId);
    body.set("file_name", input.newName.trim());

    await this.request(PAN115_OPEN_ENDPOINTS.FILE_UPDATE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    return { ok: true, message: "" };
  }

  /**
   * 提交磁力/HTTP 离线下载任务: 调用 /open/offline/add_task_urls
   * 官方入参规范: urls (链接字符串，多条以 \n 分隔), wp_path_id (目标保存目录ID)
   */
  async addOfflineTask(input: { url: string; directoryId: string }): Promise<Pan115ActionResult> {
    const body = new URLSearchParams();
    body.set("urls", input.url.trim());
    body.set("wp_path_id", String(input.directoryId || "0"));
    // 冗余字段兼容
    body.set("url", input.url.trim());
    body.set("savepath", String(input.directoryId || "0"));

    const res = await this.request<any>(PAN115_OPEN_ENDPOINTS.OFFLINE_ADD_URLS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    return {
      ok: true,
      message: String(res?.message || res?.msg || ""),
    };
  }

  /**
   * 删除/取消离线任务: 调用 /open/offline/del_task
   */
  async removeOfflineTask(input: { infoHashes: string[] }): Promise<Pan115ActionResult> {
    for (const hash of input.infoHashes) {
      if (!hash) continue;
      const body = new URLSearchParams();
      body.set("info_hash", hash);
      body.set("del_source_file", "0");
      await this.request(PAN115_OPEN_ENDPOINTS.OFFLINE_DEL_TASK, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    }
    return { ok: true, message: "" };
  }

  /**
   * 查询当前离线任务列表: 调用 /open/offline/get_task_list
   */
  async listOfflineTasks(input?: { page?: number }): Promise<Pan115OfflineTask[]> {
    const page = input?.page ?? 1;
    const res = await this.request<{
      data?: {
        tasks?: Array<Record<string, unknown>>;
        count?: number;
        page?: number;
      } | Array<Record<string, unknown>>;
    }>(`${PAN115_OPEN_ENDPOINTS.OFFLINE_GET_TASK_LIST}?page=${page}`);

    const tasksRaw = Array.isArray(res.data)
      ? res.data
      : Array.isArray(res.data?.tasks)
      ? res.data.tasks
      : [];

    return tasksRaw.map((t) => {
      const status = Number(t["status"] ?? 0);
      // 115 开放平台官方状态码规范:
      // -1: failed, 0: waiting/allocating, 1: downloading, 2: success/done
      const statusText =
        status === 2 ? "done" : status === 1 ? "downloading" : status === -1 ? "failed" : "waiting";

      return {
        infoHash: String(t["info_hash"] || ""),
        name: String(t["name"] || ""),
        percentDone: Number(t["percentDone"] ?? (status === 2 ? 100 : 0)),
        status,
        statusText,
        url: String(t["url"] || ""),
      };
    });
  }
}

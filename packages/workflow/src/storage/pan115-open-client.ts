/**
 * 115 开放平台 (115 Open API) REST 客户端与 Token 状态机
 *
 * 参考与借鉴:
 *   - LitePan-main (`drivers/115_Open/auth.go`, `transport.go`, `ops.go`)
 *   - AList (`drivers/115_open/driver.go`)
 *
 * 核心架构特性:
 *   1. Token 自动续期与生命周期轮转: POST https://passportapi.115.com/open/refreshToken
 *   2. SingleFlight 请求合并: 杜绝并发媒体库扫描与播放直链请求时的惊群刷新风暴 (Thundering Herd)
 *   3. 错误分类状态机 (classify115OpenError): 致命错误 (40140115/16/19/20) 立即冻结告警; 瞬态错误退避重试
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
    code === 40140120    // 授权已被撤销或封禁
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
  authBaseUrl?: string | undefined;
  apiBaseUrl?: string | undefined;
}

export interface Pan115OpenDownloadUrlResult {
  url: string;
  userAgent?: string | undefined;
  fileSize?: number | undefined;
  fileName?: string | undefined;
}

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
  });

  if (!res.ok) {
    const classification = classify115OpenError(res.status);
    throw new Pan115OpenAuthError(res.status, `HTTP ${res.status} ${res.statusText}`, classification.isFatal);
  }

  const data = (await res.json()) as any;
  return extractTokenPayload(data, refreshToken);
}

function isItemDirectory(item: Record<string, unknown>): boolean {
  if (item["is_dir"] === 1 || Boolean(item["isDirectory"])) return true;
  return item["file_category"] === 0 || item["fc"] === 0;
}

function getItemName(item: Record<string, unknown>): string {
  const val = item["file_name"] ?? item["name"] ?? item["n"];
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

  const baseItem: Pan115Item = {
    name,
    n: name,
    size,
    s: size,
    isDirectory,
  };

  const fid = item["file_id"] ?? item["fid"] ?? item["id"];
  const cidVal = item["category_id"] ?? item["cid"];

  if (fid !== undefined && fid !== null) {
    baseItem.fid = String(fid);
    baseItem.id = String(fid);
  } else if (cidVal !== undefined && cidVal !== null) {
    baseItem.cid = String(cidVal);
    baseItem.id = String(cidVal);
  }

  return baseItem;
}

export class Pan115OpenClient {
  private credentials: Pan115OpenOAuthCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly onCredentialsPersist?: ((creds: Pan115OpenOAuthCredentials) => Promise<void> | void) | undefined;
  private readonly authBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly singleFlight = new SingleFlight<string>();

  constructor(options: Pan115OpenClientOptions) {
    this.credentials = { ...options.credentials };
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onCredentialsPersist = options.onCredentialsPersist;
    this.authBaseUrl = (options.authBaseUrl ?? "https://passportapi.115.com").replace(/\/$/, "");
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://proapi.115.com").replace(/\/$/, "");
  }

  /** 获取当前活跃的凭据只读镜像 */
  getCredentials(): Readonly<Pan115OpenOAuthCredentials> {
    return { ...this.credentials };
  }

  /**
   * 确保 Access Token 处于有效状态。
   * 当 Token 已经过期或距离过期少于 5 分钟 (300 秒) 时，利用 SingleFlight 请求合并自动换票。
   */
  async ensureValidToken(): Promise<string> {
    const now = Date.now();
    const bufferMs = 5 * 60 * 1000;

    if (
      this.credentials.accessToken &&
      this.credentials.expiresAt > now + bufferMs
    ) {
      return this.credentials.accessToken;
    }

    return this.singleFlight.do("token_refresh", async () => {
      if (
        this.credentials.accessToken &&
        this.credentials.expiresAt > Date.now() + bufferMs
      ) {
        return this.credentials.accessToken;
      }

      const refreshed = await this.executeTokenRefreshWithRetry();
      this.credentials.accessToken = refreshed.accessToken;
      if (refreshed.refreshToken) {
        this.credentials.refreshToken = refreshed.refreshToken;
      }
      this.credentials.expiresAt = refreshed.expiresAt;

      if (this.onCredentialsPersist) {
        try {
          await this.onCredentialsPersist({ ...this.credentials });
        } catch (err) {
          console.error("[Pan115OpenClient] Failed to persist refreshed token:", err);
        }
      }

      return this.credentials.accessToken;
    });
  }

  /**
   * 执行 Token 刷新，附带针对瞬态错误的退避重试 (最多 3 次)
   */
  private async executeTokenRefreshWithRetry(maxRetries = 3): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }> {
    let attempt = 0;
    while (attempt < maxRetries) {
      attempt++;
      try {
        const result = await performSingleTokenRefresh(
          this.authBaseUrl,
          this.credentials.refreshToken,
          this.fetchImpl,
        );
        return {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: Date.now() + result.expiresInSeconds * 1000,
        };
      } catch (err) {
        const isFatal = err instanceof Pan115OpenAuthError && err.isFatal;
        if (isFatal || attempt >= maxRetries) {
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
    }>(`/open/ufile/files?${query.toString()}`);

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
    }>("/open/ufile/downurl", {
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
   * 创建目录: 调用 /open/ufile/dir_add
   */
  async createFolder(input: { name: string; parentId: string }): Promise<string> {
    const body = new URLSearchParams();
    body.set("cname", input.name.trim());
    body.set("pid", String(input.parentId || "0"));

    const res = await this.request<{
      data?: { category_id?: string | number; file_id?: string | number; id?: string | number };
    }>("/open/ufile/dir_add", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const createdId =
      res.data?.category_id ?? res.data?.file_id ?? res.data?.id;
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

    await this.request("/open/ufile/move", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    return { ok: true, message: "" };
  }

  /**
   * 删除文件或目录: 调用 /open/ufile/del
   */
  async deleteItems(input: { fileIds: string[] }): Promise<Pan115ActionResult> {
    if (input.fileIds.length === 0) {
      return { ok: true, message: "" };
    }

    const body = new URLSearchParams();
    body.set("file_ids", input.fileIds.join(","));

    await this.request("/open/ufile/del", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    return { ok: true, message: "" };
  }

  /**
   * 重命名文件/目录: 调用 /open/ufile/rename
   */
  async renameFile(input: { fileId: string; newName: string }): Promise<Pan115ActionResult> {
    const body = new URLSearchParams();
    body.set("file_id", input.fileId);
    body.set("file_name", input.newName.trim());

    await this.request("/open/ufile/rename", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    return { ok: true, message: "" };
  }

  /**
   * 提交磁力/HTTP 离线下载任务: 调用 /open/offline/add_task_urls
   */
  async addOfflineTask(input: { url: string; directoryId: string }): Promise<Pan115ActionResult> {
    const body = new URLSearchParams();
    body.set("url", input.url.trim());
    body.set("savepath", String(input.directoryId || "0"));

    await this.request("/open/offline/add_task_urls", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    return {
      ok: true,
      message: "",
    };
  }

  /**
   * 查询当前离线任务列表: 调用 /open/offline/task_list
   */
  async listOfflineTasks(): Promise<Pan115OfflineTask[]> {
    const res = await this.request<{
      data?: Array<{
        info_hash?: string;
        name?: string;
        status?: number;
        percentDone?: number;
        file_size?: number;
      }>;
    }>("/open/offline/task_list");

    const tasks = Array.isArray(res.data) ? res.data : [];
    return tasks.map((t) => {
      const status = Number(t.status ?? 0);
      return {
        infoHash: String(t.info_hash || ""),
        name: String(t.name || ""),
        percentDone: Number(t.percentDone ?? 0),
        status,
        statusText: status === 2 ? "downloading" : status === 1 ? "waiting" : "done",
        url: "",
      };
    });
  }
}

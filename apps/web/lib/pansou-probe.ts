/**
 * 保存自建搜索源地址时的一次性探活。用户此前只被校验 `^https?://`，于是一个
 * 打不通的地址（或一个根本不是 PanSou 的服务）会被欣然保存，之后每一次获取
 * 都静默失败，还报成「未找到资源」——真实案例里这样活了 6 天。
 *
 * 只在**保存**时打这一次网络。设置页徽章每 8s 轮询一次，绝不能在那条路径上探活。
 */
import type { PanSouAuth } from "@media-track/workflow";

export type PanSouProbeFailure =
  | "unreachable"
  | "not_pansou"
  | "http_error"
  /** 源要认证而我们给不出有效凭据（401/403）。与 http_error 分开，是因为用户的
   *  处置动作完全不同：「改密码 / 贴新令牌」，而不是「这地址打不开」。 */
  | "auth_failed";

export type PanSouProbeResult =
  | { ok: true }
  | { ok: false; reason: PanSouProbeFailure; message: string };

const PROBE_TIMEOUT_MS = 8000;

/** PanSou 的公开健康与认证端点（fish2018/pansou api/router.go）。 */
const PANSOU_HEALTH_PATH = "/api/health";
const PANSOU_LOGIN_PATH = "/api/auth/login";
const PANSOU_VERIFY_PATH = "/api/auth/verify";

export async function probePanSou(
  baseURL: string,
  options: {
    fetchImpl?: typeof fetch | undefined;
    /** 带认证探活。给了 bearer 就直接带头；给了用户名密码就先登录换令牌 ——
     *  否则探活会对一台开了认证的实例永远返回 401，保存被无解地拒绝。 */
    auth?: PanSouAuth | undefined;
  } = {},
): Promise<PanSouProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // trim 后再拼:首尾空白会拼出非法请求地址。
  const base = baseURL.trim().replace(/\/+$/, "");
  const health = await probePanSouHealth(base, fetchImpl);
  if (!health.ok) return health.failure;
  return verifyPanSouAuth(base, health.authEnabled, options.auth, fetchImpl);
}

type PanSouHealthResult =
  | { ok: true; authEnabled: boolean }
  | { ok: false; failure: PanSouProbeResult };

async function probePanSouHealth(base: string, fetchImpl: typeof fetch): Promise<PanSouHealthResult> {
  const request = await fetchProbeResponse(
    fetchImpl,
    `${base}${PANSOU_HEALTH_PATH}`,
    { method: "GET" },
    "健康检查请求失败",
  );
  if (!request.ok) return { ok: false, failure: request.failure };
  const responseFailure = classifyHttpFailure(request.response, "PanSou 健康检查");
  if (responseFailure) return { ok: false, failure: responseFailure };
  const payload: unknown = await request.response.json().catch(() => null);
  return isPanSouHealth(payload)
    ? { ok: true, authEnabled: payload.auth_enabled }
    : {
        ok: false,
        failure: {
          ok: false,
          reason: "not_pansou",
          message: "该地址能访问，但健康检查响应不是 PanSou 格式，未保存。",
        },
      };
}

async function verifyPanSouAuth(
  base: string,
  authEnabled: boolean,
  auth: PanSouAuth | undefined,
  fetchImpl: typeof fetch,
): Promise<PanSouProbeResult> {
  if (!auth || auth.kind === "none") {
    return authEnabled
      ? {
          ok: false,
          reason: "auth_failed",
          message: "该 PanSou 已启用认证，请填写用户名密码或访问令牌，未保存。",
        }
      : { ok: true };
  }
  if (!authEnabled) {
    return {
      ok: false,
      reason: "auth_failed",
      message: "该 PanSou 未启用认证；请清空认证凭据后再保存，未保存。",
    };
  }
  return auth.kind === "bearer"
    ? probeBearerToken(base, auth.token, fetchImpl)
    : probeLoginCredentials(base, auth.username, auth.password, fetchImpl);
}

async function probeBearerToken(
  base: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<PanSouProbeResult> {
  const request = await fetchProbeResponse(
    fetchImpl,
    `${base}${PANSOU_VERIFY_PATH}`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    "令牌验证请求失败",
  );
  if (!request.ok) return request.failure;
  const responseFailure = classifyHttpFailure(request.response, "PanSou 令牌验证", true);
  if (responseFailure) return responseFailure;
  const payload: unknown = await request.response.json().catch(() => null);
  return isVerifiedToken(payload)
    ? { ok: true }
    : { ok: false, reason: "auth_failed", message: "PanSou 未确认该访问令牌有效，未保存。" };
}

async function probeLoginCredentials(
  base: string,
  username: string,
  password: string,
  fetchImpl: typeof fetch,
): Promise<PanSouProbeResult> {
  const request = await fetchProbeResponse(
    fetchImpl,
    `${base}${PANSOU_LOGIN_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    },
    "登录请求失败",
  );
  if (!request.ok) return request.failure;
  const responseFailure = classifyHttpFailure(request.response, "PanSou 登录", true);
  if (responseFailure) return responseFailure;
  const payload: unknown = await request.response.json().catch(() => null);
  const token = (payload as { token?: unknown } | null)?.token;
  return typeof token === "string" && token.length > 0
    ? { ok: true }
    : { ok: false, reason: "auth_failed", message: "PanSou 登录响应未提供访问令牌，未保存。" };
}

async function fetchProbeResponse(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  phase: string,
): Promise<{ ok: true; response: Response } | { ok: false; failure: PanSouProbeResult }> {
  try {
    return {
      ok: true,
      response: await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }),
    };
  } catch (error) {
    return { ok: false, failure: transportFailure(error, phase) };
  }
}

function classifyHttpFailure(
  response: Response,
  phase: string,
  authRequest = false,
): PanSouProbeResult | null {
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: "auth_failed",
      message: authRequest
        ? `认证失败：${phase}未被接受（HTTP ${response.status}），未保存。`
        : `${phase}被拒绝（HTTP ${response.status}），未保存。`,
    };
  }
  return response.ok
    ? null
    : { ok: false, reason: "http_error", message: `${phase}返回 HTTP ${response.status}，未保存。` };
}

function isPanSouHealth(payload: unknown): payload is { status: "ok"; auth_enabled: boolean } {
  if (typeof payload !== "object" || payload === null) return false;
  const value = payload as { status?: unknown; auth_enabled?: unknown };
  return value.status === "ok" && typeof value.auth_enabled === "boolean";
}

function isVerifiedToken(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && (payload as { valid?: unknown }).valid === true;
}

function transportFailure(error: unknown, phase: string): PanSouProbeResult {
  const timedOut =
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  const code = findNetworkErrorCode(error);
  return {
    ok: false,
    reason: "unreachable",
    message: timedOut
      ? `${phase}在 ${PROBE_TIMEOUT_MS / 1000} 秒内无响应，未保存。`
      : `${phase}${code ? `（${code}）` : ""}，无法连接到该 PanSou，未保存；请检查地址、端口、容器网络和代理设置。`,
  };
}

function findNetworkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && typeof current.code === "string" && /^[A-Z0-9_]+$/.test(current.code)) {
      return current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/** 保存前的便宜格式校验。抽出来是为了两个保存入口(设置页 action / agent API)共用
 *  同一条规则并能被直接单测 —— 少了它,一个漏写 scheme 的地址会花 8s 探活然后
 *  拿到「连不上」这种含糊回复,而真正的问题是格式(Copilot 评审指出两侧不一致)。 */
export function validatePanSouBaseUrlFormat(baseURL: string): { ok: true } | { ok: false; message: string } {
  return /^https?:\/\//.test(baseURL.trim())
    ? { ok: true }
    : { ok: false, message: "地址需以 http:// 或 https:// 开头，未保存。" };
}

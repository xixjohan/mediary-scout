/**
 * 保存自建搜索源地址时的一次性探活。用户此前只被校验 `^https?://`，于是一个
 * 打不通的地址（或一个根本不是 PanSou 的服务）会被欣然保存，之后每一次获取
 * 都静默失败，还报成「未找到资源」——真实案例里这样活了 6 天。
 *
 * 只在**保存**时打这一次网络。设置页徽章每 8s 轮询一次，绝不能在那条路径上探活。
 */
import { isPanSouSearchData, type PanSouAuth } from "@media-track/workflow";

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

/** PanSou 的登录端点（fish2018/pansou api/router.go：/api/auth/login 是公开路径）。 */
const PANSOU_LOGIN_PATH = "/api/auth/login";

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
  const url = `${baseURL.trim().replace(/\/+$/, "")}/api/search`;
  const auth = await resolveProbeAuthHeaders(url, options.auth, fetchImpl);
  if ("failure" in auth) {
    return auth.failure;
  }
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth.headers },
      // 探活用一个无意义关键词：命中与否不重要，响应形状才重要。
      body: JSON.stringify({ kw: "__probe__", res: "all" }),
      // 与仓库其余处一致(fetch-with-timeout.ts / remote-access-probe.ts):
      // 用 AbortSignal.timeout 而不是手搓 controller + setTimeout。
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      // 401/403 单列成 auth_failed：这两类是「凭据不对」，其余才是「源有问题」。
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          reason: "auth_failed",
          message: `搜索源要求认证但凭据未被接受（HTTP ${response.status}），未保存。请检查用户名密码或令牌。`,
        };
      }
      return {
        ok: false,
        reason: "http_error",
        message: `搜索源返回 HTTP ${response.status}，未保存。`,
      };
    }
    // 非 JSON（nginx 欢迎页之类）在这里变成 null，随后被判为 not_pansou。
    // 这不是「吞掉错误」：解析失败本身就是「这不是 PanSou」的证据，
    // 而它会带着可读原因回给用户，不会消失。
    const payload: unknown = await response.json().catch(() => null);
    if (!isPanSouShaped(payload)) {
      return {
        ok: false,
        reason: "not_pansou",
        message: "该地址能访问，但返回的不是 PanSou 接口格式（是不是填成了别的服务？），未保存。",
      };
    }
    return { ok: true };
  } catch (error) {
    // AbortSignal.timeout 到期时 fetch 抛的是 TimeoutError(仓库既有测试
    // remote-access.test.ts 断言的就是这个),不是 AbortError。两个都认,
    // 否则超时会被误归成「连不上」的泛泛提示。
    const aborted =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      reason: "unreachable",
      message: aborted
        ? `搜索源 ${PROBE_TIMEOUT_MS / 1000} 秒内无响应，未保存；若想先跑起来，清空本项即可回落官方源。`
        : "连不上该搜索源，未保存。请检查地址、端口与容器是否在运行；若想先跑起来，清空本项即可回落官方源。",
    };
  }
}

/**
 * 探活前把认证头准备好。登录形态会真的打一次 /api/auth/login —— 探活的全部
 * 意义就是「保存前证明这台源配对了」，跳过登录等于证明了一件没用的事。
 *
 * 登录失败不抛异常，而是转成 auth_failed 结果：探活的契约是「返回一个带原因的
 * 结果」，抛出去会让调用方多一条要处理的路径。
 */
async function resolveProbeAuthHeaders(
  searchUrl: string,
  auth: PanSouAuth | undefined,
  fetchImpl: typeof fetch,
): Promise<{ headers: Record<string, string> } | { failure: PanSouProbeResult }> {
  if (!auth || auth.kind === "none") {
    return { headers: {} };
  }
  if (auth.kind === "bearer") {
    return { headers: { Authorization: `Bearer ${auth.token}` } };
  }
  const base = searchUrl.replace(/\/api\/search$/, "");
  try {
    const response = await fetchImpl(`${base}${PANSOU_LOGIN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: auth.username, password: auth.password }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        failure: {
          ok: false,
          reason: "auth_failed",
          message: `登录失败（HTTP ${response.status}）：${text.slice(0, 160)}，未保存。`,
        },
      };
    }
    const payload: unknown = JSON.parse(text) as unknown;
    const token = (payload as { token?: unknown }).token;
    if (typeof token !== "string" || !token) {
      return {
        failure: {
          ok: false,
          reason: "auth_failed",
          message: "登录响应里没有 token 字段，未保存。",
        },
      };
    }
    return { headers: { Authorization: `Bearer ${token}` } };
  } catch (error) {
    return {
      failure: {
        ok: false,
        reason: "auth_failed",
        message: `登录请求失败：${error instanceof Error ? error.message : String(error)}，未保存。`,
      },
    };
  }
}

function isPanSouShaped(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  // One rule, shared with the workflow provider (isPanSouSearchData): a present
  // `results` must be an array; with it absent, PanSou's zero-hit reply is
  // `{"data":{"total":0}}` (`results,omitempty`). The probe keyword is deliberately
  // meaningless, so on a fresh instance THAT is the normal reply — rejecting it
  // refuses a healthy address; diverging from the provider's rule could persist
  // one the provider then cannot consume.
  return isPanSouSearchData((payload as { data?: unknown }).data);
}

/** 保存前的便宜格式校验。抽出来是为了两个保存入口(设置页 action / agent API)共用
 *  同一条规则并能被直接单测 —— 少了它,一个漏写 scheme 的地址会花 8s 探活然后
 *  拿到「连不上」这种含糊回复,而真正的问题是格式(Copilot 评审指出两侧不一致)。 */
export function validatePanSouBaseUrlFormat(baseURL: string): { ok: true } | { ok: false; message: string } {
  return /^https?:\/\//.test(baseURL.trim())
    ? { ok: true }
    : { ok: false, message: "地址需以 http:// 或 https:// 开头，未保存。" };
}

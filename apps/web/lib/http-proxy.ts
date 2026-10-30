import { EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";

/**
 * Opt-in outbound proxy for the server's global `fetch`.
 *
 * Node's built-in `fetch` (undici) does NOT read `HTTP_PROXY` / `HTTPS_PROXY`
 * environment variables on its own (and `NODE_USE_ENV_PROXY` only exists on
 * Node 24+). So a self-hoster behind the GFW who sets those vars in
 * docker-compose still couldn't reach `api.themoviedb.org` directly — every
 * TMDB call went out unproxied and timed out (#68).
 *
 * Installing undici's `EnvHttpProxyAgent` as the global dispatcher makes
 * `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` actually take effect for every
 * outbound fetch (TMDB direct, PanSou, Prowlarr). It is OPT-IN: with no proxy
 * env set we install nothing, so the default direct-fetch path is unchanged.
 */

export interface ConfigureProxyDeps {
  setDispatcher: (dispatcher: Dispatcher) => void;
  makeAgent: () => Dispatcher;
}

export interface ConfigureProxyResult {
  enabled: boolean;
  proxyUrl?: string;
  /** Credentials-stripped host:port for safe logging — a proxy URL may embed
   *  user:pass, which must never reach application logs. */
  proxyDisplay?: string;
}

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;

/** 境内网盘生态、豆瓣评分及内部微服务默认免代理白名单，确保即使开启外网代理，国内直连服务也绝不挂起或被拉崩。 */
export const DEFAULT_DOMESTIC_NO_PROXY = [
  "localhost",
  "127.0.0.1",
  "::1",
  "web",
  "worker",
  "pansou",
  "115.com",
  "*.115.com",
  ".115.com",
  "passportapi.115.com",
  "qrcodeapi.115.com",
  "webapi.115.com",
  "proapi.115.com",
  "115cdn.com",
  "*.115cdn.com",
  ".115cdn.com",
  "anxia.com",
  "*.anxia.com",
  ".anxia.com",
  "quark.cn",
  "*.quark.cn",
  ".quark.cn",
  "uc.cn",
  "*.uc.cn",
  ".uc.cn",
  "api.open.uc.cn",
  "drive.uc.cn",
  "su.uc.cn",
  "alipan.com",
  "*.alipan.com",
  ".alipan.com",
  "aliyundrive.com",
  "*.aliyundrive.com",
  ".aliyundrive.com",
  "123pan.com",
  "*.123pan.com",
  ".123pan.com",
  "123pan.cn",
  "*.123pan.cn",
  ".123pan.cn",
  "189.cn",
  "*.189.cn",
  ".189.cn",
  "ctyun.cn",
  "*.ctyun.cn",
  ".ctyun.cn",
  "douban.com",
  "*.douban.com",
  ".douban.com",
  "doubanio.com",
  "*.doubanio.com",
  ".doubanio.com",
  // 局域网私网地址段（防止自建网盘或容器间调用在配置外网代理时被误转发）
  "10.*",
  "192.168.*",
  "172.16.*",
  "172.17.*",
  "172.18.*",
  "172.19.*",
  "172.20.*",
  "172.21.*",
  "172.22.*",
  "172.23.*",
  "172.24.*",
  "172.25.*",
  "172.26.*",
  "172.27.*",
  "172.28.*",
  "172.29.*",
  "172.30.*",
  "172.31.*",
] as const;

export function resolveMergedNoProxy(existing?: string): string {
  const custom = (existing ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set(custom);
  for (const domain of DEFAULT_DOMESTIC_NO_PROXY) {
    set.add(domain);
  }
  return Array.from(set).join(",");
}

/** 展开 fetch 错误中的 cause（如 connect ECONNREFUSED），避免向前端仅仅抛出泛化的 "TypeError: fetch failed" */
export function formatNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause) {
      const causeMsg = cause instanceof Error ? cause.message : String(cause);
      return `${error.message} (${causeMsg})`;
    }
    return error.message;
  }
  return String(error);
}

/** Reduce a proxy URL to `host:port`, dropping any embedded credentials. Falls
 *  back to the raw value when it is not a parseable URL (e.g. bare `host:port`). */
function redactProxy(raw: string): string {
  try {
    const u = new URL(raw);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return raw;
  }
}

const defaultDeps: ConfigureProxyDeps = {
  setDispatcher: setGlobalDispatcher,
  makeAgent: () => new EnvHttpProxyAgent(),
};

/**
 * Install the env-driven proxy dispatcher iff a proxy env var is set. Pure
 * w.r.t. its injected deps so the env→install decision is unit-testable without
 * mutating the real global dispatcher.
 */
export function configureHttpProxyFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: ConfigureProxyDeps = defaultDeps,
): ConfigureProxyResult {
  const proxyUrl = PROXY_ENV_KEYS.map((key) => env[key]?.trim()).find((value) => value);
  if (!proxyUrl) {
    return { enabled: false };
  }
  const currentNoProxy = env.NO_PROXY ?? env.no_proxy ?? process.env.NO_PROXY ?? process.env.no_proxy;
  const mergedNoProxy = resolveMergedNoProxy(currentNoProxy);
  process.env.NO_PROXY = mergedNoProxy;
  process.env.no_proxy = mergedNoProxy;

  deps.setDispatcher(deps.makeAgent());
  return { enabled: true, proxyUrl, proxyDisplay: redactProxy(proxyUrl) };
}

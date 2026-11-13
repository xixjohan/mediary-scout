import { isIP } from "node:net";
import { Agent, Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

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

export const HTTP_PROXY_SETTING_KEY = "http_proxy";
export const HTTPS_PROXY_SETTING_KEY = "https_proxy";
export const NO_PROXY_SETTING_KEY = "no_proxy";

export interface ProxySettings {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

async function safeDestroyAgent(agent: Dispatcher | null): Promise<void> {
  if (!agent) return;
  try {
    const target = agent as unknown as { destroy?: () => Promise<void> };
    if (typeof target.destroy === "function") {
      await target.destroy();
    }
  } catch {
    // ignore
  }
}

export class ProxyManager {
  private currentAgent: Dispatcher | null = null;

  public async reload(config: ProxySettings): Promise<ConfigureProxyResult> {
    const proxyUrl = config.httpProxy?.trim() || config.httpsProxy?.trim() || "";
    if (!proxyUrl) {
      await safeDestroyAgent(this.currentAgent);
      this.currentAgent = null;
      setGlobalDispatcher(new Agent());
      return { enabled: false };
    }

    const mergedNoProxy = resolveMergedNoProxy(config.noProxy);
    process.env.NO_PROXY = mergedNoProxy;
    process.env.no_proxy = mergedNoProxy;
    if (config.httpProxy?.trim()) process.env.HTTP_PROXY = config.httpProxy.trim();
    if (config.httpsProxy?.trim()) process.env.HTTPS_PROXY = config.httpsProxy.trim();

    const oldAgent = this.currentAgent;
    const newAgent = new CidrAwareProxyDispatcher();
    this.currentAgent = newAgent;
    setGlobalDispatcher(newAgent);

    await safeDestroyAgent(oldAgent);

    return { enabled: true, proxyUrl, proxyDisplay: redactProxy(proxyUrl) };
  }
}

export const proxyManager = new ProxyManager();

export async function testProxyConnectivity(
  testUrl = "https://api.themoviedb.org/3/configuration",
): Promise<{ ok: boolean; latencyMs: number; message: string }> {
  const start = Date.now();
  try {
    const res = await fetch(testUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(6000),
    });
    const latencyMs = Date.now() - start;
    return {
      ok: res.ok || res.status === 401,
      latencyMs,
      message: res.ok || res.status === 401 ? `连通正常 (${latencyMs}ms)` : `HTTP ${res.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      message: formatNetworkError(error),
    };
  }
}


const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;

/** 境内网盘生态、豆瓣评分及内部微服务默认免代理白名单，确保即使开启外网代理，国内直连服务也绝不挂起或被拉崩。 */
export const DEFAULT_DOMESTIC_NO_PROXY = [
  "localhost",
  "127.0.0.0/8",
  "::1/128",
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
  // 115 实际下发的下载域名是 *.115cdn.net（如 cdnfhnfile.115cdn.net）。
  // 只写 .com 会让视频流走外网代理：实测首字节 2.8-3.8s vs 直连 0.08-0.23s。
  "115cdn.net",
  "*.115cdn.net",
  ".115cdn.net",
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
  // Undici 的 EnvHttpProxyAgent 不认识 CIDR；CidrAwareProxyDispatcher 会按 CIDR
  // 把 IP 字面量目标分流到直连 Agent，不依赖不受支持的 `10.*` 伪通配写法。
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
  "fe80::/10",
] as const;

export function resolveMergedNoProxy(existing?: string): string {
  const customEntries = (existing ?? "").split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  // "*" means every host bypasses the proxy. Appending defaults would make
  // EnvHttpProxyAgent treat it as a literal hostname instead of its wildcard.
  if (customEntries.includes("*")) return "*";

  const entries = new Map<string, string>();
  for (const entry of customEntries) {
    entries.set(entry.toLowerCase(), entry);
  }
  for (const domain of DEFAULT_DOMESTIC_NO_PROXY) {
    entries.set(domain.toLowerCase(), domain);
  }
  return Array.from(entries.values()).join(",");
}

interface ParsedIpAddress {
  version: 4 | 6;
  value: bigint;
  bitLength: 32 | 128;
}

interface ParsedCidr {
  network: ParsedIpAddress;
  prefixLength: number;
}

let cachedCidrSource: string | null = null;
let cachedCidrs: ParsedCidr[] = [];

/**
 * Match an IP-literal request origin against comma/space-separated CIDR entries.
 * Domain names remain the responsibility of EnvHttpProxyAgent's exact/suffix matcher;
 * this deliberately avoids DNS lookups on the request hot path.
 */
export function matchesNoProxyCidr(origin: string | URL, noProxy: string): boolean {
  let url: URL;
  try {
    url = origin instanceof URL ? origin : new URL(origin);
  } catch {
    return false;
  }

  const address = parseIpAddress(url.hostname);
  if (!address) return false;

  if (cachedCidrSource !== noProxy) {
    cachedCidrSource = noProxy;
    cachedCidrs = noProxy.split(/[\s,]+/).map(parseCidr).filter((cidr): cidr is ParsedCidr => cidr !== null);
  }
  for (const cidr of cachedCidrs) {
    if (cidr.network.version !== address.version) continue;
    const hostBits = BigInt(address.bitLength - cidr.prefixLength);
    if ((address.value >> hostBits) === (cidr.network.value >> hostBits)) return true;
  }
  return false;
}

function parseCidr(entry: string): ParsedCidr | null {
  const slashIndex = entry.lastIndexOf("/");
  if (slashIndex <= 0) return null;
  const network = parseIpAddress(entry.slice(0, slashIndex));
  const prefixLength = Number(entry.slice(slashIndex + 1));
  if (
    !network ||
    !Number.isInteger(prefixLength) ||
    prefixLength < 0 ||
    prefixLength > network.bitLength
  ) {
    return null;
  }
  return { network, prefixLength };
}

function parseIpAddress(rawAddress: string): ParsedIpAddress | null {
  let address = rawAddress;
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  // RFC 4007 zone identifiers select an interface, not part of the address bits.
  address = address.split("%")[0] ?? address;
  const version = isIP(address);
  if (version === 4) {
    const value = address.split(".").reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n);
    return { version: 4, value, bitLength: 32 };
  }
  if (version !== 6) return null;

  const normalized = ipv6ToBigInt(address);
  return normalized === null ? null : { version: 6, value: normalized, bitLength: 128 };
}

function ipv6ToBigInt(address: string): bigint | null {
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4Tail = normalized.slice(lastColon + 1);
    if (lastColon < 0 || isIP(ipv4Tail) !== 4) return null;
    const octets = ipv4Tail.split(".").map(Number);
    const firstWord = ((octets[0]! << 8) | octets[1]!).toString(16);
    const secondWord = ((octets[2]! << 8) | octets[3]!).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${firstWord}:${secondWord}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0]!.split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  const missingWords = 8 - left.length - right.length;
  if ((halves.length === 1 && missingWords !== 0) || (halves.length === 2 && missingWords < 1)) {
    return null;
  }
  const words = [...left, ...Array.from({ length: missingWords }, () => "0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[\da-f]{1,4}$/i.test(word))) return null;
  return words.reduce((acc, word) => (acc << 16n) | BigInt(`0x${word}`), 0n);
}

export interface CidrAwareProxyDispatcherOptions {
  /** Test seam; production defaults to direct sockets for CIDR matches. */
  directDispatcher?: Dispatcher;
  /** Test seam; production defaults to the existing environment proxy agent. */
  proxyDispatcher?: Dispatcher;
  /** Test seam; production reads the same NO_PROXY variable as Undici. */
  getNoProxy?: () => string;
}

/**
 * Add CIDR semantics on top of Undici's EnvHttpProxyAgent. The existing agent
 * continues to handle hostnames, exact IPs, and domain suffixes; IP literals in
 * NO_PROXY CIDRs are dispatched through a direct Agent. No address enumeration
 * or per-request DNS lookup is needed, including for large prefixes such as /8.
 */
import { isHostExcluded } from "@media-track/workflow";

function matchesNoProxyHostname(origin: string | URL, noProxy: string): boolean {
  try {
    const url = origin instanceof URL ? origin : new URL(origin);
    return isHostExcluded(url.hostname, noProxy);
  } catch {
    return false;
  }
}

export class CidrAwareProxyDispatcher extends Dispatcher {
  private readonly directDispatcher: Dispatcher;
  private readonly proxyDispatcher: Dispatcher;
  private readonly getNoProxy: () => string;

  public constructor(options: CidrAwareProxyDispatcherOptions = {}) {
    super();
    this.directDispatcher = options.directDispatcher ?? new Agent();
    this.proxyDispatcher = options.proxyDispatcher ?? new EnvHttpProxyAgent();
    this.getNoProxy = options.getNoProxy ?? (() => process.env.no_proxy ?? process.env.NO_PROXY ?? "");
  }

  public override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = options.origin;
    const noProxy = this.getNoProxy();
    // 同时判定 CIDR 与主机名：EnvHttpProxyAgent 在构造时快照 NO_PROXY，
    // 运行期补进来的域名（如解析后新增的 CDN 域）只有在这里判定才会生效。
    const bypass = Boolean(origin) && (matchesNoProxyCidr(origin!, noProxy) || matchesNoProxyHostname(origin!, noProxy));
    const target = bypass ? this.directDispatcher : this.proxyDispatcher;
    return target.dispatch(options, handler);
  }

  public override close(callback: () => void): void;
  public override close(): Promise<void>;
  public override close(callback?: () => void): Promise<void> | void {
    const closed = Promise.all([this.directDispatcher.close(), this.proxyDispatcher.close()]).then(() => undefined);
    if (callback) {
      void closed.then(callback);
      return;
    }
    return closed;
  }

  public override destroy(error: Error | null, callback: () => void): void;
  public override destroy(callback: () => void): void;
  public override destroy(error?: Error | null): Promise<void>;
  public override destroy(
    errorOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): Promise<void> | void {
    const error = typeof errorOrCallback === "function" ? null : (errorOrCallback ?? null);
    const done = typeof errorOrCallback === "function" ? errorOrCallback : callback;
    const destroyed = Promise.all([
      this.directDispatcher.destroy(error),
      this.proxyDispatcher.destroy(error),
    ]).then(() => undefined);
    if (done) {
      void destroyed.then(done);
      return;
    }
    return destroyed;
  }
}

/** 展开 fetch 错误中的 cause（如 connect ECONNREFUSED），避免向前端仅仅抛出泛化的 "TypeError: fetch failed" */
export function formatNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause) {
      const causeCode =
        typeof cause === "object" && cause !== null && "code" in cause && typeof (cause as { code: unknown }).code === "string"
          ? ` [${(cause as { code: string }).code}]`
          : "";
      const causeMsg = cause instanceof Error ? cause.message : String(cause);
      return `${error.message}${causeCode} (${causeMsg})`;
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
  makeAgent: () => new CidrAwareProxyDispatcher(),
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

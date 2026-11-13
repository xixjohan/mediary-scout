/**
 * 出站直连白名单（NO_PROXY）运行时维护。
 *
 * 背景：视频直链的 CDN 域名由网盘动态下发（115 实际是 `*.115cdn.net`，而白名单里
 * 长期只写了 `.115cdn.com`）。一旦漏配，整条视频流会被送进外网代理：
 * 实测首字节 2.8–3.8s，直连仅 0.08–0.23s。
 *
 * 这里在解析出直链后，把它的「可注册域」补进 `NO_PROXY`，让后续请求自动直连，
 * 避免下次网盘更换 CDN 域名时再踩同一个坑。只追加、不删除，进程内即时生效
 * （`EnvHttpProxyAgent` 每次 dispatch 都会重新读取该环境变量）。
 */

const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;

/** 常见二级后缀：这些域名需要保留三段才是有意义的注册域。 */
const TWO_LEVEL_SUFFIXES = new Set([
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "co.jp",
  "com.hk",
  "com.tw",
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** 取可注册域：`cdn1.foo.115cdn.net` → `115cdn.net`；IP 与非法输入返回 null。 */
export function registrableDomain(hostname: string): string | null {
  const host = hostname.trim().toLowerCase();
  if (!host || host.includes(":") || IPV4.test(host)) return null;
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_LEVEL_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

/** 单条 NO_PROXY 条目是否命中该主机（支持 `host` / `.host` / `*.host`）。 */
export function matchesNoProxyEntry(hostname: string, entry: string): boolean {
  const host = hostname.trim().toLowerCase();
  const raw = entry.trim().toLowerCase();
  if (!host || !raw) return false;
  if (raw === "*") return true;
  if (raw.startsWith("*.")) {
    const suffix = raw.slice(1); // ".115cdn.net"
    return host === raw.slice(2) || host.endsWith(suffix);
  }
  if (raw.startsWith(".")) {
    return host === raw.slice(1) || host.endsWith(raw);
  }
  return host === raw;
}

export function isHostExcluded(hostname: string, noProxy: string): boolean {
  return noProxy
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((entry) => matchesNoProxyEntry(hostname, entry));
}

/**
 * 把主机所属的可注册域补进 `NO_PROXY`。
 * @returns 是否真的追加了条目（幂等：已覆盖时返回 false）。
 */
export function ensureNoProxyHost(hostname: string): boolean {
  const domain = registrableDomain(hostname);
  if (!domain) return false;

  const current = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  if (isHostExcluded(hostname, current)) return false;

  const entry = `.${domain}`;
  const next = current.trim() ? `${current.replace(/\s*,\s*$/, "")},${entry}` : entry;
  for (const key of NO_PROXY_KEYS) {
    process.env[key] = next;
  }
  return true;
}

/** 供测试使用：清理注入的条目。 */
export function __resetNoProxyForTests(original: string | undefined): void {
  for (const key of NO_PROXY_KEYS) {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

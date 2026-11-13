import type { StrmDeliveryMode } from "./strm-types.js";

/**
 * 提取客户端 User-Agent 规范分类标识
 *
 * 作用：
 * 1. 隔离不同客户端的直链缓存（彻底杜绝 Chrome UA 签名污染 PotPlayer/Infuse 等播放器）；
 * 2. 避免因浏览器小版本升级导致缓存过度碎片化；
 * 3. 供流媒体分发自适应决策使用。
 */
export function normalizeUserAgentCategory(ua: string | null | undefined): string {
  if (!ua || !ua.trim()) {
    return "anonymous";
  }
  const lower = ua.toLowerCase();
  if (lower.includes("potplayer")) return "potplayer";
  if (lower.includes("vidhub")) return "vidhub";
  if (lower.includes("infuse")) return "infuse";
  if (lower.includes("vlc") || lower.includes("libvlc")) return "vlc";
  if (lower.includes("mpv") || lower.includes("libmpv")) return "mpv";
  if (lower.includes("plex") || lower.includes("plexmediaserver")) return "plex";
  if (lower.includes("lavf") || lower.includes("ffmpeg")) return "ffmpeg";
  if (lower.includes("edg/")) return "edge";
  if (lower.includes("chrome/") || lower.includes("crios/")) return "chrome";
  if (lower.includes("safari/") && !lower.includes("chrome")) return "safari";
  if (lower.includes("firefox/")) return "firefox";
  return "other";
}

/**
 * 判断客户端在跟随 302 重定向时是否容易因 User-Agent 丢失/篡改或响应头兼容性导致播放失败
 */
/**
 * 默认「易因 302 直连失败」的播放器类别。
 *
 * 这些客户端对 115 的 UA 绑定签名更敏感，历史上一律强制代理。
 * 允许通过 `STRM_FORCE_PROXY_UA_CATEGORIES` 覆盖（逗号分隔），
 * 便于在确认某个客户端能直连后灰度放开，而不必改代码。
 */
export const DEFAULT_FORCE_PROXY_UA_CATEGORIES: readonly string[] = [
  "potplayer",
  "vlc",
  "mpv",
  "ffmpeg",
  "plex",
  "anonymous",
];

/** 解析强制代理的 UA 类别集合；未配置时使用默认值（行为与历史一致）。 */
export function resolveForceProxyUaCategories(
  raw: string | null | undefined = process.env.STRM_FORCE_PROXY_UA_CATEGORIES,
): ReadonlySet<string> {
  if (!raw || !raw.trim()) return new Set(DEFAULT_FORCE_PROXY_UA_CATEGORIES);
  const parsed = raw
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return new Set(parsed.length > 0 ? parsed : DEFAULT_FORCE_PROXY_UA_CATEGORIES);
}

export function isUserAgentProneToRedirectFailure(
  ua: string | null | undefined,
  forced: ReadonlySet<string> = new Set(DEFAULT_FORCE_PROXY_UA_CATEGORIES),
): boolean {
  if (!ua || !ua.trim()) return true;
  const category = normalizeUserAgentCategory(ua);
  return category === "anonymous" || forced.has(category);
}

export interface DetermineEffectiveDeliveryModeInput {
  configuredMode?: StrmDeliveryMode | "auto" | string | undefined;
  provider?: string | undefined;
  userAgent?: string | null | undefined;
  /** 强制代理的 UA 类别；缺省用默认集合。 */
  forceProxyUaCategories?: ReadonlySet<string> | undefined;
}

/**
 * 综合判定最终的流媒体交付模式 (Smart Adaptive Delivery Engine)
 *
 * 优先级规范：
 * 1. 任务或存储驱动显式声明 "proxy" -> 强制使用服务端串流代理 (HTTP 206 Partial Content 流式中继)；
 * 2. 底层存储物理特性约束（如 Quark / UC 必须附带 Cookie / 签名头，无法 302 直连）-> 强制 "proxy"；
 * 3. 针对 115 等强鉴权网盘 (强绑定 UA 签名防盗链与 AliyunOSS attachment 限制)：
 *    - 若配置为 "auto" 或缺省 -> 默认选用 "proxy" 保障 100% 播放成功；
 *    - 若配置为 "redirect"，但客户端为 PotPlayer / VLC / mpv / ffmpeg 等易受阻断的播放器 -> 智能安全回退至 "proxy"；
 *    - 若配置为 "redirect" 且客户端属于标准安全浏览器或已知合规客户端 -> 放行 "redirect"；
 * 4. 通用驱动配置为 "auto" 时，高危播放器走 "proxy"，其余走 "redirect"；
 * 5. 其余常规情况尊重配置声明。
 */
export function determineEffectiveDeliveryMode(
  input: DetermineEffectiveDeliveryModeInput,
): "proxy" | "redirect" {
  const { configuredMode, provider, userAgent } = input;
  const forcedUa = input.forceProxyUaCategories ?? new Set(DEFAULT_FORCE_PROXY_UA_CATEGORIES);

  if (configuredMode === "proxy") {
    return "proxy";
  }

  if (provider === "quark" || provider === "uc") {
    return "proxy";
  }

  if (provider === "pan115") {
    if (configuredMode === "auto" || !configuredMode) {
      return "proxy";
    }
    // 115 网盘在配置为 redirect 时，若客户端是易触发 403 签名校验失败的高危播放器，自动安全回退至 proxy
    if (isUserAgentProneToRedirectFailure(userAgent, forcedUa)) {
      return "proxy";
    }
    return configuredMode === "redirect" ? "redirect" : "proxy";
  }

  if (configuredMode === "auto") {
    return isUserAgentProneToRedirectFailure(userAgent, forcedUa) ? "proxy" : "redirect";
  }

  return configuredMode === "redirect" ? "redirect" : "proxy";
}

export interface BuildStrmLinkCacheKeyInput {
  storageId: string;
  fileId: string;
  deliveryMode: "proxy" | "redirect";
  userAgent?: string | null | undefined;
}

/**
 * 构造多维安全的 STRM 直链缓存键
 *
 * 核心设计：
 * 1. 模式隔离：proxy 模式与 redirect 模式缓存彻底隔离；
 * 2. Proxy 共享：proxy 模式统一由服务端拉流（统一合规 UA），所有客户端安全共享缓存，大幅降低对网盘 API 的请求频次；
 * 3. Redirect 隔离：redirect 模式将客户端规范化 UA 纳入 CacheKey，彻底消除 Chrome 与 PotPlayer 间的签名污染。
 */
export function buildStrmLinkCacheKey(input: BuildStrmLinkCacheKeyInput): string {
  const { storageId, fileId, deliveryMode, userAgent } = input;
  if (deliveryMode === "proxy") {
    return `${storageId}:${fileId}:proxy:shared`;
  }
  const uaCategory = normalizeUserAgentCategory(userAgent);
  return `${storageId}:${fileId}:redirect:${uaCategory}`;
}

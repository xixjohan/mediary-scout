/**
 * 「自守 API」清单：这些端点**自己**做鉴权，proxy 不得把它们重定向到 /login。
 *
 * 为什么需要这份清单：`apps/web/proxy.ts` 只认 session cookie（或 Bearer 头）做
 * 粗筛，而下面这些端点的调用方**天生没有浏览器会话**：
 *
 *  - `workflows/*` —— host-worker 用 `x-media-track-worker-secret`；
 *  - `agent/*`     —— 外部 agent 用独立 Bearer token；
 *  - `update/*`    —— updater 容器用 updater token；
 *  - `health`      —— 探活必须公开；
 *  - `strm/play/*` —— **Emby / Infuse / Plex / PotPlayer 读 .strm 文件后直接取流**，
 *                     它们不可能持有浏览器 session；
 *  - `mcp`         —— MCP 客户端用自己的令牌，走 `resolveSecurityContext`。
 *
 * 缺陷原型（2026-11-17，实测）：多用户模式（`MEDIA_TRACK_MULTI_USER=1`）下，
 * `/api/strm/play/...` 返回 `307 /login`，`.strm` 里再正确的签名也播不了——
 * 因为请求**根本到不了播放路由**。而 `route-auth-inventory.test.ts` 早已把
 * `strm/play` 归为「自鉴权」类：**一个端点被清单认成自守，proxy 却照样拦它，
 * 两套判定各说各话**——这正是要防的同类缺陷。
 */
export const SELF_GUARDED_API_PREFIXES = [
  "/api/health",
  "/api/workflows/",
  "/api/agent/",
  "/api/update/busy",
  "/api/update/hold",
  // 播放路由自守（播放签名 + 任务配置校验）；外部媒体播放器没有 session。
  // 播放路由自守（播放签名 + 任务配置校验）；外部媒体播放器没有 session。
  "/api/strm/play/",
  // MCP 协议端点自守（resolveSecurityContext，认 cookie / Bearer / API Key）。
  "/api/mcp",
] as const;

/** 某个 /api 路径是否落在自守清单里（proxy 与门禁共用同一份判定）。 */
export function isSelfGuardedApiPath(pathname: string): boolean {
  return SELF_GUARDED_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * 路由 → 细粒度权限点的声明式清单。
 *
 * 为什么要有这张表：权限目录（PERMISSION_CATALOG）与角色权限（BUILTIN_ROLES）早就
 * 存在，但 105 个路由过去只调 `requireApiAccount` —— **配了权限却从不执行**。
 * 这张表把「哪个端点要哪把钥匙」显式写下来，门禁（route-auth-inventory.test.ts）
 * 逐条核对源码里真的调了 `requirePermission(该权限点)`，注释或字符串不算数。
 *
 * 值可以是单个权限点，也可以是**权限点数组**：同一个文件里读侧与写侧用不同钥匙时
 * （`GET /api/library` 读库列表 vs `POST` 新建库），数组表示「该文件出现的每个权限点
 * 都必须在清单里」，数组里每个元素都必须真的在源码里被调用过。
 *
 * 覆盖已在 2026-11-16 一次性做完：所有非白名单路由都接了权限点。新增路由若未在此
 * 归类，门禁会直接失败——「配了权限但不生效」这个缺陷不可能再回来。
 */

/** 端点路径（相对 /api，与 route-auth-inventory 的 path 格式一致）→ 权限点。 */
export const ROUTE_PERMISSION_TABLE: Record<string, string | readonly string[]> = {
  // ── 网盘扫码登录（绑定网盘账号 = 实例配置面的写动作）──────────────
  "115/qrcode": "system:settings",
  "115/qrcode/confirm": "system:settings",
  "115/qrcode/image": "system:settings",
  "115/qrcode/status": "system:settings",
  "guangya/qrcode": "system:settings",
  "guangya/qrcode/image": "system:settings",
  "guangya/qrcode/status": "system:settings",
  "pan123/qrcode": "system:settings",
  "pan123/qrcode/confirm": "system:settings",
  "pan123/qrcode/image": "system:settings",
  "pan123/qrcode/status": "system:settings",
  "quark/qrcode": "system:settings",
  "quark/qrcode/confirm": "system:settings",
  "quark/qrcode/image": "system:settings",
  "quark/qrcode/status": "system:settings",
  "tianyi/qrcode": "system:settings",
  "tianyi/qrcode/confirm": "system:settings",
  "tianyi/qrcode/image": "system:settings",
  "tianyi/qrcode/status": "system:settings",
  "uc/qrcode": "system:settings",
  "uc/qrcode/confirm": "system:settings",
  "uc/qrcode/image": "system:settings",
  "uc/qrcode/status": "system:settings",

  // ── 助理 MCP 服务器配置（会注入工具、可触达外网）─────────────────
  "assistant/mcp-servers": "system:settings",
  "assistant/mcp-servers/[id]": "system:settings",
  "assistant/mcp-servers/[id]/toggle-tool": "system:settings",
  "assistant/mcp-servers/test": "system:settings",

  // ── 助理会话（读网盘/库上下文，成员角色刻意不含 assistant:chat）────
  "chat": "assistant:chat",
  "chat/conversations": "assistant:chat",
  "chat/conversations/[id]": "assistant:chat",

  // ── 扩展（可加载任意代码）───────────────────────────────────
  "extensions": "system:settings",
  "extensions/[id]": "system:settings",
  "extensions/[id]/code": "system:settings",
  "extensions/[id]/debug-run": "system:settings",
  "extensions/[id]/snapshots": "system:settings",
  "extensions/import": "system:settings",

  // ── 影视库（读 → media:detail；写 → library:manage）──────────────
  "library": ["media:detail", "library:manage"],
  "library/[id]": ["media:detail", "library:manage"],
  "library/[id]/items": "media:detail",
  "library/[id]/paths": ["media:detail", "library:manage"],
  "library/[id]/paths/[bindingId]/test": "library:manage",
  "library/[id]/scan": "library:manage",
  "library/items/[itemId]": ["media:detail", "library:manage"],
  "library/items/[itemId]/rematch": "library:manage",
  "library/items/[itemId]/rename": "library:manage",
  "library/items/batch-action": "library:manage",
  "library/items/batch-rematch": "library:manage",
  "library/play/[episodeId]": "media:play",

  // ── 媒体服务器（推送到 Emby/Jellyfin 的实例配置）─────────────────
  "mediaserver/configs": "system:settings",
  "mediaserver/configs/[id]": "system:settings",
  "mediaserver/configs/[id]/libraries": "system:settings",
  "mediaserver/configs/[id]/records": "system:settings",
  "mediaserver/probe-libraries": "system:settings",
  "mediaserver/refresh": "system:settings",
  "mediaserver/test": "system:settings",

  // ── STRM 任务（生成盘上虚拟流媒体文件 = 实例配置）───────────────
  "strm/replace-base-url": "system:settings",
  "strm/tasks": "system:settings",
  "strm/tasks/[id]": "system:settings",
  "strm/tasks/[id]/records": "system:settings",
  "strm/tasks/[id]/run": "system:settings",

  // ── FRP 隧道线路（暴露实例到公网）─────────────────────────────
  "tunnel/lines": "system:settings",
  "tunnel/lines/[id]": "system:settings",
  "tunnel/lines/[id]/logs": "system:settings",
  "tunnel/lines/[id]/start": "system:settings",
  "tunnel/lines/[id]/stop": "system:settings",

  // ── 本地文件浏览器（可读宿主机任意目录，仅用于 STRM 输出路径选择）──
  "system/fs-browse": "system:settings",

  // ── 网盘文件域 ─────────────────────────────────────────────
  "storage/drives": "storage:list",
  "storage/files": "storage:list",
  "storage/files/adopt": "library:manage",
  "storage/files/copy": "storage:transfer",
  "storage/files/delete": "storage:delete",
  "storage/files/folder": "storage:transfer",
  "storage/files/move": "storage:transfer",
  "storage/files/rename": "storage:organize",
  "storage/offline": ["storage:list", "storage:transfer"],
  "storage/scan": "library:manage",
  "storage/scan/review": "library:manage",

  // ── 标题 / 资源 / 订阅 ──────────────────────────────────────
  "titles/import": "storage:transfer",
  "titles/organize": "storage:organize",
  "titles/organize/unrecognized": "storage:organize",
  "titles/resources": "media:search",
  "titles/resources/inspect": "media:search",
  "titles/resources/link": "media:search",
  "titles/subscription-policy": "media:subscribe",
  "titles/subscription-policy/preview": "media:subscribe",
  "titles/subscription-policy/templates": "media:subscribe",

  // ── 点播请求（成员可看/可取消自己的；站长可全量审批）─────────────
  "media-requests": "workflow:status",

  // ── 活动与通知 ─────────────────────────────────────────────
  "activity": "workflow:status",
  "activity/status": "workflow:status",
  "activity/cancel": "workflow:status",
  "activity/retry": "storage:transfer",
  "notifications/meta": "notifications:read",

  // ── 设置域（账号/角色/API Key/提醒/远程访问）─────────────────────
  "settings/api-key": "system:settings",
  "settings/api-keys": "system:settings",
  "settings/api-keys/[id]": "system:settings",
  "settings/api-keys/[id]/revoke": "system:settings",
  "settings/api-keys/available-permissions": "system:settings",
  "settings/api-keys/catalog": "system:settings",
  "settings/attention": "system:settings",
  "settings/attention/dismiss": "system:settings",
  "settings/roles": "system:settings",
  "settings/roles/[id]": "system:settings",
  "settings/users": "system:settings",
  "settings/users/[id]": "system:settings",
};

/**
 * 已接线端点数。**只增不减**：新增接线要显式改这个数字，从而在评审里被迫看一遍
 * 「新接的这条是不是该给的权限」。这也是本表分批复盘的进度指针。
 */
export const WIRED_ROUTE_COUNT = 104;

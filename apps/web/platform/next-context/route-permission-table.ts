/**
 * 路由 → 细粒度权限点的声明式清单。
 *
 * 为什么要有这张表：权限目录（PERMISSION_CATALOG）与角色权限（BUILTIN_ROLES）早就
 * 存在，但 105 个路由过去只调 `requireApiAccount` —— **配了权限却从不执行**。
 * 这张表把「哪个端点要哪把钥匙」显式写下来，门禁（route-auth-inventory.test.ts）
 * 逐条核对源码里真的调了 `requirePermission(该权限点)`，注释或字符串不算数。
 *
 * 覆盖是**分批推进**的：表里的条目 = 已接线的端点；新增条目必须同时改源码，
 * 漏改会被门禁打红。尚未接线的端点仍走 `requireApiAccount`（仅登录）。
 * 分批顺序见 docs/research/2026-11-15-member-role-access-scope-and-proxy-only-playback-research.md §3.2.3。
 */

/** 端点路径（相对 /api，与 route-auth-inventory 的 path 格式一致）→ 权限点。 */
export const ROUTE_PERMISSION_TABLE: Record<string, string> = {
  // 影视库管理面（决策 1：禁管理、不禁查看）
  "library": "library:manage",
  "library/[id]": "library:manage",
  "library/[id]/scan": "library:manage",
  "library/[id]/paths": "library:manage",
  "library/[id]/paths/[bindingId]/test": "library:manage",
  "library/items/[itemId]": "library:manage",
  "library/items/[itemId]/rematch": "library:manage",
  "library/items/[itemId]/rename": "library:manage",
  "library/items/batch-action": "library:manage",
  "library/items/batch-rematch": "library:manage",
  // 反向扫描会把盘上目录纳入媒体库 = 库管理面的写动作
  "storage/scan": "library:manage",

  // 网盘文件域
  "storage/files": "storage:list",
  "storage/files/folder": "storage:transfer",
  "storage/files/copy": "storage:transfer",
  "storage/files/move": "storage:transfer",
  "storage/files/delete": "storage:delete",
  "storage/files/rename": "storage:organize",
  "storage/files/adopt": "library:manage",
  "storage/offline": "storage:transfer",

  // 活动与通知
  "activity": "workflow:status",
  "activity/status": "workflow:status",
  "activity/cancel": "workflow:status",
  "activity/retry": "storage:transfer",
  "notifications/meta": "notifications:read",

  // 播放
  "library/play/[episodeId]": "media:play",

  // 设置域整体关闭（需求 1）
  "settings/api-key": "system:settings",
  "settings/api-keys": "system:settings",
  "settings/api-keys/catalog": "system:settings",
  "settings/api-keys/available-permissions": "system:settings",
  "settings/api-keys/[id]": "system:settings",
  "settings/api-keys/[id]/revoke": "system:settings",
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
export const WIRED_ROUTE_COUNT = 37;

/**
 * 页面 → 权限点的声明式清单（与 API 侧的 `route-permission-table.ts` 同构）。
 *
 * 为什么要有这张表：页面守卫过去是**逐页复制**的——根页面加了钥匙，子页面照抄
 * `PageLoginGuard` 就以为齐了。缺陷原型：`/settings` 开了 `system:settings`，
 * 而 `/settings/mediaserver`、`/settings/extensions` 仍只要求登录，成员手输 URL
 * 就能进配置面。同类缺陷在 `/chat` 上也存在。
 *
 * 这里把「哪个页面要哪把钥匙」显式写下来，门禁（page-auth-inventory.test.ts）
 * 逐条核对源码里真的调了 `decidePageAccess(..., 该权限点)`。
 *
 * 值的语义：
 *  - `permission`：页面可见所需的权限点（登录后仍可能 403）。
 *  - `null`：**登录即可**（个人面或会话自省页），例如 `/account`。刻意显式写出
 *    null 而不是省略——省略等于「忘了加」，门禁无法区分两者。
 */

export interface PagePermissionEntry {
  /** 必需权限点；null = 登录即可（无权限域）。 */
  permission: string | null;
  /** 为什么是这个权限点（评审时看的理由，不是运行时数据）。 */
  rationale: string;
  /**
   * 站长专属页：判定用 `OwnerPageGuard`（`is_owner` 位），不用权限点。
   * 声明为 true 的页面，门禁要求源码 import 并渲染 `OwnerPageGuard`，且
   * **不得**同时声明权限点——两者混用会让「谁该通过」出现两个答案。
   */
  ownerOnly?: boolean;
}

export const PAGE_PERMISSION_TABLE: Record<string, PagePermissionEntry> = {
  // ── 个人面：登录即可 ─────────────────────────────────────────
  account: { permission: null, rationale: "改自己的密码 / 看自己的资料，与角色无关" },

  // ── 发现与订阅面 ──────────────────────────────────────────
  "": { permission: "media:search", rationale: "首页 = 检索 + 订阅墙" },
  "w/[storageId]": { permission: "media:search", rationale: "同上，按盘切工作区" },
  "show/[tmdbId]": { permission: "media:detail", rationale: "影视详情与演职员表" },
  "foreign-work/[workflowRunId]": {
    permission: "media:detail",
    rationale: "来自通知的外来作品复核页（写入动作由其 API 单独校验）",
  },

  // ── 内容与活动面 ──────────────────────────────────────────
  library: { permission: "media:detail", rationale: "查看影视库内容；管理动作另需 library:manage" },
  activity: { permission: "workflow:status", rationale: "活动/任务进度" },
  notifications: { permission: "notifications:read", rationale: "通知中心" },
  chat: { permission: "assistant:chat", rationale: "助理会读网盘与库上下文" },

  // ── 网盘运维面 ────────────────────────────────────────────
  storage: { permission: "storage:browse_any", rationale: "浏览/整理盘上任意目录" },
  "storage/strm": { permission: "storage:browse_any", rationale: "STRM 任务会写盘上虚拟文件" },

  // ── 站长专属面（is_owner 位，不是权限点）──────────────────────────
  "storage/owner-ingest": {
    permission: null,
    ownerOnly: true,
    rationale: "关键字投放 = 任意读源 + 任意目录写入，只有站长可用；成员不参与公共盘的投放决策",
  },

  // ── 实例配置面（整棵子树同一把钥匙）───────────────────────────
  settings: { permission: "system:settings", rationale: "实例配置总入口" },
  "settings/mediaserver": { permission: "system:settings", rationale: "媒体服务器 token 属于实例配置" },
  "settings/extensions": { permission: "system:settings", rationale: "扩展可加载任意代码" },
};

/**
 * 豁免页面：只有登录面自身。它必须豁免——否则 `/login` → `/login` 成环，
 * 且它本就不在 proxy 的 matcher 里。
 */
export const LOGIN_EXEMPT_PAGES = ["login"] as const;

export const GUARDED_PAGE_COUNT = Object.keys(PAGE_PERMISSION_TABLE).length;

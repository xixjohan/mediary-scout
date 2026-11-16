/**
 * 账号相关入口的唯一构造器。
 *
 * 两个权限域必须分开寻址，这是「入口可达性」这条不变量的物理形态：
 *
 *  - **个人面** `/account`：改自己的密码、看自己的资料。登录即可，**不做权限判定**。
 *  - **实例配置面** `/settings?tab=account`：账号/角色/API Key 管理。只有
 *    `system:settings` 能进，成员一律 403。
 *
 * 历史教训：这两个链接过去由各组件手写字符串拼接，于是把改密入口迁到 `/account`
 * 时漏改了侧边栏账号菜单，成员点「修改密码」直接落到 `/settings` 的 403 面板。
 * 手写拼接无法被类型系统发现——路由与权限是隐式契约。所有入口一律走这里，
 * 再由 `gated-link-reachability` 门禁扫描残留的手写形态（含模板字符串）。
 */

/** 个人自助页（登录即可，无权限点）。 */
export const ACCOUNT_SELF_SERVICE_PATH = "/account";

/** 实例配置面里的账号 tab（需要 `system:settings`）。 */
export const ACCOUNT_ADMIN_PATH = "/settings?tab=account";

export interface AccountLinkOptions {
  /** 锚点（带不带 `#` 都行）。 */
  hash?: string | undefined;
  /** 活跃工作区（网盘 ID）。保留深链上下文，避免静默踢回默认工作区。 */
  w?: string | undefined;
}

function buildHref(base: string, opts: AccountLinkOptions | undefined): string {
  const w = opts?.w;
  const hash = opts?.hash;
  // 用 URLSearchParams 编码（空格 → `+`），与既有 deep-link 约定保持一致；
  // 手写 encodeURIComponent 会给出 `%20`，两套编码混用会让 `?w` 对不上。
  const query = w ? `?${new URLSearchParams({ w }).toString()}` : "";
  const fragment = hash ? (hash.startsWith("#") ? hash : `#${hash}`) : "";
  return `${base}${query}${fragment}`;
}

/** 「修改密码 / 我的资料」入口。成员可用。 */
export function accountSelfServiceHref(opts?: AccountLinkOptions): string {
  return buildHref(ACCOUNT_SELF_SERVICE_PATH, opts);
}

/** 「账号与用户管理」入口。**只应渲染给能进设置页的账号**——否则就是 403 死链。 */
export function accountAdminHref(opts?: AccountLinkOptions): string {
  const w = opts?.w;
  const hash = opts?.hash;
  const query = w ? `&${new URLSearchParams({ w }).toString()}` : "";
  const fragment = hash ? (hash.startsWith("#") ? hash : `#${hash}`) : "";
  return `${ACCOUNT_ADMIN_PATH}${query}${fragment}`;
}

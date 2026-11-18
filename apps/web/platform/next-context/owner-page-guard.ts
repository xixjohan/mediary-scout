import { connection } from "next/server";
import { createElement } from "react";
import { resolvePageAccess } from "./page-permission-guard";
import { PageAccessDenied } from "../../features/auth/components/page-access-denied";

/**
 * 站长专属页面守卫（包裹式）。
 *
 * 为什么不能复用 `PagePermissionGuard(required)`：那一层问的是「角色有没有这把
 * 钥匙」，而站长专属语义是 `is_owner` 位。成员带 `storage:browse_any` 也过不了
 * 这道门，带通配符的自定义角色同样过不了——判据只有 `access.isOwner`。
 *
 * 包裹 children 而不是「返回 null 后在页面里各自 if」：非站长的子树根本不会被
 * 渲染，页面里对网盘列表等数据的读取也就不会发生——「先渲染再拦」会把成员本无权
 * 看到的数据先查一轮。
 *
 * 与 API 侧的 `requireOwner` 读同一个 `is_owner` 位，但**不是同一道门**：
 * 页面守卫只决定渲染，真正的边界在 `/api/owner/ingest/*` 的 `requireOwner`
 * （隐藏 ≠ 关闭）。本文件用 createElement（不是 JSX）以保持 .ts 后缀。
 */
export async function OwnerPageGuard({ children }: { children: React.ReactNode }) {
  await connection();
  const access = await resolvePageAccess();
  if (access.isOwner) return children;
  return createElement(PageAccessDenied, {
    required: "站长专属（owner）",
    verdict: access.authenticated ? "deny" : "login",
  });
}

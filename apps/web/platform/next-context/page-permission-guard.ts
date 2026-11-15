import { createElement } from "react";
import { connection } from "next/server";
import {
  isMultiUserEnabled,
  getCurrentAccountId,
  getWorkflowRepository,
  UNAUTHENTICATED_ACCOUNT_ID,
} from "../../lib/workflow-runtime";
import { getUserManagementService } from "../../composition/runtime-container";
import { PageAccessDenied } from "../../features/auth/components/page-access-denied";

/**
 * 页面级权限（授权，不是认证）。
 *
 * 与 `page-auth-guard` 的分工：那一层只回答「登录了没」，这一层回答「这个角色能不能
 * 看这个页面」。两者都必须在**服务端**判定——侧边栏隐藏入口只是体验优化；把授权交给
 * middleware/proxy 等于没做（CVE-2025-29927 一头部即可绕过）。
 *
 * 单用户（含局域网免密）永远视为 owner：多用户体系尚未启用时把人锁在门外是纯事故。
 */

export interface PageAccess {
  authenticated: boolean;
  isOwner: boolean;
  permissions: ReadonlySet<string>;
}

/** 纯函数，便于表驱动测试：这个账号能否访问需要 required 的页面。 */
export function hasPermission(access: PageAccess, required: string): boolean {
  if (!access.authenticated) return false;
  if (access.isOwner) return true;
  return access.permissions.has(required) || access.permissions.has("*");
}

export function decidePageAccess(
  access: PageAccess,
  required: string,
): "allow" | "deny" | "login" {
  if (!access.authenticated) return "login";
  return hasPermission(access, required) ? "allow" : "deny";
}

async function resolveAccountIsOwner(accountId: string): Promise<boolean> {
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) return false;
  if (!isMultiUserEnabled()) return true;
  const account = await getWorkflowRepository().getAccountById(accountId);
  return account?.isOwner ?? false;
}

export async function resolvePageAccess(): Promise<PageAccess> {
  const accountId = await getCurrentAccountId();
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) {
    return { authenticated: false, isOwner: false, permissions: new Set() };
  }
  if (await resolveAccountIsOwner(accountId)) {
    return { authenticated: true, isOwner: true, permissions: new Set(["*"]) };
  }
  const role = await getUserManagementService().getUserRole(accountId);
  return { authenticated: true, isOwner: false, permissions: new Set(role.permissions) };
}

/**
 * 页面守卫：无权时渲染 403 面板（**不 redirect**）。
 * redirect 会让用户以为自己没登录；403 才说明「你登录了，但这个页面不给你」。
 */
export async function PagePermissionGuard({ required }: { required: string }) {
  await connection();
  const verdict = decidePageAccess(await resolvePageAccess(), required);
  if (verdict === "allow") return null;
  return createElement(PageAccessDenied, { required, verdict });
}

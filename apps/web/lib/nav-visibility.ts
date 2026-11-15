import { connection } from "next/server";
import {
  isMultiUserEnabled,
  getCurrentAccountId,
  getWorkflowRepository,
  UNAUTHENTICATED_ACCOUNT_ID,
} from "./workflow-runtime";
import { getUserManagementService } from "../composition/runtime-container";
import { resolveVisibilityFromPermissions, type NavVisibility } from "../features/auth/core/nav-visibility";

export type { NavVisibility };

/**
 * 侧边栏入口可见性的接线层（读账号 → 取权限集合 → 交给纯函数）。
 *
 * 与 feature-core 的分工：`nav-visibility.ts` 只做"权限集合 → 可见性"的纯映射，
 * 不碰 DB 与 platform 层（否则触发 feature-core-stays-pure）。读凭据放在这里。
 */

export async function resolveNavVisibility(): Promise<NavVisibility> {
  const accountId = await getCurrentAccountId();
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) {
    // 未登录会被登录守卫拦下；这里给"全可见"避免骨架闪烁成"什么都没"。
    return resolveVisibilityFromPermissions(new Set(["*"]));
  }
  // 单用户（含局域网免密）没有角色概念，账号即站长 → 通配符。
  if (!isMultiUserEnabled()) {
    return resolveVisibilityFromPermissions(new Set(["*"]));
  }
  const account = await getWorkflowRepository().getAccountById(accountId);
  if (account?.isOwner) {
    return resolveVisibilityFromPermissions(new Set(["*"]));
  }
  return resolveVisibilityFromPermissions(
    new Set((await getUserManagementService().getUserRole(accountId)).permissions),
  );
}

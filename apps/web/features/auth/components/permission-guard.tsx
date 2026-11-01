"use client";

import React, { type ReactNode } from "react";
import { useAuth } from "../hooks/use-auth";

export interface PermissionGuardProps {
  permission: string;
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * 声明式权限门禁组件
 *
 * 根据当前登录用户的角色与细粒度权限决定子元素是否渲染。
 * 站长 (isOwner) 或具备 "*" 特权的用户天然通过。
 *
 * 示例：
 * ```tsx
 * <PermissionGuard permission="storage:transfer" fallback={<span>无权转存</span>}>
 *   <button onClick={handleTransfer}>转存到网盘</button>
 * </PermissionGuard>
 * ```
 */
export function PermissionGuard({
  permission,
  fallback = null,
  children,
}: PermissionGuardProps) {
  const { can, isAuthenticating } = useAuth();

  if (isAuthenticating) {
    return null;
  }

  if (!can(permission)) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}

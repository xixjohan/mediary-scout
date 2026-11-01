"use client";

import { useAuthContext, type AuthContextValue } from "../components/auth-context";

/**
 * 前端应用统一身份鉴权门面 Hook
 *
 * 聚合登录、退出登录、个人资料、状态机状态以及基于权限的决策算子 (can)。
 * 向业务组件隐藏底层 Fetch、Cookie 及状态迁移细节。
 *
 * 用法示例：
 * ```tsx
 * const { user, isAuthenticated, login, logout, can } = useAuth();
 *
 * if (can("storage:transfer")) {
 *   // 渲染转存按钮
 * }
 * ```
 */
export function useAuth(): AuthContextValue {
  return useAuthContext();
}

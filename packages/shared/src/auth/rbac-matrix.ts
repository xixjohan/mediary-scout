import { PERMISSION_CATALOG } from "./api-key-matrix.js";

/**
 * 权限等级分层常量（数值越小权限越高，对标 DNSPodForNETCore）
 */
export const ROLE_LEVELS = {
  OWNER: 10,
  ADMIN: 20,
  MEMBER: 40,
  BOT: 50,
  GUEST: 60,
} as const;

export interface RoleEntity {
  id: string; // e.g. "role_owner", "role_admin", "role_member", "role_bot", "role_guest" or custom "role_xxx"
  name: string;
  description: string;
  level: number;
  isSystem: boolean;
  permissions: string[]; // List of leaf IDs from PERMISSION_CATALOG, e.g. ["media:search", "storage:list"]
  createdAt: number;
  updatedAt: number;
}

const ALL_CATALOG_LEAF_IDS = PERMISSION_CATALOG.flatMap((m) => m.leaves.map((l) => l.id));

export type BuiltinRoleId =
  | "role_owner"
  | "role_admin"
  | "role_member"
  | "role_bot"
  | "role_guest";

/**
 * 系统内置预设角色
 */
export const BUILTIN_ROLES: Record<BuiltinRoleId, RoleEntity> = {
  role_owner: {
    id: "role_owner",
    name: "站长 (Owner)",
    description: "系统最高所有者，拥有全部业务功能与底层运维配置特权",
    level: ROLE_LEVELS.OWNER,
    isSystem: true,
    permissions: ["*", ...ALL_CATALOG_LEAF_IDS],
    createdAt: 0,
    updatedAt: 0,
  },
  role_admin: {
    id: "role_admin",
    name: "管理员 (Admin)",
    description: "协同管理影视库、离线转存与自动化工作流，受限于安全边界",
    level: ROLE_LEVELS.ADMIN,
    isSystem: true,
    permissions: [
      "media:search",
      "media:detail",
      "media:subscribe",
      "storage:list",
      "storage:transfer",
      "storage:organize",
      "workflow:status",
      "workflow:trigger",
      "assistant:chat",
      "assistant:mcp_invoke",
      "system:health",
    ],
    createdAt: 0,
    updatedAt: 0,
  },
  role_member: {
    id: "role_member",
    name: "标准成员 (Member)",
    description: "日常家庭成员，支持影视检索、详情查阅、订阅追剧与离线转存",
    level: ROLE_LEVELS.MEMBER,
    isSystem: true,
    permissions: [
      "media:search",
      "media:detail",
      "media:subscribe",
      "storage:list",
      "storage:transfer",
      "workflow:status",
      "assistant:chat",
    ],
    createdAt: 0,
    updatedAt: 0,
  },
  role_bot: {
    id: "role_bot",
    name: "自动化机器人 (Bot)",
    description: "专供外部下载器与自动化脚本调度，无日常交互特权",
    level: ROLE_LEVELS.BOT,
    isSystem: true,
    permissions: [
      "media:search",
      "storage:list",
      "workflow:status",
      "workflow:trigger",
    ],
    createdAt: 0,
    updatedAt: 0,
  },
  role_guest: {
    id: "role_guest",
    name: "受限访客 (Guest)",
    description: "纯只读访客，仅允许浏览搜索影片与系统状态，禁止转存或删除",
    level: ROLE_LEVELS.GUEST,
    isSystem: true,
    permissions: [
      "media:search",
      "media:detail",
      "system:health",
    ],
    createdAt: 0,
    updatedAt: 0,
  },
};

/**
 * 校验授权委托边界：申请为 API Key 赋予的权限必须严格是授予者角色权限的子集 (Subset Invariance Theorem)
 */
export function validateDelegationBoundary(
  actorPermissions: string[],
  requestedPermissions: string[],
): { allowed: boolean; violations: string[] } {
  const actorSet = new Set(actorPermissions);
  if (actorSet.has("*")) {
    return { allowed: true, violations: [] };
  }

  const violations = requestedPermissions.filter((p) => !actorSet.has(p));
  return {
    allowed: violations.length === 0,
    violations,
  };
}

/**
 * 校验分级管理权限：操作者能否管理目标用户 (对标 UserAdministrationPolicy.CanManage)
 */
export function canManageUser(actorLevel: number, targetLevel: number): boolean {
  if (actorLevel <= ROLE_LEVELS.OWNER) return true;
  return actorLevel < targetLevel;
}

/**
 * 校验角色分发权限：操作者能否将指定角色赋予其他用户 (对标 UserAdministrationPolicy.CanGrantRole)
 */
export function canGrantRole(actorLevel: number, roleToGrantLevel: number): boolean {
  if (actorLevel <= ROLE_LEVELS.OWNER) return true;
  return actorLevel < roleToGrantLevel;
}

/**
 * 计算 API Key 的运行时有效权限（Key 声明权限与用户当前角色权限求交集，提供双保险防御）
 */
export function calculateEffectivePermissions(
  keyPermissions: string[],
  userRolePermissions: string[],
): string[] {
  const roleSet = new Set(userRolePermissions);
  if (roleSet.has("*")) {
    return [...keyPermissions];
  }

  const keySet = new Set(keyPermissions);
  if (keySet.has("*")) {
    return [...userRolePermissions];
  }

  return keyPermissions.filter((p) => roleSet.has(p));
}

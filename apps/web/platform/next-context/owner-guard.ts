import { NextResponse, type NextRequest } from "next/server";
import {
  resolveSecurityContext,
  requireApiAccount,
  type SecurityContext,
} from "./auth-chain";

/**
 * 站长专属能力守卫。
 *
 * 与 `requirePermission` 的分工：那一层问「你的角色有没有这把钥匙」；这一层问
 * 「你是不是这个实例的站长」。两者不可互相替代：
 *
 *  - **不能只查权限点**：本需求是「只允许站长」，若用一个权限点（比如
 *    `storage:transfer`）来表达，成员本来就有这把钥匙（2026-11-15 决策 2 保留
 *    「发起获取」）；若用一个新权限点，站长自建的自定义角色也能被授到它。
 *  - **不能被通配符免**：`permissions.has("*")` 对站长恒真，但自定义角色也可以
 *    带 `*`。判断只认 `is_owner` 位（单用户实例即站长）。
 *
 * 判据与 `page-permission-guard.ts` 的 `access.isOwner`、`auth-chain.ts` 的
 * `isMaster` 同源：`isMaster` 是「role_owner 或带 *」，比 is_owner 位宽一点；
 * 这里刻意用更窄的那个——`isMaster` 会让「通配符自定义角色」也过关。
 *
 * 页面侧另有 `decidePageAccess(await resolvePageAccess(), …)` 的 isOwner 短路，
 * 两条路径读同一个 `is_owner` 位，不存在第二套硬编码例外。
 */
export interface OwnerGate extends SecurityContext {
  /** 恒为 true（类型上让调用方不必再判）。 */
  isOwner: true;
}

function isOwnerContext(sec: SecurityContext): boolean {
  // isMaster 由 auth-chain 计算为「role_owner 或 permissions 含 *」；role_owner
  // 是站长角色的 id。二者同时成立才是站长。
  return sec.roleId === "role_owner" && sec.isMaster;
}

/**
 * 要求请求方是站长。未登录 401；已登录但不是站长 403。
 *
 * API Key 请求一律拒绝：即便 key 的主人恰好是站长，站长专属能力也不该通过
 * 一枚可复制、可转授的 bearer 令牌开放——那是权限收敛最大的漏点。
 */
export async function requireOwner(request: NextRequest): Promise<OwnerGate | NextResponse> {
  const sec = await resolveSecurityContext(request);
  if (!sec) {
    return NextResponse.json({ error: "未登录，请先登录后再操作。" }, { status: 401 });
  }
  if (sec.apiKeyId) {
    return NextResponse.json(
      { error: "Forbidden: 站长专属功能不接受 API Key 调用。" },
      { status: 403 },
    );
  }
  if (!isOwnerContext(sec)) {
    return NextResponse.json(
      { error: "权限不足：此功能仅限站长使用。" },
      { status: 403 },
    );
  }
  return { ...sec, isOwner: true };
}

/** 页面侧同源判定：当前访问者是否站长（单用户实例恒为真）。 */
export async function requireOwnerAccountId(request: NextRequest): Promise<string | NextResponse> {
  const gate = await requireOwner(request);
  if (gate instanceof NextResponse) return gate;
  return gate.accountId;
}

/** 供测试与页面复用：一段 SecurityContext 是否算站长。 */
export function contextIsOwner(sec: Pick<SecurityContext, "roleId" | "isMaster" | "apiKeyId">): boolean {
  if (sec.apiKeyId) return false;
  return sec.roleId === "role_owner" && sec.isMaster;
}

// 显式再导出，让调用方只 import 一个模块就能拿到登录链与站长链。
export { requireApiAccount };

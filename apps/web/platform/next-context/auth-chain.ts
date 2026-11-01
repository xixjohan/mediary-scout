import { NextResponse, type NextRequest } from "next/server";
import {
  DEFAULT_ACCOUNT_ID,
  SESSION_COOKIE_NAME,
  hasLoginPassword,
  isMultiUserEnabled,
  isRemoteRequest,
  resolveBearerAccountId,
  resolveSessionAccountId,
} from "../../lib/workflow-runtime";
import {
  isForbiddenApiKeyPath,
  calculateEffectivePermissions,
} from "@media-track/shared";
import {
  getApiKeyV2Store,
  getUserManagementService,
} from "../../composition/runtime-container";

export { isMultiUserEnabled };

export interface SecurityContext {
  accountId: string;
  isMaster: boolean; // 是否持有最高站长特权
  roleId: string;
  permissions: Set<string>;
  apiKeyId?: string;
}

/**
 * 从请求中直通解析 API Key V2 上下文
 */
async function resolveDirectV2KeyContext(
  request: NextRequest,
): Promise<{ accountId: string; apiKeyId: string; permissions: Set<string>; roleId: string } | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(msk_live_[a-zA-Z0-9_-]+)$/i);
  if (!match) return null;

  const rawToken = match[1]!;

  // 物理防提权隔离墙：严禁任何 API Key 访问管理端点
  const pathname = request.nextUrl?.pathname || "";
  if (isForbiddenApiKeyPath(pathname)) {
    return null;
  }

  try {
    const keyStore = getApiKeyV2Store();
    const keyEntity = await keyStore.findKeyByPlainToken(rawToken);
    if (!keyEntity) return null;

    const accountId = keyEntity.userId || DEFAULT_ACCOUNT_ID;
    const userSvc = getUserManagementService();

    // 检查账户安全版本号 (定理三：安全版本号级联失效)
    const currentVersion = await userSvc.getUserSecurityVersion(accountId);
    if (
      keyEntity.ownerSecurityVersion !== undefined &&
      keyEntity.ownerSecurityVersion !== null &&
      keyEntity.ownerSecurityVersion < currentVersion
    ) {
      return null;
    }

    // 检查账号激活状态
    const isActive = await userSvc.isUserActive(accountId);
    if (!isActive) return null;

    // 运行时动态交集求值 (定理四：双保险防御)
    const role = await userSvc.getUserRole(accountId);
    const effectivePerms = calculateEffectivePermissions(keyEntity.permissions, role.permissions);

    return {
      accountId,
      apiKeyId: keyEntity.id,
      roleId: role.id,
      permissions: new Set(effectivePerms),
    };
  } catch {
    return null;
  }
}

async function resolveCookieContext(cookie: string): Promise<SecurityContext | null> {
  try {
    const accountId = await resolveSessionAccountId(cookie);
    if (!accountId || (!isMultiUserEnabled() && accountId !== DEFAULT_ACCOUNT_ID)) {
      return null;
    }
    const userSvc = getUserManagementService();
    const [role, isActive] = await Promise.all([
      userSvc.getUserRole(accountId),
      userSvc.isUserActive(accountId),
    ]);
    if (!isActive) return null;

    const isMaster = role.id === "role_owner" || role.permissions.includes("*");
    return {
      accountId,
      isMaster,
      roleId: role.id,
      permissions: new Set(role.permissions),
    };
  } catch {
    return null;
  }
}

async function resolveBearerContext(headers: Headers): Promise<SecurityContext | null> {
  const bearerAccountId = await resolveBearerAccountId(headers);
  if (!bearerAccountId || (!isMultiUserEnabled() && bearerAccountId !== DEFAULT_ACCOUNT_ID)) {
    return null;
  }
  const userSvc = getUserManagementService();
  const role = await userSvc.getUserRole(bearerAccountId);
  return {
    accountId: bearerAccountId,
    isMaster: role.id === "role_owner",
    roleId: role.id,
    permissions: new Set(role.permissions),
  };
}

async function resolveLanFallbackContext(headers: Headers): Promise<SecurityContext | null> {
  if (isMultiUserEnabled() || isRemoteRequest(headers)) return null;
  if ((await hasLoginPassword()) === true) return null;

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    isMaster: true,
    roleId: "role_owner",
    permissions: new Set(["*"]),
  };
}

/**
 * 解析完整安全上下文 (SecurityContext)
 */
export async function resolveSecurityContext(request: NextRequest): Promise<SecurityContext | null> {
  // 1. 直通 API Key V2 校验
  const v2Ctx = await resolveDirectV2KeyContext(request);
  if (v2Ctx) {
    return {
      accountId: v2Ctx.accountId,
      isMaster: false,
      roleId: v2Ctx.roleId,
      permissions: v2Ctx.permissions,
      apiKeyId: v2Ctx.apiKeyId,
    };
  }

  // 2. Cookie 会话校验 (Web 端登录用户)
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (cookie) {
    const cookieCtx = await resolveCookieContext(cookie);
    if (cookieCtx) return cookieCtx;
  }

  // 3. 兼容旧版 JWT Bearer
  const bearerCtx = await resolveBearerContext(request.headers);
  if (bearerCtx) return bearerCtx;

  // 4. 单用户局域网免密回退
  return resolveLanFallbackContext(request.headers);
}

/**
 * /api 认证责任链：解析请求的账号；无法认证返回 null。永不抛异常。
 */
export async function resolveApiAccount(request: NextRequest): Promise<string | null> {
  const sec = await resolveSecurityContext(request);
  return sec ? sec.accountId : null;
}

const UNAUTHORIZED_MESSAGE = "未登录，请先登录后再操作。";

export async function requireApiAccount(
  request: NextRequest,
): Promise<string | NextResponse> {
  const accountId = await resolveApiAccount(request);
  if (!accountId) {
    return NextResponse.json({ error: UNAUTHORIZED_MESSAGE }, { status: 401 });
  }
  return accountId;
}

/**
 * 细粒度声明式端点权限断言守卫
 */
export async function requirePermission(
  request: NextRequest,
  requiredPermission: string,
): Promise<SecurityContext | NextResponse> {
  const sec = await resolveSecurityContext(request);
  if (!sec) {
    return NextResponse.json({ error: UNAUTHORIZED_MESSAGE }, { status: 401 });
  }

  if (sec.isMaster || sec.permissions.has("*") || sec.permissions.has(requiredPermission)) {
    return sec;
  }

  return NextResponse.json(
    { error: `权限不足：缺少 [${requiredPermission}] 访问权限。` },
    { status: 403 },
  );
}

import { NextResponse, type NextRequest } from "next/server";
import {
  DEFAULT_ACCOUNT_ID,
  SESSION_COOKIE_NAME,
  hasLoginPassword,
  isMultiUserEnabled,
  isRemoteRequest,
  resolveBearerAccountId,
  resolveSessionAccountId,
  getWorkflowRepository,
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
  allowApi?: boolean;
  allowMcp?: boolean;
}

/**
 * 从请求中直通解析 API Key V2 上下文
 */
async function resolveDirectV2KeyContext(
  request: NextRequest,
): Promise<{
  accountId: string;
  apiKeyId: string;
  isMaster: boolean;
  permissions: Set<string>;
  roleId: string;
  allowApi: boolean;
  allowMcp: boolean;
} | null> {
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
    const isAccountOwner = await resolveAccountIsOwner(accountId);
    const role = await userSvc.getUserRole(accountId, isAccountOwner);
    const effectivePerms = calculateEffectivePermissions(keyEntity.permissions, role.permissions);

    return {
      accountId,
      apiKeyId: keyEntity.id,
      isMaster: isAccountOwner && keyEntity.permissions.includes("*"),
      roleId: role.id,
      permissions: new Set(effectivePerms),
      allowApi: keyEntity.allowApi !== false,
      allowMcp: keyEntity.allowMcp !== false,
    };
  } catch {
    return null;
  }
}

async function resolveCookieContext(cookie: string, headers: Headers): Promise<SecurityContext | null> {
  try {
    const rawAccountId = await resolveSessionAccountId(cookie);
    if (!rawAccountId) {
      return null;
    }
    let accountId = rawAccountId;
    if (!isMultiUserEnabled()) {
      if (isRemoteRequest(headers)) {
        if (rawAccountId !== DEFAULT_ACCOUNT_ID) return null;
      } else {
        accountId = DEFAULT_ACCOUNT_ID;
      }
    }
    const userSvc = getUserManagementService();
    // isOwner 必须传进去：`getUserRole()` 的兜底角色在 ownerFallback=false 时是
    // role_member。单用户 + 已设密码的实例走这条路径，账号是 acct_default(owner)
    // 却被判成成员——权限收敛上线后，站长会把自己锁在设置页外面。
    const isAccountOwner = await resolveAccountIsOwner(accountId);
    const [role, isActive] = await Promise.all([
      userSvc.getUserRole(accountId, isAccountOwner),
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
  const rawAccountId = await resolveBearerAccountId(headers);
  if (!rawAccountId) {
    return null;
  }
  let bearerAccountId = rawAccountId;
  if (!isMultiUserEnabled()) {
    if (isRemoteRequest(headers)) {
      if (rawAccountId !== DEFAULT_ACCOUNT_ID) return null;
    } else {
      bearerAccountId = DEFAULT_ACCOUNT_ID;
    }
  }
  const userSvc = getUserManagementService();
  const role = await userSvc.getUserRole(bearerAccountId, await resolveAccountIsOwner(bearerAccountId));
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

/** 账号是否站长（`is_owner` 位）。单用户下没有角色概念，账号即站长。
 *
 *  读失败一律降级为 false（= 走 role_member 兜底，与收敛前的行为一致）：本函数只
 *  决定"角色兜底用哪个内置角色"，不该成为新的故障点——真实仓储不可用时，紧随其后
 *  的角色/设置读取同样会失败并让整个上下文为 null。 */
async function resolveAccountIsOwner(accountId: string): Promise<boolean> {
  if (!isMultiUserEnabled()) return true;
  try {
    const account = await getWorkflowRepository().getAccountById?.(accountId);
    return account?.isOwner ?? false;
  } catch {
    return false;
  }
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
      allowApi: v2Ctx.allowApi,
      allowMcp: v2Ctx.allowMcp,
    };
  }

  // 2. Cookie 会话校验 (Web 端登录用户)
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (cookie) {
    const cookieCtx = await resolveCookieContext(cookie, request.headers);
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
  const sec = await resolveSecurityContext(request);
  if (!sec) {
    return NextResponse.json({ error: UNAUTHORIZED_MESSAGE }, { status: 401 });
  }
  if (sec.apiKeyId && sec.allowApi === false) {
    return NextResponse.json({ error: "Forbidden: 当前 API Key 未开放 REST API 访问通道。" }, { status: 403 });
  }
  return sec.accountId;
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

  if (sec.apiKeyId && sec.allowApi === false) {
    return NextResponse.json({ error: "Forbidden: 当前 API Key 未开放 REST API 访问通道。" }, { status: 403 });
  }

  if (sec.isMaster || sec.permissions.has("*") || sec.permissions.has(requiredPermission)) {
    return sec;
  }

  return NextResponse.json(
    { error: `权限不足：缺少 [${requiredPermission}] 访问权限。` },
    { status: 403 },
  );
}

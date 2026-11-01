import { NextResponse, type NextRequest } from "next/server";
import {
  isForbiddenApiKeyPath,
  ApiKeyPermissionPreset,
  verifyToken,
} from "@media-track/shared";
import { isMultiUserEnabled } from "./auth-chain";
import { parseBearerToken } from "./bearer-scheme";
import {
  DEFAULT_ACCOUNT_ID,
  SESSION_COOKIE_NAME,
  isRemoteRequest,
  hasLoginPassword,
  resolveSessionAccountId,
  getJwtSecret,
} from "./workflow-runtime";
import { getApiKeyV2Store } from "../composition/runtime-container";
import { WriteBehindApiKeyTouchBuffer } from "@media-track/workflow";

// Write-Behind Buffer 异步防抖写回缓存：避免高并发 API 请求下频繁写 SQLite 导致数据库排他锁死
let globalTouchBuffer: WriteBehindApiKeyTouchBuffer | null = null;

function getGlobalTouchBuffer(): WriteBehindApiKeyTouchBuffer {
  if (!globalTouchBuffer) {
    globalTouchBuffer = new WriteBehindApiKeyTouchBuffer(getApiKeyV2Store(), 10_000);
  }
  return globalTouchBuffer;
}

export function touchApiKeyAsync(keyId: string): void {
  try {
    getGlobalTouchBuffer().touch(keyId);
  } catch {
    // ignore
  }
}

export interface RequestAuthContext {
  accountId: string | null;
  tokenType: "AdminSession" | "ApiKey" | "Anonymous";
  keyId?: string | undefined;
  permissions?: string[] | undefined;
}

async function resolveSessionAuth(request: NextRequest): Promise<RequestAuthContext | null> {
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) return null;
  try {
    const accountId = await resolveSessionAccountId(cookie);
    if (accountId) {
      return {
        accountId,
        tokenType: "AdminSession",
        permissions: ["*"],
      };
    }
  } catch {
    // ignore
  }
  return null;
}

async function resolveTokenAuth(tokenCandidate: string): Promise<RequestAuthContext | null> {
  // 1. 尝试解析为 JWT
  try {
    const secret = await getJwtSecret();
    const claims = await verifyToken(tokenCandidate, secret);
    if (claims.sub) {
      return {
        accountId: claims.sub,
        tokenType: claims.tokenType || "ApiKey",
        keyId: claims.keyId,
        permissions: claims.permissions || ["*"],
      };
    }
  } catch {
    // 不是合法的 JWT
  }

  // 2. 尝试原生 API Key 直传
  try {
    const store = getApiKeyV2Store();
    const entity = await store.findKeyByPlainToken(tokenCandidate);
    if (entity) {
      touchApiKeyAsync(entity.id);
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        tokenType: "ApiKey",
        keyId: entity.id,
        permissions: entity.permissions,
      };
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * 全面解析当前请求的认证上下文，区分管理员 Session 与子权限 API Key
 */
export async function resolveRequestAuth(request: NextRequest): Promise<RequestAuthContext> {
  // 1. Session Cookie (浏览器管理员控制台)
  const sessionAuth = await resolveSessionAuth(request);
  if (sessionAuth) return sessionAuth;

  // 2. Authorization Header 或 X-Api-Key Header
  const authHeader = request.headers.get("authorization");
  const xApiKey = request.headers.get("x-api-key");
  const bearerToken = parseBearerToken(authHeader);
  const tokenCandidate = bearerToken || (xApiKey ? xApiKey.trim() : null);

  if (tokenCandidate) {
    const tokenAuth = await resolveTokenAuth(tokenCandidate);
    if (tokenAuth) return tokenAuth;
  }

  // 3. 本地局域网无密码免密访问
  if (!isMultiUserEnabled() && !isRemoteRequest(request.headers)) {
    if ((await hasLoginPassword()) !== true) {
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        tokenType: "AdminSession",
        permissions: ["*"],
      };
    }
  }

  return {
    accountId: null,
    tokenType: "Anonymous",
  };
}

/**
 * 校验 API 访问授权与路径黑名单防护（防止 API Key 提权访问管理端点）
 */
export async function enforceApiAuth(
  request: NextRequest,
  requiredPermission?: string
): Promise<{ accountId: string } | NextResponse> {
  const auth = await resolveRequestAuth(request);

  if (!auth.accountId || auth.tokenType === "Anonymous") {
    return NextResponse.json({ error: "未登录，请先登录后再操作。" }, { status: 401 });
  }

  // 防提权硬拦截：API Key 绝对禁止访问管理端点
  if (auth.tokenType === "ApiKey") {
    const pathname = request.nextUrl.pathname;
    if (isForbiddenApiKeyPath(pathname)) {
      return NextResponse.json(
        { error: "403 Forbidden: API Key 无权访问管理或安全配置端点" },
        { status: 403 }
      );
    }

    // 细粒度权限校验
    if (requiredPermission) {
      const hasPerm = ApiKeyPermissionPreset.hasPermission(
        auth.permissions || [],
        requiredPermission
      );
      if (!hasPerm) {
        return NextResponse.json(
          { error: `403 Forbidden: API Key 缺少必要权限 [${requiredPermission}]` },
          { status: 403 }
        );
      }
    }
  }

  return { accountId: auth.accountId };
}

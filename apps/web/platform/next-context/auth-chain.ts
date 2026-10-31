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

export { isMultiUserEnabled };

/**
 * /api 认证责任链：解析请求的账号；无法认证返回 null。永不抛异常。
 */
export async function resolveApiAccount(request: NextRequest): Promise<string | null> {
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (cookie) {
    try {
      const accountId = await resolveSessionAccountId(cookie);
      if (accountId) {
        if (isMultiUserEnabled()) return accountId;
        if (accountId === DEFAULT_ACCOUNT_ID) return accountId;
      }
    } catch {
      // 读不到 ≠ 认证失败，继续问别的通道
    }
  }

  const bearerAccountId = await resolveBearerAccountId(request.headers);
  if (bearerAccountId) {
    if (isMultiUserEnabled()) return bearerAccountId;
    if (bearerAccountId === DEFAULT_ACCOUNT_ID) return bearerAccountId;
  }

  if (!isMultiUserEnabled() && !isRemoteRequest(request.headers)) {
    if ((await hasLoginPassword()) !== true) return DEFAULT_ACCOUNT_ID;
  }
  return null;
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

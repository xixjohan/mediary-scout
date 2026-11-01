import { cache } from "react";
import {
  getWorkflowRepository,
  registerCurrentAccountIdProvider,
} from "../../composition/runtime-container";
import {
  DEFAULT_ACCOUNT_ID,
  SESSION_COOKIE_NAME,
  UNAUTHENTICATED_ACCOUNT_ID,
  UnauthenticatedAccountError,
} from "../../features/auth/contracts/auth-tokens";
import { isRemoteRequest } from "../../features/auth/core/identity-resolver";
import {
  hasLoginPassword,
  resolveBearerAccountId,
  resolveSessionAccountId,
} from "../../features/auth/application/account-service";

async function readSessionAccountId(sessionCookie: string | undefined): Promise<string | null> {
  if (!sessionCookie) return null;
  try {
    return await resolveSessionAccountId(sessionCookie);
  } catch {
    return null;
  }
}

async function bearerAccountFromRequestScope(): Promise<string | null> {
  let requestHeaders: Headers | undefined;
  try {
    const { headers } = await import("next/headers");
    requestHeaders = await headers();
  } catch {
    return null;
  }
  return resolveBearerAccountId(requestHeaders);
}

export async function getCurrentAccountId(): Promise<string> {
  let store: Awaited<ReturnType<typeof import("next/headers").cookies>> | undefined;
  let hdrs: Headers | undefined;
  try {
    const { cookies, headers } = await import("next/headers");
    store = await cookies();
    hdrs = await headers();
  } catch {
    return DEFAULT_ACCOUNT_ID;
  }

  // 1. Session Cookie 解析
  try {
    const raw = store?.get(SESSION_COOKIE_NAME)?.value;
    if (raw) {
      const sessionAccountId = await readSessionAccountId(raw);
      if (sessionAccountId) return sessionAccountId;
    }
  } catch {}

  // 2. Bearer Token 解析
  const bearerAccount = await bearerAccountFromRequestScope();
  if (bearerAccount) return bearerAccount;

  // 3. 局域网开箱免密自适应（内网且未设密时，默认对标站长默认账号）
  if (hdrs && !isRemoteRequest(hdrs) && !(await hasLoginPassword())) {
    return DEFAULT_ACCOUNT_ID;
  }

  return UNAUTHENTICATED_ACCOUNT_ID;
}

export async function requireAuthenticatedAccountId(): Promise<string> {
  const accountId = await getCurrentAccountId();
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) {
    throw new UnauthenticatedAccountError();
  }
  return accountId;
}

export const getCurrentAccountSummary = cache(
  async (): Promise<{ username: string; isOwner: boolean } | null> => {
    const accountId = await getCurrentAccountId();
    if (accountId === UNAUTHENTICATED_ACCOUNT_ID) return null;
    const acct = await getWorkflowRepository().getAccountById(accountId);
    return acct ? { username: acct.username, isOwner: Boolean(acct.isOwner) } : null;
  },
);

registerCurrentAccountIdProvider(getCurrentAccountId);

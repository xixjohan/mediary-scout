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
import {
  isRemoteRequest,
  resolveSingleUserAccountId,
} from "../../features/auth/core/identity-resolver";
import {
  hasLoginPassword,
  isMultiUserEnabled,
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

async function resolveSingleUserCurrentAccount(): Promise<string> {
  const hasPassword = await hasLoginPassword();
  let hdrs: Headers | undefined;
  let sessionCookie: string | undefined;
  try {
    const nextHeaders = await import("next/headers");
    if (typeof nextHeaders.headers === "function") {
      hdrs = await nextHeaders.headers();
    }
    if (typeof nextHeaders.cookies === "function") {
      sessionCookie = (await nextHeaders.cookies()).get(SESSION_COOKIE_NAME)?.value;
    }
  } catch {
    return DEFAULT_ACCOUNT_ID;
  }
  if (!hdrs) {
    return DEFAULT_ACCOUNT_ID;
  }
  const sessionAccountId = await readSessionAccountId(sessionCookie);
  if (!isRemoteRequest(hdrs)) {
    return resolveSingleUserAccountId({ hasPassword, isRemote: false, sessionAccountId });
  }
  const bearerAccountId = await resolveBearerAccountId(hdrs);
  if (bearerAccountId === DEFAULT_ACCOUNT_ID) return bearerAccountId;
  return resolveSingleUserAccountId({ hasPassword, isRemote: true, sessionAccountId });
}

export async function getCurrentAccountId(): Promise<string> {
  if (!isMultiUserEnabled()) {
    return resolveSingleUserCurrentAccount();
  }

  let store: Awaited<ReturnType<typeof import("next/headers").cookies>> | undefined;
  try {
    const { cookies } = await import("next/headers");
    store = await cookies();
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

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

export async function getCurrentAccountId(): Promise<string> {
  if (!isMultiUserEnabled()) {
    const hasPassword = await hasLoginPassword();
    let hdrs: Headers;
    let sessionCookie: string | undefined;
    try {
      const { cookies, headers } = await import("next/headers");
      hdrs = await headers();
      sessionCookie = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    } catch {
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

  let store: Awaited<ReturnType<typeof import("next/headers").cookies>>;
  try {
    const { cookies } = await import("next/headers");
    store = await cookies();
  } catch {
    return DEFAULT_ACCOUNT_ID;
  }

  try {
    const raw = store.get(SESSION_COOKIE_NAME)?.value;
    if (raw) {
      const sessionAccountId = await readSessionAccountId(raw);
      if (sessionAccountId) return sessionAccountId;
    }
    return (await bearerAccountFromRequestScope()) ?? UNAUTHENTICATED_ACCOUNT_ID;
  } catch {
    return UNAUTHENTICATED_ACCOUNT_ID;
  }
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
    const acct = await getWorkflowRepository().getAccountById(await getCurrentAccountId());
    return acct ? { username: acct.username, isOwner: acct.isOwner } : null;
  },
);

registerCurrentAccountIdProvider(getCurrentAccountId);

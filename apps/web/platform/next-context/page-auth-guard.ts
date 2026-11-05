import { createElement } from "react";
import type { LoginPasswordState } from "../../features/auth/contracts/auth-tokens";
import { ClientLoginRedirect } from "../../features/auth/components/client-login-redirect";

export const PAGE_GUARD_COOKIE = "mt_page_guarded";

export type PageAuthGuardInput = {
  guarded: boolean;
  passwordState: LoginPasswordState;
  hasSession: boolean;
};

export function shouldRedirectToLogin(input: PageAuthGuardInput): boolean {
  if (!input.guarded) return false;
  if (input.hasSession) return false;
  return input.passwordState === true;
}

export async function checkPageLoginNeeded(): Promise<boolean> {
  const { cookies } = await import("next/headers");
  const runtime = await import("../../lib/workflow-runtime");
  const { hasLoginPassword, SESSION_COOKIE_NAME } = runtime;
  let guarded = false;
  let hasSession = false;
  let passwordState: LoginPasswordState = "unknown";
  try {
    const store = await cookies();
    guarded = Boolean(store.get(PAGE_GUARD_COOKIE)?.value);
    if (!guarded) {
      try {
        const { headers } = await import("next/headers");
        const hdrs = await headers();
        guarded = hdrs.get("x-page-guarded") === "1";
      } catch {
        // dynamic headers read outside request scope fallback
      }
    }
    if (!guarded) return false;

    const rawSession = store.get(SESSION_COOKIE_NAME)?.value;
    if (rawSession) {
      if (typeof runtime.resolveSessionAccountId === "function") {
        const sessionAccount = await runtime.resolveSessionAccountId(rawSession).catch(() => null);
        hasSession = Boolean(sessionAccount);
      } else {
        hasSession = true;
      }
    } else {
      hasSession = false;
    }

    passwordState = await hasLoginPassword();

    // 权威跨层校验：若当前数据层 getCurrentAccountId 返回哨兵账号，说明即使请求携带 Cookie 也是过期或失效的，必须强制重定向
    if (typeof runtime.getCurrentAccountId === "function" && typeof runtime.UNAUTHENTICATED_ACCOUNT_ID !== "undefined") {
      const currentAccount = await runtime.getCurrentAccountId().catch(() => null);
      if (currentAccount === runtime.UNAUTHENTICATED_ACCOUNT_ID) {
        hasSession = false;
      }
    }
  } catch {
    return false;
  }
  return shouldRedirectToLogin({ guarded, passwordState, hasSession });
}

export async function requirePageLogin(): Promise<void> {
  const needed = await checkPageLoginNeeded();
  if (needed) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
  }
}

export function PageLoginRedirect({ target = "/login" }: { target?: string } = {}) {
  return createElement(ClientLoginRedirect, { target });
}

export async function PageLoginGuard() {
  const needed = await checkPageLoginNeeded();
  if (needed) {
    return PageLoginRedirect();
  }
  return null;
}

import type { LoginPasswordState } from "../../features/auth/contracts/auth-tokens";

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

export async function requirePageLogin(): Promise<void> {
  const { cookies } = await import("next/headers");
  const { redirect } = await import("next/navigation");
  const { hasLoginPassword, SESSION_COOKIE_NAME } = await import("../../lib/workflow-runtime");
  let guarded = false;
  let hasSession = false;
  let passwordState: LoginPasswordState = "unknown";
  try {
    const store = await cookies();
    guarded = Boolean(store.get(PAGE_GUARD_COOKIE)?.value);
    if (!guarded) return;
    hasSession = Boolean(store.get(SESSION_COOKIE_NAME)?.value);
    passwordState = await hasLoginPassword();
  } catch {
    return;
  }
  if (shouldRedirectToLogin({ guarded, passwordState, hasSession })) {
    redirect("/login");
  }
}

export async function PageLoginGuard() {
  await requirePageLogin();
  return null;
}

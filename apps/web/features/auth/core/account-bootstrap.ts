import { DEFAULT_ACCOUNT_ID, type Account } from "@media-track/workflow";

/** No account has set a password yet → the instance is unclaimed. */
function noneClaimed(accounts: Account[]): boolean {
  return accounts.every((a) => a.passwordHash === "");
}

/**
 * First registration on an unclaimed instance ADOPTS the seeded acct_default
 * (keeps its existing library + drives); otherwise create a fresh account.
 */
export function resolveRegistration(accounts: Account[]): { kind: "adopt-default" } | { kind: "create-new" } {
  const def = accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID);
  if (noneClaimed(accounts) && def && def.passwordHash === "") {
    return { kind: "adopt-default" };
  }
  return { kind: "create-new" };
}

/**
 * Drives the /login claim screen. `needsClaim` = nobody has claimed the instance
 * yet; `hasExistingLibrary` = the default account already owns tracked data.
 */
export function deriveBootstrapState(
  accounts: Account[],
  libraryItemCount: number,
): { needsClaim: boolean; hasExistingLibrary: boolean } {
  return { needsClaim: noneClaimed(accounts), hasExistingLibrary: libraryItemCount > 0 };
}

/** Only the owner may manage other accounts (reset passwords, view the panel). */
export function canManageAccounts(account: Account | null): boolean {
  return Boolean(account?.isOwner);
}

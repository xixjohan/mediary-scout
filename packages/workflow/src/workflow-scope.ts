import { DEFAULT_ACCOUNT_ID } from "./domain.js";

/** The data partition key for the multi-drive tree model: an account (identity)
 *  plus the specific connected storage (workspace). `connectedStorageId` may be
 *  null for unscoped/legacy reads — before backfill, and for the cross-(account,
 *  storage) daily patrol that must see every drive's shows. A non-null value
 *  means "only this drive" (fail-closed isolation). */
export interface WorkflowScope {
  accountId: string;
  connectedStorageId: string | null;
}

export function scopeFromAccount(
  accountId: string,
  connectedStorageId: string | null,
): WorkflowScope {
  return { accountId, connectedStorageId };
}

/** Read methods accept either a bare accountId (legacy, account-only — no storage
 *  filter) or a full WorkflowScope. `undefined` → the default account, no filter. */
export type ScopeArg = string | WorkflowScope | undefined;

export function normalizeScope(arg: ScopeArg): WorkflowScope {
  if (arg === undefined) {
    return { accountId: DEFAULT_ACCOUNT_ID, connectedStorageId: null };
  }
  if (typeof arg === "string") {
    return { accountId: arg, connectedStorageId: null };
  }
  return arg;
}

/** True when a stored row belongs to the scope: account must match; storage only
 *  filters when the scope pins one (connectedStorageId != null). fail-closed. */
export function scopeMatches(
  scope: WorkflowScope,
  rowAccountId: string | null | undefined,
  rowStorageId: string | null | undefined,
): boolean {
  if ((rowAccountId ?? DEFAULT_ACCOUNT_ID) !== scope.accountId) {
    return false;
  }
  if (scope.connectedStorageId != null && (rowStorageId ?? null) !== scope.connectedStorageId) {
    return false;
  }
  return true;
}

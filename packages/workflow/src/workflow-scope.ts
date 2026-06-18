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

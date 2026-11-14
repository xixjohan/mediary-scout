import {
  AcquisitionLeaseLostError,
  type AcquisitionOperation,
  type AcquisitionOperationStore,
  type OperationIntent,
  type OperationStatus,
  type PersistedRunState,
} from "../persistence/acquisition-operations.js";

/**
 * A lease-bound handle on the durable side-effect ledger for one acquisition
 * scope (account × drive × work). The runner claims it once per run and releases
 * it in `finally`; the storage adapter calls begin/finish around each transfer.
 * Every write renews the lease first, so a long agent run never expires mid-flight,
 * and a taken-over lease fails loud (ACQUISITION_LEASE_LOST) instead of recording
 * a result over the new owner's state.
 */
export interface AcquisitionOperationsSession {
  readonly scope: string;
  begin(intent: OperationIntent): { created: boolean; operation: AcquisitionOperation };
  finish(operationId: string, status: OperationStatus, fileIds: string[]): void;
  saveState(state: PersistedRunState): void;
  release(): void;
}

const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;

export function claimOperationsSession(input: {
  store: AcquisitionOperationStore;
  scope: string;
  runId: string;
  attemptId: string;
  now?: () => number;
  ttlMs?: number;
}): AcquisitionOperationsSession | null {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const lease = input.store.claim(input.scope, input.runId, input.attemptId, now(), ttlMs);
  if (!lease) return null;
  const renew = (): void => {
    if (!input.store.renew(lease, now(), ttlMs)) throw new AcquisitionLeaseLostError(lease.scope);
  };
  return {
    scope: lease.scope,
    begin(intent) {
      renew();
      return input.store.begin(lease, intent, now());
    },
    finish(operationId, status, fileIds) {
      renew();
      input.store.finish(lease, operationId, status, fileIds, now());
    },
    saveState(state) {
      renew();
      input.store.saveState(lease, state, now());
    },
    release() {
      input.store.release(lease);
    },
  };
}

/** The lease's scope key: owning account × concrete drive × work. The caller
 *  resolves the drive to the connected-storage id, or the brand when the run has
 *  none (two 115 accounts are two drives; a brand-only run still isolates by account). */
export function acquisitionScope(input: { accountId: string; drive: string; titleKey: string }): string {
  return `${input.accountId}:${input.drive}:${input.titleKey}`;
}
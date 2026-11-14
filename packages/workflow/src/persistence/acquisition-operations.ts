import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const ACQUISITION_OPERATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS acquisition_leases (
  scope TEXT PRIMARY KEY,
  run_id TEXT,
  attempt_id TEXT,
  fence INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT,
  state_context TEXT
);
CREATE TABLE IF NOT EXISTS acquisition_operations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  op_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  run_id TEXT NOT NULL,
  file_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS acquisition_operations_scope_key ON acquisition_operations (scope, op_key);
`;

/** Statuses whose side effect may still be in flight at the provider. */
export const UNRESOLVED_OPERATION_STATUSES = ["intent", "accepted_pending", "unknown"] as const;
export type OperationStatus =
  | (typeof UNRESOLVED_OPERATION_STATUSES)[number]
  | "landed"
  | "instant_miss"
  | "rejected"
  | "transient_error"
  | "account_blocked";

export interface AcquisitionLease {
  scope: string;
  runId: string;
  attemptId: string;
  fence: number;
  expiresAt: number;
}

export interface OperationIntent {
  /** Side-effect key: target directory + canonical resource, NOT the requirement revision. */
  key: string;
  kind: string;
  directoryId: string;
  resourceKey: string;
  fileIds: string[];
}

export interface AcquisitionOperation {
  id: string;
  scope: string;
  key: string;
  kind: string;
  intent: OperationIntent;
  status: OperationStatus;
  runId: string;
  fileIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PersistedRunState {
  state: string;
  context: { compensations: string[]; failureReason: string | null };
}

export class AcquisitionLeaseLostError extends Error {
  constructor(scope: string) {
    super(`ACQUISITION_LEASE_LOST: ${scope}`);
  }
}

interface LeaseRow {
  scope: string;
  run_id: string | null;
  attempt_id: string | null;
  fence: number;
  expires_at: number;
  state: string | null;
  state_context: string | null;
}

interface OperationRow {
  id: string;
  scope: string;
  op_key: string;
  kind: string;
  payload: string;
  status: OperationStatus;
  run_id: string;
  file_ids: string;
  created_at: number;
  updated_at: number;
}

const UNRESOLVED_SQL = UNRESOLVED_OPERATION_STATUSES.map((s) => `'${s}'`).join(",");

function toOperation(row: OperationRow): AcquisitionOperation {
  return {
    id: row.id,
    scope: row.scope,
    key: row.op_key,
    kind: row.kind,
    intent: JSON.parse(row.payload) as OperationIntent,
    status: row.status,
    runId: row.run_id,
    fileIds: JSON.parse(row.file_ids) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Durable side-effect ledger for one acquisition scope (account × drive × work).
 * A lease with a fencing token serialises owners; every write re-checks the fence
 * inside its transaction, so a stalled owner whose lease was taken over cannot
 * record a result over the new owner's state.
 */
export class AcquisitionOperationStore {
  constructor(private readonly db: Database.Database) {
    db.exec(ACQUISITION_OPERATIONS_SCHEMA);
  }

  claim(scope: string, runId: string, attemptId: string, nowMs: number, ttlMs: number): AcquisitionLease | null {
    return this.db.transaction((): AcquisitionLease | null => {
      const row = this.leaseRow(scope);
      const expiresAt = nowMs + ttlMs;
      if (!row) {
        this.db.prepare("INSERT INTO acquisition_leases (scope, run_id, attempt_id, fence, expires_at) VALUES (?, ?, ?, 1, ?)")
          .run(scope, runId, attemptId, expiresAt);
        return { scope, runId, attemptId, fence: 1, expiresAt };
      }
      const live = row.run_id !== null && row.expires_at > nowMs;
      if (live && (row.run_id !== runId || row.attempt_id !== attemptId)) return null;
      const fence = row.fence + 1;
      this.db.prepare("UPDATE acquisition_leases SET run_id = ?, attempt_id = ?, fence = ?, expires_at = ? WHERE scope = ?")
        .run(runId, attemptId, fence, expiresAt, scope);
      return { scope, runId, attemptId, fence, expiresAt };
    }).immediate();
  }

  renew(lease: AcquisitionLease, nowMs: number, ttlMs: number): boolean {
    return this.db.transaction((): boolean => {
      if (!this.isHeld(lease, nowMs)) return false;
      lease.expiresAt = nowMs + ttlMs;
      this.db.prepare("UPDATE acquisition_leases SET expires_at = ? WHERE scope = ? AND fence = ?")
        .run(lease.expiresAt, lease.scope, lease.fence);
      return true;
    }).immediate();
  }

  /** A no-op for a lease that was already taken over: it never frees the new owner. */
  release(lease: AcquisitionLease): void {
    this.db.prepare("UPDATE acquisition_leases SET run_id = NULL, attempt_id = NULL, expires_at = 0 WHERE scope = ? AND fence = ?")
      .run(lease.scope, lease.fence);
  }

  assert(lease: AcquisitionLease, nowMs: number): void {
    if (!this.isHeld(lease, nowMs)) throw new AcquisitionLeaseLostError(lease.scope);
  }

  /**
   * Records the intent BEFORE the provider call. An existing unresolved intent for
   * the same side-effect key (any run) or a settled one from this run is returned
   * instead, with created=false — the caller must not submit again.
   */
  begin(lease: AcquisitionLease, intent: OperationIntent, nowMs: number): { created: boolean; operation: AcquisitionOperation } {
    return this.db.transaction(() => {
      this.assert(lease, nowMs);
      const existing = this.db.prepare(
        `SELECT * FROM acquisition_operations WHERE scope = ? AND op_key = ?
           AND (status IN (${UNRESOLVED_SQL}) OR run_id = ?)
         ORDER BY created_at DESC LIMIT 1`,
      ).get(lease.scope, intent.key, lease.runId) as OperationRow | undefined;
      if (existing) return { created: false, operation: toOperation(existing) };
      const row: OperationRow = {
        id: randomUUID(),
        scope: lease.scope,
        op_key: intent.key,
        kind: intent.kind,
        payload: JSON.stringify(intent),
        status: "intent",
        run_id: lease.runId,
        file_ids: "[]",
        created_at: nowMs,
        updated_at: nowMs,
      };
      this.db.prepare(
        `INSERT INTO acquisition_operations (id, scope, op_key, kind, payload, status, run_id, file_ids, created_at, updated_at)
         VALUES (@id, @scope, @op_key, @kind, @payload, @status, @run_id, @file_ids, @created_at, @updated_at)`,
      ).run(row);
      return { created: true, operation: toOperation(row) };
    }).immediate();
  }

  finish(lease: AcquisitionLease, operationId: string, status: OperationStatus, fileIds: string[], nowMs: number): void {
    this.db.transaction(() => {
      this.assert(lease, nowMs);
      this.db.prepare("UPDATE acquisition_operations SET status = ?, file_ids = ?, run_id = ?, updated_at = ? WHERE id = ? AND scope = ?")
        .run(status, JSON.stringify(fileIds), lease.runId, nowMs, operationId, lease.scope);
    }).immediate();
  }

  unresolved(scope: string): AcquisitionOperation[] {
    return (this.db.prepare(
      `SELECT * FROM acquisition_operations WHERE scope = ? AND status IN (${UNRESOLVED_SQL}) ORDER BY created_at`,
    ).all(scope) as OperationRow[]).map(toOperation);
  }

  saveState(lease: AcquisitionLease, state: PersistedRunState, nowMs: number): void {
    this.db.transaction(() => {
      this.assert(lease, nowMs);
      this.db.prepare("UPDATE acquisition_leases SET state = ?, state_context = ? WHERE scope = ? AND fence = ?")
        .run(state.state, JSON.stringify(state.context), lease.scope, lease.fence);
    }).immediate();
  }

  state(scope: string): PersistedRunState | null {
    const row = this.leaseRow(scope);
    if (!row?.state) return null;
    return { state: row.state, context: JSON.parse(row.state_context ?? "{}") as PersistedRunState["context"] };
  }

  private leaseRow(scope: string): LeaseRow | undefined {
    return this.db.prepare("SELECT * FROM acquisition_leases WHERE scope = ?").get(scope) as LeaseRow | undefined;
  }

  private isHeld(lease: AcquisitionLease, nowMs: number): boolean {
    const row = this.leaseRow(lease.scope);
    return !!row && row.fence === lease.fence && row.run_id === lease.runId && row.expires_at > nowMs;
  }
}

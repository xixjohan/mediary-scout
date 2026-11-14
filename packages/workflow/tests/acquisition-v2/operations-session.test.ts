import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AcquisitionOperationStore, AcquisitionLeaseLostError } from "../../src/persistence/acquisition-operations.js";
import { claimOperationsSession } from "../../src/acquisition-v2/operations-session.js";

const databases: Database.Database[] = [];
function store() {
  const db = new Database(":memory:");
  databases.push(db);
  return new AcquisitionOperationStore(db);
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const scope = "account:drive:title";
const intent = { key: "target:resource", kind: "transfer", directoryId: "target", resourceKey: "resource", fileIds: [] };

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("claimOperationsSession — a bound, self-renewing lease session", () => {
  it("claims a lease and exposes the scope", () => {
    const c = clock();
    const session = claimOperationsSession({ store: store(), scope, runId: "run1", attemptId: "a1", now: c.now, ttlMs: 100 })!;
    expect(session.scope).toBe(scope);
  });

  it("returns null when a live owner holds the scope", () => {
    const s = store();
    const c = clock();
    claimOperationsSession({ store: s, scope, runId: "run1", attemptId: "a1", now: c.now, ttlMs: 100 });
    expect(claimOperationsSession({ store: s, scope, runId: "run2", attemptId: "a2", now: c.now, ttlMs: 100 })).toBeNull();
  });

  it("begin creates the intent once; a repeat for the same key reuses it (created=false)", () => {
    const c = clock();
    const session = claimOperationsSession({ store: store(), scope, runId: "run1", attemptId: "a1", now: c.now, ttlMs: 100 })!;
    expect(session.begin(intent).created).toBe(true);
    expect(session.begin(intent).created).toBe(false);
  });

  it("begin refuses an unresolved intent left by another run (cross-run dedup)", () => {
    const s = store();
    const c = clock();
    const first = claimOperationsSession({ store: s, scope, runId: "run1", attemptId: "a1", now: c.now, ttlMs: 100 })!;
    first.begin(intent); // leaves status=intent (unresolved)
    first.release();
    c.advance(200);
    const second = claimOperationsSession({ store: s, scope, runId: "run2", attemptId: "a2", now: c.now, ttlMs: 100 })!;
    const reused = second.begin(intent);
    expect(reused.created).toBe(false);
    expect(reused.operation.runId).toBe("run1");
  });

  it("finish settles the operation; a later run may begin the same key again after a definitive miss", () => {
    const s = store();
    const c = clock();
    const first = claimOperationsSession({ store: s, scope, runId: "run1", attemptId: "a1", now: c.now, ttlMs: 100 })!;
    const { operation } = first.begin(intent);
    first.finish(operation.id, "instant_miss", []);
    first.release();
    c.advance(200);
    const second = claimOperationsSession({ store: s, scope, runId: "run2", attemptId: "a2", now: c.now, ttlMs: 100 })!;
    expect(second.begin(intent).created).toBe(true);
  });

  it("saveState persists the FSM snapshot for the scope", () => {
    const s = store();
    const c = clock();
    const session = claimOperationsSession({ store: s, scope, runId: "run1", attemptId: "a1", now: c.now, ttlMs: 100 })!;
    session.saveState({ state: "pollingLanding", context: { compensations: ["discardStaging"], failureReason: null } });
    expect(s.state(scope)).toEqual({ state: "pollingLanding", context: { compensations: ["discardStaging"], failureReason: null } });
  });

  it("release frees the scope for a new owner", () => {
    const s = store();
    const c = clock();
    const first = claimOperationsSession({ store: s, scope, runId: "run1", attemptId: "a1", now: c.now, ttlMs: 100 })!;
    first.release();
    expect(claimOperationsSession({ store: s, scope, runId: "run2", attemptId: "a2", now: c.now, ttlMs: 100 })).not.toBeNull();
  });

  it("auto-renews so a long run does not expire mid-transfer", () => {
    const s = store();
    const c = clock();
    const session = claimOperationsSession({ store: s, scope, runId: "run1", attemptId: "a1", now: c.now, ttlMs: 100 })!;
    c.advance(80);
    const { operation } = session.begin(intent); // renews → expires at 180
    c.advance(80); // t=160, past the original 100 but inside the renewed window
    expect(() => session.finish(operation.id, "landed", ["f1"])).not.toThrow();
  });

  it("throws ACQUISITION_LEASE_LOST once another owner takes over", () => {
    const s = store();
    const c = clock();
    const first = claimOperationsSession({ store: s, scope, runId: "run1", attemptId: "a1", now: c.now, ttlMs: 100 })!;
    c.advance(200); // first lease expired
    claimOperationsSession({ store: s, scope, runId: "run2", attemptId: "a2", now: c.now, ttlMs: 100 });
    expect(() => first.begin(intent)).toThrow(AcquisitionLeaseLostError);
  });
});
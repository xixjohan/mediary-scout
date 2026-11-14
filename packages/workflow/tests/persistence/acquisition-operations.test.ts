import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AcquisitionOperationStore } from "../../src/persistence/acquisition-operations.js";

const databases: Database.Database[] = [];
function store() {
  const db = new Database(":memory:");
  databases.push(db);
  return new AcquisitionOperationStore(db);
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const scope = "account:drive:title";
const intent = { key: "target:resource", kind: "transfer", directoryId: "target", resourceKey: "resource", fileIds: [] };

describe("acquisition operation leases and durable intent", () => {
  it("excludes live owners and fences an expired owner", () => {
    const db = store();
    const first = db.claim(scope, "run1", "attempt1", 100, 50)!;
    expect(db.claim(scope, "run2", "attempt2", 120, 50)).toBeNull();
    const second = db.claim(scope, "run2", "attempt2", 151, 50)!;
    expect(second.fence).toBeGreaterThan(first.fence);
    expect(() => db.assert(first, 152)).toThrow("ACQUISITION_LEASE_LOST");
    expect(() => db.begin(first, intent, 152)).toThrow("ACQUISITION_LEASE_LOST");
    expect(db.renew(first, 152, 50)).toBe(false);
    db.release(first);
    expect(() => db.assert(second, 153)).not.toThrow();
  });

  it("retains unresolved intent across runs and requirement revisions", () => {
    const db = store();
    const first = db.claim(scope, "run1", "attempt1", 0, 100)!;
    const created = db.begin(first, intent, 1);
    expect(created.created).toBe(true);
    db.release(first);
    const next = db.claim(scope, "run2", "attempt2", 2, 100)!;
    const reused = db.begin(next, intent, 3);
    expect(reused.created).toBe(false);
    expect(reused.operation.id).toBe(created.operation.id);
    expect(db.unresolved(scope)).toHaveLength(1);
  });

  it("keeps definitive misses run-local while allowing a later run", () => {
    const db = store();
    const first = db.claim(scope, "run1", "attempt1", 0, 100)!;
    const created = db.begin(first, intent, 1).operation;
    db.finish(first, created.id, "instant_miss", [], 2);
    expect(db.begin(first, intent, 3).created).toBe(false);
    expect(db.unresolved(scope)).toEqual([]);
    db.release(first);
    const next = db.claim(scope, "run2", "attempt2", 4, 100)!;
    expect(db.begin(next, intent, 5).created).toBe(true);
  });

  it("persists state and rejects stale completion writes", () => {
    const db = store();
    const first = db.claim(scope, "run1", "attempt1", 0, 10)!;
    const created = db.begin(first, intent, 1).operation;
    db.saveState(first, { state: "pollingLanding", context: { compensations: [], failureReason: null } }, 2);
    expect(db.state(scope)?.state).toBe("pollingLanding");
    db.claim(scope, "run2", "attempt2", 11, 100);
    expect(() => db.finish(first, created.id, "landed", ["file1"], 12)).toThrow("ACQUISITION_LEASE_LOST");
    expect(db.unresolved(scope)[0]?.status).toBe("intent");
  });

  it("isolates accounts, drives and works", () => {
    const db = store();
    for (const name of [scope, "other:drive:title", "account:other:title", "account:drive:other"]) {
      const lease = db.claim(name, "run", name, 0, 100)!;
      expect(db.begin(lease, intent, 1).created).toBe(true);
      expect(db.unresolved(name)).toHaveLength(1);
    }
  });
});

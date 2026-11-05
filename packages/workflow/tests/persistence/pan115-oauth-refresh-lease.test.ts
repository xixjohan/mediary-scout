import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteWorkflowRepository, SqliteWorkflowRepository } from "../../src/persistence/sqlite.js";

const tempDirs: string[] = [];

function createSharedRepositories(): [SqliteWorkflowRepository, SqliteWorkflowRepository, string] {
  const directory = mkdtempSync(join(tmpdir(), "pan115-refresh-lease-"));
  tempDirs.push(directory);
  const path = join(directory, "mediary.db");
  return [createSqliteWorkflowRepository({ path }), createSqliteWorkflowRepository({ path }), directory];
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite 115 OAuth refresh lease", () => {
  it("serializes refresh claims across repository connections and only lets the owner release", async () => {
    const [first, second] = createSharedRepositories();
    try {
      expect(await first.tryAcquirePan115OAuthRefreshLease("storage-1", "worker-a", 10_000, 1_000)).toBe(true);
      expect(await second.tryAcquirePan115OAuthRefreshLease("storage-1", "worker-b", 10_000, 1_001)).toBe(false);
      await second.releasePan115OAuthRefreshLease("storage-1", "worker-b");
      expect(await second.tryAcquirePan115OAuthRefreshLease("storage-1", "worker-b", 10_000, 1_002)).toBe(false);

      await first.releasePan115OAuthRefreshLease("storage-1", "worker-a");
      expect(await second.tryAcquirePan115OAuthRefreshLease("storage-1", "worker-b", 10_000, 1_003)).toBe(true);
    } finally {
      first.close();
      second.close();
    }
  });

  it("allows takeover after an abandoned lease expires", async () => {
    const [first, second] = createSharedRepositories();
    try {
      expect(await first.tryAcquirePan115OAuthRefreshLease("storage-1", "worker-a", 2_000, 1_000)).toBe(true);
      expect(await second.tryAcquirePan115OAuthRefreshLease("storage-1", "worker-b", 3_001, 2_001)).toBe(true);
    } finally {
      first.close();
      second.close();
    }
  });

  it("renews only an active lease owned by the caller", async () => {
    const [first, second] = createSharedRepositories();
    try {
      expect(await first.tryAcquirePan115OAuthRefreshLease("storage-1", "worker-a", 2_000, 1_000)).toBe(true);
      expect(await second.renewPan115OAuthRefreshLease("storage-1", "worker-b", 4_000, 1_500)).toBe(false);
      expect(await first.renewPan115OAuthRefreshLease("storage-1", "worker-a", 4_000, 1_500)).toBe(true);
      expect(await second.tryAcquirePan115OAuthRefreshLease("storage-1", "worker-b", 5_000, 3_000)).toBe(false);
    } finally {
      first.close();
      second.close();
    }
  });
});

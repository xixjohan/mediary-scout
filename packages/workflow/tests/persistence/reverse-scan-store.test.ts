import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SqliteReverseScanStore } from "../../src/persistence/sqlite/sqlite-reverse-scan.js";
import { InMemoryReverseScanStore } from "../../src/persistence/in-memory-reverse-scan.js";
import { SQLITE_SCHEMA } from "../../src/persistence/sqlite/sqlite-schema.js";
import type { SqliteDbContext } from "../../src/persistence/sqlite-context.js";

describe("ReverseScanStore (SQLite & InMemory Parity)", () => {
  function createSqliteStore() {
    const db = new Database(":memory:");
    db.exec(SQLITE_SCHEMA);
    const ctx: SqliteDbContext = {
      db,
      now: () => new Date().toISOString(),
      transaction: (fn) => db.transaction(fn),
    };
    return new SqliteReverseScanStore(ctx);
  }

  const stores = [
    { name: "SqliteReverseScanStore", create: createSqliteStore },
    { name: "InMemoryReverseScanStore", create: () => new InMemoryReverseScanStore() },
  ];

  for (const { name, create } of stores) {
    describe(name, () => {
      it("creates, queries, and updates a scan job", async () => {
        const store = create();
        const job = await store.createReverseScanJob({
          accountId: "acct_test",
          storageId: "cs_1",
          targetCid: "movies_root",
          category: "movie",
        });

        expect(job.id).toBeDefined();
        expect(job.status).toBe("queued");
        expect(job.totalFolders).toBe(0);

        const fetched = await store.getReverseScanJob(job.id);
        expect(fetched?.id).toBe(job.id);
        expect(fetched?.targetCid).toBe("movies_root");

        await store.updateReverseScanJob(job.id, {
          status: "scanning_directories",
          totalFolders: 10,
          scannedFolders: 3,
          progressPercent: 30,
          currentStepMessage: "正在扫描目录...",
        });

        const updated = await store.getReverseScanJob(job.id);
        expect(updated?.status).toBe("scanning_directories");
        expect(updated?.scannedFolders).toBe(3);
        expect(updated?.progressPercent).toBe(30);

        const jobs = await store.listReverseScanJobs("acct_test");
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.id).toBe(job.id);
      });

      it("creates, queries, and updates scan items with review statuses", async () => {
        const store = create();
        const job = await store.createReverseScanJob({
          accountId: "acct_test",
          storageId: "cs_1",
          targetCid: "movies_root",
        });

        const item1 = await store.createReverseScanItem({
          jobId: job.id,
          accountId: "acct_test",
          folderId: "dir_1",
          folderName: "奥本海默 (2023) {tmdb-872585}",
          relativePath: "奥本海默 (2023) {tmdb-872585}",
          parsedTitle: "奥本海默",
          parsedYear: 2023,
          matchedTmdbId: 872585,
          matchedMediaType: "movie",
          matchedTitle: "奥本海默",
          confidence: 100,
          reviewStatus: "auto_accepted",
        });

        const item2 = await store.createReverseScanItem({
          jobId: job.id,
          accountId: "acct_test",
          folderId: "dir_2",
          folderName: "未知老片",
          relativePath: "未知老片",
          confidence: 60,
          reviewStatus: "pending_review",
        });

        const allItems = await store.listReverseScanItems(job.id);
        expect(allItems).toHaveLength(2);

        const pendingItems = await store.listReverseScanItems(job.id, "pending_review");
        expect(pendingItems).toHaveLength(1);
        expect(pendingItems[0]?.id).toBe(item2.id);

        await store.updateReverseScanItem(item2.id, {
          reviewStatus: "user_accepted",
          matchedTmdbId: 12345,
          matchedTitle: "确认老片",
        });

        const updatedPending = await store.listReverseScanItems(job.id, "pending_review");
        expect(updatedPending).toHaveLength(0);

        const acceptedItems = await store.listReverseScanItems(job.id, "user_accepted");
        expect(acceptedItems).toHaveLength(1);
        expect(acceptedItems[0]?.matchedTitle).toBe("确认老片");
      });
    });
  }
});

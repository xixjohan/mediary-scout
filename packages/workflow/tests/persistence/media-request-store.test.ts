import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  InMemoryWorkflowRepository,
  SqliteWorkflowRepository,
  type WorkflowRepository,
} from "../../src/index.js";

interface TestRepoHarness {
  name: string;
  create: () => { repo: WorkflowRepository; cleanup?: () => void };
}

const harnesses: TestRepoHarness[] = [
  {
    name: "InMemoryWorkflowRepository",
    create: () => ({ repo: new InMemoryWorkflowRepository() }),
  },
  {
    name: "SqliteWorkflowRepository",
    create: () => {
      const db = new Database(":memory:");
      const repo = new SqliteWorkflowRepository(db);
      return { repo, cleanup: () => db.close() };
    },
  },
];

describe("MediaRequestStore (Shared Resource Mode)", () => {
  for (const { name, create } of harnesses) {
    describe(name, () => {
      it("creates, retrieves and lists media requests", async () => {
        const { repo, cleanup } = create();
        try {
          const req1 = await repo.createMediaRequest({
            accountId: "acct_alice",
            mediaTitleId: "tmdb_movie_100",
            seasonNumber: null,
            createdAt: "2026-11-01T10:00:00.000Z",
          });

          expect(req1.id).toBeDefined();
          expect(req1.accountId).toBe("acct_alice");
          expect(req1.mediaTitleId).toBe("tmdb_movie_100");
          expect(req1.seasonNumber).toBeNull();
          expect(req1.status).toBe("queued");

          const req2 = await repo.createMediaRequest({
            accountId: "acct_bob",
            mediaTitleId: "tmdb_movie_100",
            seasonNumber: null,
            createdAt: "2026-11-01T10:05:00.000Z",
          });

          const fetched = await repo.getMediaRequest(req1.id);
          expect(fetched?.id).toBe(req1.id);

          const allForMovie = await repo.listMediaRequests({ mediaTitleId: "tmdb_movie_100" });
          expect(allForMovie).toHaveLength(2);
          // Newest first
          expect(allForMovie[0]?.id).toBe(req2.id);
          expect(allForMovie[1]?.id).toBe(req1.id);

          const aliceOnly = await repo.listMediaRequests({ accountId: "acct_alice" });
          expect(aliceOnly).toHaveLength(1);
          expect(aliceOnly[0]?.accountId).toBe("acct_alice");
        } finally {
          cleanup?.();
        }
      });

      it("finds active media request and ignores inactive ones", async () => {
        const { repo, cleanup } = create();
        try {
          expect(await repo.findActiveMediaRequest("tmdb_tv_200", 1)).toBeNull();

          const req = await repo.createMediaRequest({
            accountId: "acct_alice",
            mediaTitleId: "tmdb_tv_200",
            seasonNumber: 1,
            status: "queued",
          });

          const active = await repo.findActiveMediaRequest("tmdb_tv_200", 1);
          expect(active?.id).toBe(req.id);

          // Different season should return null
          expect(await repo.findActiveMediaRequest("tmdb_tv_200", 2)).toBeNull();

          // After updating to ready, it should no longer be active
          await repo.updateMediaRequestStatus(req.id, "ready");
          expect(await repo.findActiveMediaRequest("tmdb_tv_200", 1)).toBeNull();
        } finally {
          cleanup?.();
        }
      });

      it("attaches workflow run and completes requests in batch", async () => {
        const { repo, cleanup } = create();
        try {
          const reqA = await repo.createMediaRequest({
            accountId: "acct_alice",
            mediaTitleId: "tmdb_movie_300",
            seasonNumber: null,
            status: "queued",
          });

          const reqB = await repo.createMediaRequest({
            accountId: "acct_bob",
            mediaTitleId: "tmdb_movie_300",
            seasonNumber: null,
            status: "queued",
          });

          const attached = await repo.attachWorkflowRunToRequests("tmdb_movie_300", null, "run_shared_300");
          expect(attached).toBe(2);

          const updatedA = await repo.getMediaRequest(reqA.id);
          expect(updatedA?.status).toBe("acquiring");
          expect(updatedA?.workflowRunId).toBe("run_shared_300");

          const updatedB = await repo.getMediaRequest(reqB.id);
          expect(updatedB?.status).toBe("acquiring");
          expect(updatedB?.workflowRunId).toBe("run_shared_300");

          // Complete the run
          const completed = await repo.completeMediaRequestsForRun("run_shared_300", "ready");
          expect(completed).toBe(2);

          const finalA = await repo.getMediaRequest(reqA.id);
          expect(finalA?.status).toBe("ready");
          const finalB = await repo.getMediaRequest(reqB.id);
          expect(finalB?.status).toBe("ready");
        } finally {
          cleanup?.();
        }
      });
    });
  }
});

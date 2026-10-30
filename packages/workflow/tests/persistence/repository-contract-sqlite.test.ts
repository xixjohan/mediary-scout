import { describe, it, expect } from "vitest";
import { createSqliteWorkflowRepository, SqliteWorkflowRepository } from "../../src/persistence/sqlite.js";
import { runRepositoryContract } from "../fixtures/repository-contract.js";
import { workflowPersistenceFixture } from "../fixtures/workflow-fixtures.js";

// Use an in-memory DB per repo: the contract needs a fresh empty store, not file
// semantics, so ":memory:" avoids leaving hundreds of /tmp/ms-sqlite-* dirs behind.
// (better-sqlite3 gives each connection its own private in-memory database.)
function makeSqliteRepo(): SqliteWorkflowRepository {
  return createSqliteWorkflowRepository({ path: ":memory:" });
}

runRepositoryContract("SQLite", {
  make: makeSqliteRepo,
  teardown: (repo) => {
    (repo as SqliteWorkflowRepository).close();
  },
  // 批次 5：把一个策略列的存盘值改坏，证明「损坏的行抛错而不是降解成没有策略」。
  // 这是真库上的证据：内存实现无处可改，所以这条只在 SQLite harness 下真正生效。
  corruptSubscriptionPolicy: (repo, accountId, titleKey, column, raw) => {
    (repo as SqliteWorkflowRepository).exec(
      `UPDATE subscription_policies SET ${column} = ? WHERE account_id = ? AND title_key = ?`,
      raw, accountId, titleKey,
    );
  },
});

// SQLite-specific: the shared contract can't assert nextAttemptAt gating because the
// InMemory oracle intentionally does NOT gate (pure FIFO), while the DBs do
// (via claimableQueuedRuns). This locks the PRODUCTION engine's gate directly — and, more
// SQLite-specifically, proves nextAttemptAt survives the JSON *text* payload round-trip so
// the gate can actually see it.
/**
 * 批次 5：**旧形状的库必须被补上 last_taken_at 列**。
 *
 * 这不是假想的风险：本批次先提了 subscription_policies 表（无 last_taken_at），
 * 再提了列。任何在这两个提交之间启过的库（包括 data/mediary.db 这样的生产卷）
 * 都处于这个状态，而 CREATE TABLE IF NOT EXISTS 对已存在的表是空操作。
 *
 * 不补的后果有两层，都是静黙的：
 *   · 读：row.last_taken_at 是 undefined，lastTakenAt 不是 null —— withinCooldown 对读不出的
 *     时间戳 fail-open，冷却永远不触发。
 *   · 写：UPDATE ... SET last_taken_at 报 no such column，一次成功入库之后的巡检直接崩。
 */
describe("SQLite upgrades a subscription_policies table that predates last_taken_at", () => {
  const OLD_SHAPE = `
    CREATE TABLE IF NOT EXISTS subscription_policies (
      account_id text NOT NULL,
      title_key text NOT NULL,
      must_contain text NOT NULL DEFAULT '[]',
      must_not_contain text NOT NULL DEFAULT '[]',
      episode_filter text NOT NULL DEFAULT '',
      use_regex integer NOT NULL DEFAULT 0,
      cooldown_days integer NOT NULL DEFAULT 0,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (account_id, title_key)
    );`;

  function openOldShapedDb(): SqliteWorkflowRepository {
    // A repo on a path, so the DDL we plant survives: ":memory:" would be private.
    const path = `/tmp/ms-old-shape-${Math.random().toString(36).slice(2)}.db`;
    const seeded = createSqliteWorkflowRepository({ path });
    seeded.exec("DROP TABLE subscription_policies");
    seeded.exec(OLD_SHAPE);
    seeded.close();
    return createSqliteWorkflowRepository({ path });
  }

  it("**打开旧库后，列就在了，读写都通**", async () => {
    const repo = openOldShapedDb();
    try {
      const t0 = "2026-01-01T00:00:00.000Z";
      const t1 = "2026-01-02T00:00:00.000Z";
      await repo.upsertSubscriptionPolicy({
        accountId: "acct_a",
        titleKey: "k",
        policy: { mustContain: [], mustNotContain: [], episodeFilter: "", useRegex: false, cooldownDays: 7 },
        now: t0,
      });
      // 没匹配过必须是 null，不是 undefined
      expect((await repo.getSubscriptionPolicy({ accountId: "acct_a", titleKey: "k" }))?.lastTakenAt).toBeNull();
      // 写必须成功（旧库里这一句会抛 no such column）
      expect(await repo.recordPolicyMatch({ accountId: "acct_a", titleKey: "k", now: t1 })).toBe(t1);
      expect((await repo.getSubscriptionPolicy({ accountId: "acct_a", titleKey: "k" }))?.lastTakenAt).toBe(t1);
    } finally {
      repo.close();
    }
  });

  it("**补列是幂等的**（第二次打开不重复加、不报错）", async () => {
    const path = `/tmp/ms-old-shape-${Math.random().toString(36).slice(2)}.db`;
    const first = createSqliteWorkflowRepository({ path });
    first.exec("DROP TABLE subscription_policies");
    first.exec(OLD_SHAPE);
    first.close();
    // 开两次：第二次看到的是已补好的表
    const a = createSqliteWorkflowRepository({ path });
    a.close();
    const b = createSqliteWorkflowRepository({ path });
    try {
      await b.upsertSubscriptionPolicy({
        accountId: "acct_a",
        titleKey: "k",
        policy: { mustContain: [], mustNotContain: [], episodeFilter: "", useRegex: false, cooldownDays: 7 },
        now: "2026-01-01T00:00:00.000Z",
      });
      expect(await b.recordPolicyMatch({ accountId: "acct_a", titleKey: "k", now: "2026-01-02T00:00:00.000Z" })).not.toBeNull();
    } finally {
      b.close();
    }
  });
});

describe("SQLite claim honors nextAttemptAt backoff gate", () => {
  const base = workflowPersistenceFixture();
  const gatedRun = (nextAttemptAt: string) => ({
    ...base,
    workflowRun: {
      ...base.workflowRun,
      id: "run_gated",
      status: "queued" as const,
      finishedAt: null,
      autoRequeueCount: 1,
      nextAttemptAt,
      startedAt: "2026-07-05T00:00:00.000Z",
    },
    // child rows are validated to belong to workflowRun.id; drop them since we
    // re-id the run and this test only exercises claim gating.
    transferAttempts: [],
    notifications: [],
  });

  it("skips a queued run until now reaches its nextAttemptAt, then claims it", async () => {
    const repo = makeSqliteRepo();
    try {
      await repo.saveWorkflowRunSnapshot(gatedRun("2026-07-05T06:00:00.000Z"));
      // Before the backoff deadline: not yet claimable.
      expect(await repo.claimNextQueuedWorkflowRun({ kind: base.workflowRun.kind, now: "2026-07-05T05:59:59.000Z" })).toBeNull();
      // At/after the deadline: claimed (proves nextAttemptAt round-tripped through the text payload).
      const claimed = await repo.claimNextQueuedWorkflowRun({ kind: base.workflowRun.kind, now: "2026-07-05T06:00:00.000Z" });
      expect(claimed?.workflowRun.id).toBe("run_gated");
      expect(claimed?.workflowRun.status).toBe("running");
    } finally {
      repo.close();
    }
  });
});

// SQLite-specific: appendAgentStep is idempotent on (workflow_run_id, ordinal)
// (ON CONFLICT DO NOTHING), so a re-appended ordinal is a no-op. The InMemory oracle
// intentionally just pushes (no dedup), so this invariant can't live in the shared
// contract — it's asserted directly against the PRODUCTION engine here (mirrors
// agent-steps trace).
describe("SQLite appendAgentStep is idempotent on (run, ordinal)", () => {
  const step = (ordinal: number, toolName: string) => ({
    ordinal,
    toolName,
    args: { keyword: "x" },
    activity: "搜",
    phase: "search" as const,
    at: "2026-06-22T00:00:00.000Z",
  });

  it("ignores a duplicate ordinal append", async () => {
    const repo = makeSqliteRepo();
    try {
      const snapshot = workflowPersistenceFixture();
      await repo.saveWorkflowRunSnapshot(snapshot);
      const runId = snapshot.workflowRun.id;
      await repo.appendAgentStep(runId, step(0, "searchResources"));
      await repo.appendAgentStep(runId, step(1, "transferCandidate"));
      // Re-append ordinal 0 → no new row (ON CONFLICT DO NOTHING keeps the first).
      await repo.appendAgentStep(runId, step(0, "searchResources"));
      const steps = await repo.listAgentSteps(runId);
      expect(steps.map((s) => s.ordinal)).toEqual([0, 1]);
      expect(steps[0]!.toolName).toBe("searchResources");
    } finally {
      repo.close();
    }
  });
});

// SQLite-specific: backfillConnectedStorageId. This is a genuine engine divergence, so
// it can't live in the shared contract (see the note there). A null-storage persist
// collapses to the UNSCOPED_STORAGE sentinel; SQLite's backfill targets that sentinel
// and actively pins the row to the account's primary drive (targets literal
// NULL and is dead code post-persist). This locks the PRODUCTION (desktop) engine.
describe("SQLite backfillConnectedStorageId pins sentinel rows to the primary drive", () => {
  it("pins a storage-less row (and its episodes) to the account's earliest drive, idempotently", async () => {
    const repo = makeSqliteRepo();
    try {
      await repo.saveWorkflowRunSnapshot({
        ...workflowPersistenceFixture(),
        accountId: "acct_default",
        // connectedStorageId intentionally omitted → sentinel
      });
      await repo.upsertConnectedStorage({
        id: "cs_primary",
        accountId: "acct_default",
        provider: "pan115",
        providerUid: "uid_primary",
        payload: { cookie: "c" },
        createdAt: "2026-06-01T00:00:00.000Z",
      });

      // Before: the concrete-drive scope sees nothing (row is unscoped).
      expect(
        await repo.listTrackedSeasonStates({ accountId: "acct_default", connectedStorageId: "cs_primary" }),
      ).toHaveLength(0);

      expect(await repo.backfillConnectedStorageId()).toBe(1);

      const scoped = await repo.listTrackedSeasonStates({ accountId: "acct_default", connectedStorageId: "cs_primary" });
      expect(scoped.map((s) => s.season.id)).toEqual(["season_1"]);
      expect(scoped[0]?.connectedStorageId).toBe("cs_primary");
      expect(scoped[0]?.episodes.map((e) => e.episodeCode)).toEqual(["S01E01", "S01E02"]);
      // Idempotent.
      expect(await repo.backfillConnectedStorageId()).toBe(0);
    } finally {
      repo.close();
    }
  });
});

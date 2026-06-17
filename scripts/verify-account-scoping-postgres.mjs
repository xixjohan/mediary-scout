#!/usr/bin/env node
// P0.3 parity check: exercise the new account-scoping methods against the REAL
// dev Postgres (the unit tests only cover InMemory). Uses throwaway accounts and
// cleans up after itself. Run: node scripts/verify-account-scoping-postgres.mjs
import pg from "pg";
import { PostgresWorkflowRepository, initializeWorkflowPostgresSchema } from "../packages/workflow/dist/index.js";

const url =
  process.env.MEDIA_TRACK_POSTGRES_URL || "postgresql://mediatrack:mediatrack@localhost:5432/media_track";

const A1 = "acct_test_a1";
const A2 = "acct_test_a2";

function snap(accountId, suffix) {
  const title = {
    id: `ttl_test_${suffix}`,
    tmdbId: 999000 + suffix.length,
    type: "tv",
    title: `T ${suffix}`,
    originalTitle: `T ${suffix}`,
    year: 2026,
    aliases: [],
  };
  const season = {
    id: `seas_test_${suffix}`,
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "d",
    totalEpisodes: 1,
    latestAiredEpisode: 1,
    latestAiredSource: "metadata",
  };
  const workflowRun = {
    id: `run_test_${suffix}`,
    kind: "type2_init",
    status: "queued",
    trackedSeasonId: season.id,
    startedAt: "2026-06-18T00:00:00.000Z",
    finishedAt: null,
    auditEvents: [],
  };
  return {
    accountId,
    title,
    season,
    workflowRun,
    episodes: [
      {
        trackedSeasonId: season.id,
        episodeCode: "S01E01",
        airDate: null,
        title: "e1",
        airStatus: "aired",
        obtained: true,
        metadataStatus: "confirmed",
        verifiedFileIds: ["f1"],
      },
    ],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [
      {
        id: `notif_test_${suffix}`,
        workflowRunId: workflowRun.id,
        kind: "tracking_initialized",
        title: "i",
        body: "b",
        createdAt: "2026-06-18T00:00:00.000Z",
      },
    ],
  };
}

const pool = new pg.Pool({ connectionString: url });
await initializeWorkflowPostgresSchema(pool);
const repo = new PostgresWorkflowRepository(pool, Promise.resolve());
let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failed++;
};

try {
  // clean any prior test rows
  await pool.query("DELETE FROM notifications WHERE workflow_run_id LIKE 'run_test_%'");
  await pool.query("DELETE FROM episode_states WHERE tracked_season_id LIKE 'seas_test_%'");
  await pool.query("DELETE FROM workflow_runs WHERE id LIKE 'run_test_%'");
  await pool.query("DELETE FROM tracked_seasons WHERE id LIKE 'seas_test_%'");
  await pool.query("DELETE FROM media_titles WHERE id LIKE 'ttl_test_%'");
  await pool.query("DELETE FROM account_settings WHERE account_id IN ($1,$2)", [A1, A2]);
  await pool.query("DELETE FROM connected_storages WHERE provider_uid LIKE 'UID_TEST_%'");

  await repo.saveWorkflowRunSnapshot(snap(A1, "a1"));
  await repo.saveWorkflowRunSnapshot(snap(A2, "a2"));

  const ts1 = await repo.listTrackedSeasonStates(A1);
  check("listTrackedSeasonStates(A1) only a1", ts1.length === 1 && ts1[0].season.id === "seas_test_a1");
  check("state carries accountId", ts1[0].accountId === A1);
  const ts2 = await repo.listTrackedSeasonStates(A2);
  check("listTrackedSeasonStates(A2) only a2", ts2.length === 1 && ts2[0].season.id === "seas_test_a2");

  check("getWorkflowRunSnapshot scoped (own)", (await repo.getWorkflowRunSnapshot("run_test_a1", A1))?.accountId === A1);
  check("getWorkflowRunSnapshot scoped (other → null)", (await repo.getWorkflowRunSnapshot("run_test_a1", A2)) === null);

  const n1 = await repo.listNotifications({ accountId: A1 });
  check("listNotifications scoped", n1.some((n) => n.id === "notif_test_a1") && !n1.some((n) => n.id === "notif_test_a2"));

  const ep = await repo.listEpisodeStates("seas_test_a1", A1);
  check("listEpisodeStates scoped (own)", ep.length === 1);
  const epOther = await repo.listEpisodeStates("seas_test_a1", A2);
  check("listEpisodeStates scoped (other → empty)", epOther.length === 0);

  const la = await repo.listActiveWorkflowRuns(A1);
  check("listActiveWorkflowRuns scoped", la.length === 1 && la[0].accountId === A1);

  // claim is cross-account: drains A1+A2 queue regardless of account, snapshot carries accountId
  const claimed = await repo.claimNextQueuedWorkflowRun({ kind: "type2_init", now: "2026-06-18T01:00:00.000Z" });
  check("claim returns a run with accountId", !!claimed && (claimed.accountId === A1 || claimed.accountId === A2));

  // cancel scope: a2 cannot cancel a1's run (also a1's was just claimed=running, use a2's still-queued)
  const cancelWrong = await repo.cancelQueuedWorkflowRun("run_test_a2", A1);
  check("cancel rejects wrong account", cancelWrong.status === "not_cancellable");

  // account settings isolation
  await repo.setAccountSetting(A1, "preferred_language", "中文");
  await repo.setAccountSetting(A2, "preferred_language", "English");
  check("account setting A1", (await repo.getAccountSetting(A1, "preferred_language")) === "中文");
  check("account setting A2", (await repo.getAccountSetting(A2, "preferred_language")) === "English");
  check("account setting missing → null", (await repo.getAccountSetting(A1, "nope")) === null);

  // connected storage uniqueness
  await repo.upsertConnectedStorage({
    id: "cs_test_1",
    accountId: A1,
    provider: "pan115",
    providerUid: "UID_TEST_1",
    payload: { cookie: "c1" },
    rootCid: "r",
    moviesCid: "m",
    tvCid: "t",
    animeCid: "an",
    createdAt: "2026-06-18T00:00:00.000Z",
  });
  const found = await repo.findConnectedStorageByUid("pan115", "UID_TEST_1");
  check("connected storage found by uid", found?.accountId === A1 && found?.tvCid === "t");
  check("connected storage list scoped", (await repo.listConnectedStorages(A1)).length === 1);
  check("connected storage list other empty", (await repo.listConnectedStorages(A2)).length === 0);
  // refresh (same uid upsert) updates payload, preserves uniqueness
  await repo.upsertConnectedStorage({
    id: "cs_test_1",
    accountId: A1,
    provider: "pan115",
    providerUid: "UID_TEST_1",
    payload: { cookie: "c2" },
    createdAt: "2026-06-18T00:00:00.000Z",
  });
  const refreshed = await repo.findConnectedStorageByUid("pan115", "UID_TEST_1");
  check("connected storage refresh updates payload", refreshed?.payload?.cookie === "c2");
  check("connected storage refresh single row", (await repo.listConnectedStorages(A1)).length === 1);
} finally {
  // cleanup
  await pool.query("DELETE FROM notifications WHERE workflow_run_id LIKE 'run_test_%'");
  await pool.query("DELETE FROM episode_states WHERE tracked_season_id LIKE 'seas_test_%'");
  await pool.query("DELETE FROM workflow_runs WHERE id LIKE 'run_test_%'");
  await pool.query("DELETE FROM tracked_seasons WHERE id LIKE 'seas_test_%'");
  await pool.query("DELETE FROM media_titles WHERE id LIKE 'ttl_test_%'");
  await pool.query("DELETE FROM account_settings WHERE account_id IN ($1,$2)", [A1, A2]);
  await pool.query("DELETE FROM connected_storages WHERE provider_uid LIKE 'UID_TEST_%'");
  await pool.end();
}

console.log(failed === 0 ? "\nALL PARITY CHECKS PASSED" : `\n${failed} CHECKS FAILED`);
process.exit(failed === 0 ? 0 : 1);

// §7 form B — REAL end-to-end acquisition e2e (fully automated, no dev server).
// Drives the REAL worker (runNextQueuedWorkflow) against the REAL 115 / PanSou /
// agent, ONLY touching the TEST 115 roots (env MEDIA_TRACK_*_PARENT_CID).
//
//   npx tsx scripts/multi-account-acquire-e2e.mts single   # single-user (acct_default)
//   npx tsx scripts/multi-account-acquire-e2e.mts multi     # bob uses bob's own 115 creds
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const repoRoot = path.resolve(import.meta.dirname, "..");
for (const line of readFileSync(path.join(repoRoot, ".env"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[k] ??= v;
}

const mode = process.argv[2] === "multi" ? "multi" : "single";
const rt = await import(path.join(repoRoot, "apps/web/lib/workflow-runtime.ts"));
const wf = await import("@media-track/workflow");
const repo = rt.getWorkflowRepository();
const pool = new pg.Pool({ connectionString: process.env.MEDIA_TRACK_POSTGRES_URL! });

async function tmdbId(kind: "movie", query: string): Promise<number> {
  const url = `https://api.themoviedb.org/3/search/${kind}?query=${encodeURIComponent(query)}&language=zh-CN`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.TMDB_READ_TOKEN}` } });
  const json = (await res.json()) as { results?: Array<{ id: number }> };
  const id = json.results?.[0]?.id;
  if (!id) throw new Error(`TMDB resolve failed for ${query}`);
  return id;
}

/** Wipe any prior tracking for a movie title so the run is always a fresh queue. */
async function cleanupTitle(titleId: string) {
  await pool.query("DELETE FROM notifications WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))", [titleId]);
  await pool.query("DELETE FROM transfer_attempts WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))", [titleId]);
  await pool.query("DELETE FROM agent_decisions WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))", [titleId]);
  await pool.query("DELETE FROM resource_snapshots WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))", [titleId]);
  await pool.query("DELETE FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1)", [titleId]);
  await pool.query("DELETE FROM episode_states WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1)", [titleId]);
  await pool.query("DELETE FROM tracked_seasons WHERE media_title_id=$1", [titleId]);
}

/** Drive the real worker until the target run reaches a terminal status. */
async function driveUntilTerminal(runId: string, accountId: string, label: string) {
  for (let i = 0; i < 4; i++) {
    const result = await rt.runNextQueuedWorkflow();
    console.log(`  [${label}] worker tick ${i + 1}: ${JSON.stringify(result)}`);
    const snap = await repo.getWorkflowRunSnapshot(runId, accountId);
    const status = snap?.workflowRun.status;
    if (status && status !== "queued" && status !== "running") {
      return snap;
    }
    if (result.status === "idle") break;
  }
  return repo.getWorkflowRunSnapshot(runId, accountId);
}

let failed = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? "ok  " : "FAIL"} ${n}`); if (!c) failed++; };

if (mode === "single") {
  console.log("=== SINGLE-USER real acquisition (acct_default) ===");
  const id = await tmdbId("movie", "流浪地球2");
  const titleId = `tmdb_movie_${id}`;
  await cleanupTitle(titleId);
  const res = await rt.queueCandidateTracking(`tmdb_movie_${id}`);
  console.log("queued →", res);
  ok("queued under default account", res.status === "queued" && !!res.workflowRunId);
  const snap = await driveUntilTerminal(res.workflowRunId!, "acct_default", "single");
  console.log("final:", { accountId: snap?.accountId, status: snap?.workflowRun.status, obtained: snap?.obtainedEpisodes });
  ok("run owned by acct_default", snap?.accountId === "acct_default");
  ok("run reached terminal status", !!snap && snap.workflowRun.status !== "queued" && snap.workflowRun.status !== "running");
  ok("movie actually obtained (real 115 transfer)", (snap?.obtainedEpisodes.length ?? 0) > 0);
} else {
  console.log("=== MULTI-USER real acquisition (bob uses bob's 115 creds) ===");
  const bobId = "acct_bob_e2e";
  const cookie = (await repo.getSetting("pan115.cookie"))?.trim();
  if (!cookie) throw new Error("no 115 cookie in DB to seed bob with");
  // fresh bob
  await pool.query("DELETE FROM connected_storages WHERE account_id=$1 OR provider_uid=$2", [bobId, "bob_e2e_uid"]);
  await pool.query("DELETE FROM accounts WHERE id=$1", [bobId]);
  await repo.createAccount({ id: bobId, username: "bob_e2e", passwordHash: "", groupId: null, isOwner: false, createdAt: new Date().toISOString() });
  // bob's connected 115: SAME real cookie (distinct test uid to dodge the global
  // uniqueness already held by acct_default), TEST CIDs as landing dirs.
  await repo.upsertConnectedStorage({
    id: "cs_bob_e2e", accountId: bobId, provider: "pan115", providerUid: "bob_e2e_uid",
    payload: { cookie }, createdAt: new Date().toISOString(),
    rootCid: process.env.MEDIA_TRACK_115_TEST_ROOT_CID ?? null,
    moviesCid: process.env.MEDIA_TRACK_MOVIES_PARENT_CID ?? null,
    tvCid: process.env.MEDIA_TRACK_TV_PARENT_CID ?? null,
    animeCid: process.env.MEDIA_TRACK_ANIME_PARENT_CID ?? null,
  });
  ok("bob has a pan115 connection with real cookie", ((await repo.listConnectedStorages(bobId))[0] as { payload?: { cookie?: string } })?.payload?.cookie === cookie);

  const id = await tmdbId("movie", "流浪地球");
  const titleId = `tmdb_movie_${id}`;
  await cleanupTitle(titleId);
  const target = await rt.movieTargetFromTmdbId(id);
  if (!target) throw new Error("movie target resolve failed");
  // Queue OWNED BY BOB (the worker must resolve bob's creds for it).
  const runId = `run_bob_e2e_${id}`;
  const queued = await wf.queueMovieAcquisition({ title: target.title, keyword: target.keyword, repository: repo, accountId: bobId, createWorkflowRunId: () => runId });
  console.log("queued (bob) →", queued);
  ok("queued under bob", queued.status === "queued");

  const snap = await driveUntilTerminal(runId, bobId, "multi");
  console.log("final:", { accountId: snap?.accountId, status: snap?.workflowRun.status, obtained: snap?.obtainedEpisodes });
  ok("run owned by bob (not default)", snap?.accountId === bobId);
  ok("default account cannot see bob's run", (await repo.getWorkflowRunSnapshot(runId, "acct_default")) === null);
  ok("run reached terminal status", !!snap && snap.workflowRun.status !== "queued" && snap.workflowRun.status !== "running");
  ok("movie obtained via bob's creds (real 115 transfer)", (snap?.obtainedEpisodes.length ?? 0) > 0);

  // cleanup bob (leave the global media_title; remove bob's account/conn/runs)
  await cleanupTitle(titleId);
  await pool.query("DELETE FROM connected_storages WHERE account_id=$1", [bobId]);
  await pool.query("DELETE FROM accounts WHERE id=$1", [bobId]);
  console.log("(bob cleaned up)");
}

await pool.end();
console.log(failed === 0 ? `\n${mode.toUpperCase()} E2E PASSED` : `\n${failed} CHECKS FAILED`);
process.exit(failed === 0 ? 0 : 1);

// §7 form B — REAL acquisition / multi-account-invariant e2e (fully automated).
// Drives the REAL worker (runNextQueuedWorkflow) against the REAL 115 / PanSou /
// agent, ONLY touching the TEST 115 roots (env MEDIA_TRACK_*_PARENT_CID).
//
//   npx tsx scripts/multi-account-acquire-e2e.mts single   # single-user real acquisition
//   npx tsx scripts/multi-account-acquire-e2e.mts multi     # multi-account 唯一性 invariant
//
// NOTE on "multi": the spec forbids two accounts binding the SAME physical 115
// (UNIQUE(provider, provider_uid); 他账号已绑=拒绝). With only ONE 115 account a
// second account therefore CANNOT bind it and CANNOT acquire — so this mode
// verifies the REJECTION invariant + the DB ownership backstop (the things that
// ARE provable with one 115). A real second-account transfer needs a SECOND
// physical 115 account → user-driven.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadDotEnv, openAppDb } from "../_lib/sqlite-db.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
loadDotEnv();

const mode = process.argv[2] === "multi" ? "multi" : "single";
const rt = await import(path.join(repoRoot, "apps/web/lib/workflow-runtime.ts"));
const wf = await import("@media-track/workflow");
const repo = rt.getWorkflowRepository();
// Pure-SQLite single engine (task S1.4b): raw row cleanup via the app's DB file.
const raw = () => openAppDb();

async function tmdbId(kind: "movie", query: string): Promise<number> {
  const url = `https://api.themoviedb.org/3/search/${kind}?query=${encodeURIComponent(query)}&language=zh-CN`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.TMDB_READ_TOKEN}` } });
  const json = (await res.json()) as { results?: Array<{ id: number }> };
  const id = json.results?.[0]?.id;
  if (!id) throw new Error(`TMDB resolve failed for ${query}`);
  return id;
}

/** Wipe any prior tracking for a movie title so the run is always a fresh queue. */
function cleanupTitle(titleId: string) {
  const db = raw();
  try {
    db.prepare("DELETE FROM notifications WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id = ?))").run(titleId);
    db.prepare("DELETE FROM transfer_attempts WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id = ?))").run(titleId);
    db.prepare("DELETE FROM agent_decisions WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id = ?))").run(titleId);
    db.prepare("DELETE FROM resource_snapshots WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id = ?))").run(titleId);
    db.prepare("DELETE FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id = ?)").run(titleId);
    db.prepare("DELETE FROM episode_states WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id = ?)").run(titleId);
    db.prepare("DELETE FROM tracked_seasons WHERE media_title_id = ?").run(titleId);
  } finally {
    db.close();
  }
}

async function driveUntilTerminal(runId: string, accountId: string, label: string) {
  for (let i = 0; i < 4; i++) {
    const result = await rt.runNextQueuedWorkflow();
    console.log(`  [${label}] worker tick ${i + 1}: ${JSON.stringify(result)}`);
    const snap = await repo.getWorkflowRunSnapshot(runId, accountId);
    const status = snap?.workflowRun.status;
    if (status && status !== "queued" && status !== "running") return snap;
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
  cleanupTitle(titleId);
  const res = await rt.queueCandidateTracking(`tmdb_movie_${id}`);
  console.log("queued →", res);
  ok("queued under default account", res.status === "queued" && !!res.workflowRunId);
  const snap = await driveUntilTerminal(res.workflowRunId!, "acct_default", "single");
  console.log("final:", { accountId: snap?.accountId, status: snap?.workflowRun.status, obtained: snap?.obtainedEpisodes });
  ok("run owned by acct_default", snap?.accountId === "acct_default");
  ok("run reached terminal status", !!snap && snap.workflowRun.status !== "queued" && snap.workflowRun.status !== "running");
  ok("movie actually obtained (real 115 transfer)", (snap?.obtainedEpisodes.length ?? 0) > 0);
} else {
  console.log("=== MULTI-ACCOUNT 唯一性 invariant (one physical 115) ===");
  const bobId = "acct_bob_e2e";
  const cookie = (await repo.getSetting("pan115.cookie"))?.trim();
  if (!cookie) throw new Error("no 115 cookie in DB");
  const realUid = wf.parsePan115Uid(cookie) ?? "pan115_default";

  // acct_default already owns this physical 115 (from the startup migration) —
  // that's the setup that makes the invariant testable with ONE 115 account.
  const ownerConn = await repo.findConnectedStorageByUid("pan115", realUid);
  ok(`acct_default owns the only physical 115 (uid ${realUid})`, ownerConn?.accountId === "acct_default");

  // fresh bob
  const dbBob = raw();
  dbBob.prepare("DELETE FROM connected_storages WHERE account_id = ?").run(bobId);
  dbBob.prepare("DELETE FROM accounts WHERE id = ?").run(bobId);
  dbBob.close();
  await repo.createAccount({ id: bobId, username: "bob_e2e", passwordHash: "", groupId: null, isOwner: false, createdAt: new Date().toISOString() });

  // INVARIANT 1 — binding decision REJECTS bob binding the same physical 115.
  const decision = wf.resolveStorageBinding({ provider: "pan115", providerUid: realUid, accountId: bobId, existing: ownerConn });
  ok("binding decision rejects bob (他账号已绑=拒绝)", decision.action === "reject" && (decision as { ownerAccountId?: string }).ownerAccountId === "acct_default");

  // INVARIANT 2 — DB backstop: even calling the repo primitive directly, bob can
  // NOT steal ownership or overwrite acct_default's cookie.
  await repo.upsertConnectedStorage({ id: "cs_bob_steal", accountId: bobId, provider: "pan115", providerUid: realUid, payload: { cookie: "EVIL" }, createdAt: new Date().toISOString() });
  const after = await repo.findConnectedStorageByUid("pan115", realUid);
  ok("repo primitive does NOT let bob steal ownership", after?.accountId === "acct_default");
  ok("repo primitive does NOT overwrite owner's cookie", (after?.payload as { cookie?: string })?.cookie === cookie);
  ok("bob ends up with zero connected drives (bind refused)", (await repo.listConnectedStorages(bobId)).length === 0);

  console.log("\nNOTE: a REAL second-account ACQUISITION needs a SECOND physical 115 account.");
  console.log("The same 115 can never be bound twice (proven above). With one 115 the");
  console.log("invariant + ownership backstop are verified here; data isolation by");
  console.log("verify-multi-user-flow.mjs; per-account credential RESOLUTION by worker.test.");

  const dbBob2 = raw();
  dbBob2.prepare("DELETE FROM connected_storages WHERE account_id = ?").run(bobId);
  dbBob2.prepare("DELETE FROM accounts WHERE id = ?").run(bobId);
  dbBob2.close();
  console.log("(bob cleaned up)");
}

await repo.close?.();
console.log(failed === 0 ? `\n${mode.toUpperCase()} E2E PASSED` : `\n${failed} CHECKS FAILED`);
process.exit(failed === 0 ? 0 : 1);

// Tree-model stage 1 e2e: TWO physical 115 drives bound to ONE account, proving
// per-(account,storage) isolation + per-drive acquisition landing + 掉线冻结.
// Needs the friend's cookie at /tmp/friend-115-cookie.txt (NEVER committed).
//   npx tsx scripts/multi-pan115-tree-e2e.mts
//
// Account = acct_default (already owns drive1 = its own 115 via migration). We
// release the friend's 115 from any prior account and bind it as drive2 of
// acct_default, so one account has two drives. Lands SMALL targets on each.
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

const ACCT = "acct_default";
const DEFAULT_UID = "100000001";
const FRIEND_UID = "100000002";
const friendCookie = readFileSync("/tmp/friend-115-cookie.txt", "utf8").trim();

const rt = await import(path.join(repoRoot, "apps/web/lib/workflow-runtime.ts"));
const wf = await import("@media-track/workflow");
const repo = rt.getWorkflowRepository();
const pool = new pg.Pool({ connectionString: process.env.MEDIA_TRACK_POSTGRES_URL! });

let failed = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? "ok  " : "FAIL"} ${n}`); if (!c) failed++; };

async function tmdbId(query: string): Promise<number> {
  const url = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(query)}&language=zh-CN`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.TMDB_READ_TOKEN}` } });
  const json = (await res.json()) as { results?: Array<{ id: number }> };
  const id = json.results?.[0]?.id;
  if (!id) throw new Error(`TMDB resolve failed for ${query}`);
  return id;
}
async function cleanupTitle(titleId: string) {
  for (const sql of [
    "DELETE FROM notifications WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))",
    "DELETE FROM transfer_attempts WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))",
    "DELETE FROM agent_decisions WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))",
    "DELETE FROM resource_snapshots WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))",
    "DELETE FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1)",
    "DELETE FROM episode_states WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1)",
    "DELETE FROM tracked_seasons WHERE media_title_id=$1",
  ]) await pool.query(sql, [titleId]);
}
async function driveOnce(runId: string) {
  for (let i = 0; i < 5; i++) {
    const r = await rt.runNextQueuedWorkflow();
    const snap = await repo.getWorkflowRunSnapshot(runId, { accountId: ACCT, connectedStorageId: null });
    if (snap && snap.workflowRun.status !== "queued" && snap.workflowRun.status !== "running") return snap;
    if (r.status === "idle") break;
  }
  return repo.getWorkflowRunSnapshot(runId, { accountId: ACCT, connectedStorageId: null });
}

try {
  // ---- setup: bind BOTH drives to acct_default ----
  ok("acct_default owns drive1 (its own 115)", (await repo.findConnectedStorageByUid("pan115", DEFAULT_UID))?.accountId === ACCT);

  // Release friend's drive from any prior account, then bind it to acct_default.
  await pool.query("DELETE FROM connected_storages WHERE provider_uid=$1", [FRIEND_UID]);
  // Executor (provisioning: listChildDirectories/createDirectory); cookie client
  // (raw listItems for the physical proof).
  const friendExec = wf.createProtectedPan115CookieStorageExecutorFromEnv({
    env: { ...process.env, PAN115_COOKIE: friendCookie, MEDIA_TRACK_115_WRITE_SCOPE_CIDS: "0" },
  });
  const friendClient = new wf.Pan115CookieClient({ cookie: friendCookie, listPageDelayMs: 0 });
  const cids = await wf.provisionCategoryDirs({
    baseParentId: "0",
    storage: {
      listChildDirs: (p: string) => friendExec.listChildDirectories(p),
      createDirectory: (d: { name: string; parentId: string }) => friendExec.createDirectory(d),
    },
  });
  const decision = wf.resolveStorageBinding({
    provider: "pan115", providerUid: FRIEND_UID, accountId: ACCT,
    existing: await repo.findConnectedStorageByUid("pan115", FRIEND_UID),
  });
  ok("binding friend's drive to acct_default = insert (a 2nd drive)", decision.action === "insert");
  await repo.upsertConnectedStorage({
    id: `cs_${FRIEND_UID}`, accountId: ACCT, provider: "pan115", providerUid: FRIEND_UID,
    payload: { cookie: friendCookie }, rootCid: cids.rootCid, moviesCid: cids.moviesCid, tvCid: cids.tvCid, animeCid: cids.animeCid,
    createdAt: new Date().toISOString(),
  });

  const drives = (await repo.listConnectedStorages(ACCT)).filter((s) => s.provider === "pan115");
  ok("acct_default now has TWO pan115 drives", drives.length === 2);
  const drive1 = drives.find((d) => d.providerUid === DEFAULT_UID)!;
  const drive2 = drives.find((d) => d.providerUid === FRIEND_UID)!;

  // Friend drive may hold residue from earlier tests — snapshot its videos NOW so
  // the physical proof is a before/after diff (only THIS run's B is new).
  const listFriendVideos = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const d of await friendClient.listItems({ directoryId: drive2.moviesCid! })) {
      const cid = (d as any).cid;
      if (!cid) continue;
      for (const f of await friendClient.listItems({ directoryId: String(cid) })) {
        const n = String((f as any).n ?? "");
        if (/\.(mkv|mp4|ts|m2ts)$/i.test(n)) out.push(n);
      }
    }
    return out;
  };
  const friendBefore = new Set(await listFriendVideos());

  // ---- per-drive acquisition ----
  const idA = await tmdbId("这个杀手不太冷"); // → drive1 (default 115 test root)
  const idB = await tmdbId("肖申克的救赎"); // → drive2 (friend 15GB) — reliably has a 1080p
  await cleanupTitle(`tmdb_movie_${idA}`);
  await cleanupTitle(`tmdb_movie_${idB}`);
  await repo.setAccountSetting(ACCT, rt.QUALITY_PREFERENCE_SETTING_KEY, "medium");

  const qA = await rt.queueCandidateTracking(`tmdb_movie_${idA}`, drive1.id);
  ok("queued A onto drive1", qA.status === "queued" && !!qA.workflowRunId);
  const snapA = await driveOnce(qA.workflowRunId!);
  ok("A landed on drive1 scope (run.connectedStorageId=drive1)", snapA?.connectedStorageId === drive1.id);

  const qB = await rt.queueCandidateTracking(`tmdb_movie_${idB}`, drive2.id);
  ok("queued B onto drive2", qB.status === "queued" && !!qB.workflowRunId);
  const snapB = await driveOnce(qB.workflowRunId!);
  ok("B landed on drive2 scope (run.connectedStorageId=drive2)", snapB?.connectedStorageId === drive2.id);

  // ---- isolation ----
  const d1Titles = (await repo.listTrackedSeasonStates({ accountId: ACCT, connectedStorageId: drive1.id })).map((s) => s.title.id);
  const d2Titles = (await repo.listTrackedSeasonStates({ accountId: ACCT, connectedStorageId: drive2.id })).map((s) => s.title.id);
  ok("drive1 library shows A, not B", d1Titles.includes(`tmdb_movie_${idA}`) && !d1Titles.includes(`tmdb_movie_${idB}`));
  ok("drive2 library shows B, not A", d2Titles.includes(`tmdb_movie_${idB}`) && !d2Titles.includes(`tmdb_movie_${idA}`));
  ok("drive1 cannot see B's run (cross-storage null)", (await repo.getWorkflowRunSnapshot(qB.workflowRunId!, { accountId: ACCT, connectedStorageId: drive1.id })) === null);

  // ---- physical proof: a NEW video (B) appeared in the FRIEND drive ----
  const newInFriend = (await listFriendVideos()).filter((n) => !friendBefore.has(n));
  console.log("new video(s) in friend drive:", newInFriend.join(" | ") || "(none)");
  ok("B physically landed a NEW file in the FRIEND drive (drive2)", newInFriend.length > 0);

  // ---- 掉线冻结 ----
  await pool.query("UPDATE connected_storages SET payload=$2 WHERE id=$1", [drive2.id, JSON.stringify({ cookie: "UID=dead_invalid; CID=x; SEID=x" })]);
  const probe = await rt.testConnection(ACCT, drive2.id);
  ok("testConnection on a dead cookie → frozen", probe.status === "frozen" && !probe.ok);
  ok("frozen drive2 is marked frozen in DB", (await repo.findConnectedStorageByUid("pan115", FRIEND_UID))?.status === "frozen");
  const blocked = await rt.queueCandidateTracking(`tmdb_movie_${idB}`, drive2.id);
  ok("acquisition onto a frozen drive is refused", blocked.status === "unsupported");
  // re-bind with the real cookie → active
  await pool.query("UPDATE connected_storages SET payload=$2 WHERE id=$1", [drive2.id, JSON.stringify({ cookie: friendCookie })]);
  const reprobe = await rt.testConnection(ACCT, drive2.id);
  ok("re-bind (good cookie) + testConnection → active again", reprobe.status === "active" && reprobe.ok);
} finally {
  await pool.end();
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nTREE-MODEL TWO-DRIVE E2E PASSED — one account, two drives, isolated + per-drive landing + freeze");
process.exit(failed ? 1 : 0);

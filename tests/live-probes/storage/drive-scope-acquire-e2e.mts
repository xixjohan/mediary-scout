// Drive-scoped tracked-season e2e: the exact bug the quark browser live-e2e hit.
// 肖申克 (tmdb 278) is tracked on a 115 drive (cs_100000002). BEFORE the fix,
// queueing it onto the quark drive returned already_tracked (cross-drive PK
// collision). AFTER the fix it queues, the worker 转存s it onto the QUARK drive,
// and the 115 drive's tracking is untouched. Real worker + real quark cookie.
//   npx tsx scripts/drive-scope-acquire-e2e.mts
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadDotEnv, openAppDb } from "../_lib/sqlite-db.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
loadDotEnv();

const QUARK = "cs_quark_quark-demo-uid";
const TITLE = "tmdb_movie_278"; // 肖申克的救赎
const SEASON = "tmdb_movie_278_movie";
const cookie = readFileSync("/tmp/quark-cookie.txt", "utf8").trim();

const rt = await import(path.join(repoRoot, "apps/web/lib/workflow-runtime.ts"));
const wf = await import("@media-track/workflow");
const repo = rt.getWorkflowRepository();
// Pure-SQLite single engine (task S1.4b): raw assertions/cleanup go through the
// app's own DB file instead of a pg Pool.
const raw = () => openAppDb();

let failed = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? "ok  " : "FAIL"} ${n}`); if (!c) failed++; };

try {
  // Precondition: 278 tracked on a 115 drive, NOT on quark.
  const db0 = raw();
  const before = db0.prepare("SELECT connected_storage_id FROM tracked_seasons WHERE id = ?").all(SEASON) as Array<{ connected_storage_id: string }>;
  db0.close();
  ok("precondition: 278 tracked on a 115 drive only", before.some((r) => r.connected_storage_id === "cs_100000002") && !before.some((r) => r.connected_storage_id === QUARK));

  // THE FIX: queue 278 onto the quark drive — must NOT be blocked as already_tracked.
  const q = await rt.queueCandidateTracking(TITLE, QUARK);
  console.log("queue 278 → quark:", JSON.stringify(q));
  ok("queue onto quark is accepted (not already_tracked)", q.status === "queued" && !!q.workflowRunId);

  if (q.workflowRunId) {
    // Drain the in-process worker until the quark run is terminal.
    let snap: any = null;
    for (let i = 0; i < 8; i++) {
      await rt.runNextQueuedWorkflow();
      snap = await repo.getWorkflowRunSnapshot(q.workflowRunId, { accountId: "acct_default", connectedStorageId: QUARK });
      if (snap && snap.workflowRun.status !== "queued" && snap.workflowRun.status !== "running") break;
    }
    ok("worker ran the quark run to a terminal status", !!snap && snap.workflowRun.status !== "queued" && snap.workflowRun.status !== "running");
    ok("the run is scoped to the quark drive", snap?.connectedStorageId === QUARK);
  }

  // 278 now tracked on BOTH drives, independently.
  const db1 = raw();
  const after = db1.prepare("SELECT connected_storage_id FROM tracked_seasons WHERE id = ?").all(SEASON) as Array<{ connected_storage_id: string }>;
  const drives = after.map((r) => r.connected_storage_id);
  ok("278 now tracked on the quark drive too", drives.includes(QUARK));
  ok("278 STILL tracked on the original 115 drive (untouched)", drives.includes("cs_100000002"));

  // Physical proof: 肖申克 landed in the quark drive's Movies dir.
  const cs = db1.prepare("SELECT movies_cid FROM connected_storages WHERE id = ?").get(QUARK) as { movies_cid: string } | undefined;
  const client = new wf.QuarkCookieClient({ cookie });
  const movieDirs = await client.listItems({ directoryId: cs?.movies_cid });
  const shawshankDir = movieDirs.find((d: any) => String(d.file_name).includes("肖申克"));
  console.log("quark Movies now:", movieDirs.map((d: any) => d.file_name).join(" | ") || "(empty)");
  ok("肖申克 physically landed in the quark drive's Movies dir", !!shawshankDir);

  // ---- cleanup: recycle from quark + remove the quark-scoped tracking ----
  if (shawshankDir) await client.deleteFiles([String((shawshankDir as any).fid)]);
  db1.prepare("DELETE FROM episode_states WHERE tracked_season_id = ? AND connected_storage_id = ?").run(SEASON, QUARK);
  db1.prepare("DELETE FROM workflow_runs WHERE tracked_season_id = ? AND connected_storage_id = ?").run(SEASON, QUARK);
  db1.prepare("DELETE FROM tracked_seasons WHERE id = ? AND connected_storage_id = ?").run(SEASON, QUARK);
  console.log("cleaned up quark-scoped 278 + recycled the file");

  // verify cleanup didn't touch the 115 drive's row
  const final = db1.prepare("SELECT connected_storage_id FROM tracked_seasons WHERE id = ?").all(SEASON) as Array<{ connected_storage_id: string }>;
  ok("after cleanup, the 115 drive's 278 tracking survives", final.some((r) => r.connected_storage_id === "cs_100000002"));
  db1.close();
} finally {
  await repo.close?.();
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nDRIVE-SCOPE ACQUIRE E2E PASSED — same title independently tracked + acquired on a second drive");
process.exit(failed ? 1 : 0);

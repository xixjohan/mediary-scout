// Multi-drive CONCURRENT acquisition e2e (same account, two drives, same show).
// Mirrors a user clicking 获取 for 黑镜 第一季 (tmdb tv 42009) on BOTH the primary
// 115 drive AND the quark drive, back-to-back. The :3000 in-process background
// worker (single claim-first consumer) drains the queue — so the two runs execute
// SERIALLY, each resolving ITS OWN drive's cookie, each scoped to its drive.
// We observe: (1) the concurrent DB state right after enqueue, (2) the worker
// draining them to terminal, (3) two independent tracked_seasons + episode_states.
// Leaves the results in place so you can inspect the browser library/activity.
//   npx tsx scripts/multi-drive-concurrent-e2e.mts
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadDotEnv, openAppDb } from "./_lib/sqlite-db.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
loadDotEnv();

const PRIMARY = "cs_100000001"; // 主 115
const QUARK = "cs_quark_quark-demo-uid"; // 夸克
const CANDIDATE = "tmdb_tv_42009_s1"; // 黑镜 第一季
const SEASON = "tmdb_tv_42009_s1";

const rt = await import(path.join(repoRoot, "apps/web/lib/workflow-runtime.ts"));
const repo = rt.getWorkflowRepository();
// Pure-SQLite single engine (task S1.4b): raw assertions go through the app's DB
// file. payload is JSON text here, so `payload->>'x'` becomes json_extract.
const raw = () => openAppDb();

let failed = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? "ok  " : "FAIL"} ${n}`); if (!c) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runState(runId: string, drive: string): Promise<string> {
  const snap = await repo.getWorkflowRunSnapshot(runId, { accountId: "acct_default", connectedStorageId: drive });
  return snap?.workflowRun.status ?? "(gone)";
}

try {
  // Pre: 黑镜 on NEITHER drive (clean concurrent demo).
  const db0 = raw();
  const pre = db0.prepare("SELECT connected_storage_id FROM tracked_seasons WHERE id = ?").all(SEASON) as Array<{ connected_storage_id: string }>;
  db0.close();
  ok("precondition: 黑镜 s1 tracked on neither drive", pre.length === 0);

  // === Enqueue on BOTH drives (= two 获取 clicks, back-to-back) ===
  const qa = await rt.queueCandidateTracking(CANDIDATE, PRIMARY);
  const qb = await rt.queueCandidateTracking(CANDIDATE, QUARK);
  console.log("enqueue 主115:", JSON.stringify(qa));
  console.log("enqueue 夸克:", JSON.stringify(qb));
  ok("主115 enqueue accepted", qa.status === "queued" && !!qa.workflowRunId);
  ok("夸克 enqueue accepted (independent of 主115)", qb.status === "queued" && !!qb.workflowRunId);
  ok("the two runs are distinct workflow_runs", qa.workflowRunId !== qb.workflowRunId);

  // === (2) Concurrent DB state right after enqueue ===
  const db1 = raw();
  const active = db1
    .prepare("SELECT id, connected_storage_id, json_extract(payload, '$.status') AS status FROM workflow_runs WHERE tracked_season_id = ? ORDER BY connected_storage_id")
    .all(SEASON) as Array<{ id: string; connected_storage_id: string; status: string }>;
  console.log("\n=== 并发瞬时 DB 状态(两条 run,各自盘) ===");
  for (const r of active) console.log(`  run ${r.id.slice(0, 12)}… | drive=${r.connected_storage_id} | status=${r.status}`);
  ok("两条 run 分属两块盘(各自 scope)", new Set(active.map((r) => r.connected_storage_id)).size === 2 &&
    active.some((r) => r.connected_storage_id === PRIMARY) &&
    active.some((r) => r.connected_storage_id === QUARK));
  db1.close();

  // === (3) Let the :3000 background worker drain both (serial, claim-first) ===
  console.log("\n=== 等 :3000 后台 worker 串行跑完两条(每条解析各自盘 cookie) ===");
  const deadline = Date.now() + 18 * 60 * 1000; // TV multi-ep × 2 drives, serial
  let lastA = "", lastB = "";
  let termA = false, termB = false;
  while (Date.now() < deadline && !(termA && termB)) {
    await sleep(5000);
    const sa = await runState(qa.workflowRunId!, PRIMARY);
    const sb = await runState(qb.workflowRunId!, QUARK);
    if (sa !== lastA || sb !== lastB) {
      console.log(`  [${new Date().toISOString().slice(11, 19)}] 主115=${sa}  夸克=${sb}`);
      lastA = sa; lastB = sb;
    }
    termA = sa !== "queued" && sa !== "running" && sa !== "(gone)";
    termB = sb !== "queued" && sb !== "running" && sb !== "(gone)";
  }
  ok("主115 run 跑到终态", termA);
  ok("夸克 run 跑到终态", termB);

  // === Assert two INDEPENDENT tracked_seasons + episodes obtained, per drive ===
  const db2 = raw();
  const post = db2.prepare("SELECT connected_storage_id FROM tracked_seasons WHERE id = ? ORDER BY connected_storage_id").all(SEASON) as Array<{ connected_storage_id: string }>;
  const drives = post.map((r) => r.connected_storage_id);
  console.log("\n=== 终态:黑镜 s1 追踪所在盘 ===", JSON.stringify(drives));
  ok("黑镜 s1 在主115 独立追踪", drives.includes(PRIMARY));
  ok("黑镜 s1 在夸克 独立追踪", drives.includes(QUARK));
  ok("没有 __unscoped__ 幽灵行(获取标记落对盘,非空作用域)", !drives.includes("__unscoped__"));

  for (const [label, drive] of [["主115", PRIMARY], ["夸克", QUARK]] as const) {
    const eps = db2
      .prepare("SELECT episode_code, json_extract(payload, '$.obtained') AS obtained FROM episode_states WHERE tracked_season_id = ? AND connected_storage_id = ? ORDER BY episode_code")
      .all(SEASON, drive) as Array<{ episode_code: string; obtained: number | string | null }>;
    // json_extract 把 JSON true 解析成 1;兼容字符串形式。
    const obtained = eps.filter((r) => r.obtained === 1 || r.obtained === "1" || r.obtained === "true").length;
    console.log(`  ${label}: ${obtained}/${eps.length} 集已获取 — ${eps.map((r) => r.episode_code).join(",")}`);
    ok(`${label} 至少获取到 1 集`, obtained >= 1);
  }
  db2.close();
} finally {
  await repo.close?.();
}
console.log(failed
  ? `\n${failed} CHECK(S) FAILED`
  : "\nMULTI-DRIVE CONCURRENT E2E PASSED — 同一剧集在主115+夸克各自独立入队、worker 串行按盘跑、两盘独立追踪+落集。结果留在库里待浏览器查验。");
process.exit(failed ? 1 : 0);

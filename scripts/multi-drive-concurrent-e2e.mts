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
process.env.MEDIA_TRACK_POSTGRES_URL = "postgresql://mediatrack:mediatrack@localhost:5432/media_track";

const PRIMARY = "cs_100000001"; // 主 115
const QUARK = "cs_quark_quark-demo-uid"; // 夸克
const CANDIDATE = "tmdb_tv_42009_s1"; // 黑镜 第一季
const SEASON = "tmdb_tv_42009_s1";

const rt = await import(path.join(repoRoot, "apps/web/lib/workflow-runtime.ts"));
const repo = rt.getWorkflowRepository();
const pg = (await import("pg")).default;
const pool = new pg.Pool({ connectionString: process.env.MEDIA_TRACK_POSTGRES_URL });

let failed = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? "ok  " : "FAIL"} ${n}`); if (!c) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runState(runId: string, drive: string): Promise<string> {
  const snap = await repo.getWorkflowRunSnapshot(runId, { accountId: "acct_default", connectedStorageId: drive });
  return snap?.workflowRun.status ?? "(gone)";
}

try {
  // Pre: 黑镜 on NEITHER drive (clean concurrent demo).
  const pre = await pool.query("select connected_storage_id from tracked_seasons where id=$1", [SEASON]);
  ok("precondition: 黑镜 s1 tracked on neither drive", pre.rows.length === 0);

  // === Enqueue on BOTH drives (= two 获取 clicks, back-to-back) ===
  const qa = await rt.queueCandidateTracking(CANDIDATE, PRIMARY);
  const qb = await rt.queueCandidateTracking(CANDIDATE, QUARK);
  console.log("enqueue 主115:", JSON.stringify(qa));
  console.log("enqueue 夸克:", JSON.stringify(qb));
  ok("主115 enqueue accepted", qa.status === "queued" && !!qa.workflowRunId);
  ok("夸克 enqueue accepted (independent of 主115)", qb.status === "queued" && !!qb.workflowRunId);
  ok("the two runs are distinct workflow_runs", qa.workflowRunId !== qb.workflowRunId);

  // === (2) Concurrent DB state right after enqueue ===
  const active = await pool.query(
    "select id, connected_storage_id, (payload->>'status') as status from workflow_runs where tracked_season_id=$1 order by connected_storage_id",
    [SEASON],
  );
  console.log("\n=== 并发瞬时 DB 状态(两条 run,各自盘) ===");
  for (const r of active.rows) console.log(`  run ${r.id.slice(0, 12)}… | drive=${r.connected_storage_id} | status=${r.status}`);
  ok("两条 run 分属两块盘(各自 scope)", new Set(active.rows.map((r: any) => r.connected_storage_id)).size === 2 &&
    active.rows.some((r: any) => r.connected_storage_id === PRIMARY) &&
    active.rows.some((r: any) => r.connected_storage_id === QUARK));

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
  const post = await pool.query("select connected_storage_id from tracked_seasons where id=$1 order by connected_storage_id", [SEASON]);
  const drives = post.rows.map((r: any) => r.connected_storage_id);
  console.log("\n=== 终态:黑镜 s1 追踪所在盘 ===", JSON.stringify(drives));
  ok("黑镜 s1 在主115 独立追踪", drives.includes(PRIMARY));
  ok("黑镜 s1 在夸克 独立追踪", drives.includes(QUARK));
  ok("没有 __unscoped__ 幽灵行(获取标记落对盘,非空作用域)", !drives.includes("__unscoped__"));

  for (const [label, drive] of [["主115", PRIMARY], ["夸克", QUARK]] as const) {
    const eps = await pool.query(
      "select episode_code, (payload->>'obtained') AS obtained from episode_states where tracked_season_id=$1 and connected_storage_id=$2 order by episode_code",
      [SEASON, drive],
    );
    const obtained = eps.rows.filter((r: any) => r.obtained === "true").length;
    console.log(`  ${label}: ${obtained}/${eps.rows.length} 集已获取 — ${eps.rows.map((r: any) => r.episode_code).join(",")}`);
    ok(`${label} 至少获取到 1 集`, obtained >= 1);
  }
} finally {
  await pool.end();
}
console.log(failed
  ? `\n${failed} CHECK(S) FAILED`
  : "\nMULTI-DRIVE CONCURRENT E2E PASSED — 同一剧集在主115+夸克各自独立入队、worker 串行按盘跑、两盘独立追踪+落集。结果留在库里待浏览器查验。");
process.exit(failed ? 1 : 0);

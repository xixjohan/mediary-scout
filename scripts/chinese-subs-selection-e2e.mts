// Behavioral verification of the Chinese-subtitle SELECTION fix.
// Runs a REAL movie acquisition (default account / real 115 TEST root / real PanSou /
// real agent) with preferredLanguage=中文 + quality=medium, and asserts on what the
// AGENT SELECTED (snap.decisions): for a title whose 115-reachable recall has BOTH an
// English scene rip (Name.Year...-GROUP, no 中文 subs) AND a Chinese-community 中字
// release, the agent must pick the 中字 one — NOT the English scene rip it used to
// (the 挽救计划→Project.Hail.Mary...EaZy.mkv bug).
//
//   MEDIA_TRACK_MOVIES_PARENT_CID=<115 TEST Movies cid> npx tsx scripts/chinese-subs-selection-e2e.mts
//
// Uses FRESH titles (cleaned up before+after) so it never touches the real library.
// Lands into the TEST Movies root; recycles anything that landed.
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
process.env.MEDIA_TRACK_POSTGRES_URL ??= "postgresql://mediatrack:mediatrack@localhost:5432/media_track";

const rt = await import(path.join(repoRoot, "apps/web/lib/workflow-runtime.ts"));
const wf = await import("@media-track/workflow");
const repo = rt.getWorkflowRepository();
const pool = new pg.Pool({ connectionString: process.env.MEDIA_TRACK_POSTGRES_URL! });

const ACCT = "acct_default";
// Big recent films whose 115 recall usually carries BOTH an English scene rip AND a
// Chinese-community 中字 release. Tried in order until one's recall has both (the
// gate); skip ones already tracked so we never clobber the real library.
const TARGETS = ["沙丘2", "死侍与金刚狼", "头脑特工队2", "功夫熊猫4", "哥斯拉大战金刚2"];
const SCENE = /\b(EaZy|Guyute|RARBG|NTb|FLUX|CMCT|playWEB|FRDS|HDChina|YIFY|YTS)\b/i;
const ZH = /中字|双语|简繁|国语|中英|内封.{0,4}字幕|特效字幕/;

let failed = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? "ok  " : "FAIL"} ${n}`); if (!c) failed++; };
const blob = (c: { title: string; qualityHints: string[] }) => `${c.title} ${(c.qualityHints ?? []).join(" ")}`;

async function tmdbId(query: string): Promise<number | null> {
  const url = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(query)}&language=zh-CN`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.TMDB_READ_TOKEN}` } });
  const json = (await res.json()) as { results?: Array<{ id: number }> };
  return json.results?.[0]?.id ?? null;
}

async function isTracked(titleId: string): Promise<boolean> {
  const r = await pool.query("SELECT 1 FROM tracked_seasons WHERE media_title_id=$1 LIMIT 1", [titleId]);
  return r.rows.length > 0;
}

async function cleanup(titleId: string) {
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

async function driveUntilTerminal(runId: string) {
  for (let i = 0; i < 8; i++) {
    const result = await rt.runNextQueuedWorkflow();
    console.log(`  worker tick ${i + 1}: ${JSON.stringify(result)}`);
    const snap = await repo.getWorkflowRunSnapshot(runId, ACCT);
    const status = snap?.workflowRun.status;
    if (status && status !== "queued" && status !== "running") return snap;
    if (result.status === "idle") break;
  }
  return repo.getWorkflowRunSnapshot(runId, ACCT);
}

try {
  if (!process.env.MEDIA_TRACK_MOVIES_PARENT_CID) {
    console.log("SET MEDIA_TRACK_MOVIES_PARENT_CID to a 115 TEST Movies dir first — refusing to touch the real library.");
    process.exit(2);
  }
  await repo.setAccountSetting(ACCT, rt.QUALITY_PREFERENCE_SETTING_KEY, "medium");
  await repo.setAccountSetting(ACCT, rt.PREFERRED_LANGUAGE_SETTING_KEY, "中文");
  console.log("acct_default: quality=medium, language=中文");
  const cookie = (await repo.getSetting("pan115.cookie"))?.trim();
  const client = cookie ? new wf.Pan115CookieClient({ cookie, listPageDelayMs: 0 }) : null;

  let chosen: string | null = null;
  for (const query of TARGETS) {
    const id = await tmdbId(query);
    if (!id) { console.log(`(skip ${query}: TMDB miss)`); continue; }
    const titleId = `tmdb_movie_${id}`;
    if (await isTracked(titleId)) { console.log(`(skip ${query}: already in your library — won't clobber)`); continue; }
    console.log(`\n=== TRY ${query} (${titleId}) ===`);
    await cleanup(titleId);

    const res = await rt.queueCandidateTracking(titleId);
    if (res.status !== "queued" || !res.workflowRunId) { console.log(`(skip ${query}: not queued — ${JSON.stringify(res)})`); continue; }
    const snap = await driveUntilTerminal(res.workflowRunId);
    if (!snap) { console.log(`(skip ${query}: no snapshot)`); await cleanup(titleId); continue; }

    const allCandidates = snap.resourceSnapshots.flatMap((s) => s.candidates);
    const sceneInRecall = allCandidates.filter((c) => SCENE.test(c.title));
    const zhInRecall = allCandidates.filter((c) => ZH.test(blob(c)));
    console.log(`  recall: ${allCandidates.length} candidates | 英文scene ${sceneInRecall.length} | 中字 ${zhInRecall.length}`);

    // Gate: only meaningful if BOTH an English-scene rip AND a 中字 release were reachable.
    if (sceneInRecall.length === 0 || zhInRecall.length === 0) {
      console.log(`  (inconclusive for ${query}: recall lacked both — trying next)`);
      // recycle anything that landed for this fresh title, then clear tracking
      if (client) {
        const items = await client.listItems({ directoryId: process.env.MEDIA_TRACK_MOVIES_PARENT_CID! });
        const landed = items.filter((it: any) => new RegExp(query.slice(0, 3)).test(String(it.n ?? "")));
        if (landed.length) await client.deleteFiles(landed.map((it: any) => String(it.fid ?? it.fileId)));
      }
      await cleanup(titleId);
      continue;
    }

    chosen = query;
    const selectedIds = new Set(snap.decisions.flatMap((d) => d.selectedCandidateIds));
    const selected = allCandidates.filter((c) => selectedIds.has(c.id));
    console.log(`  英文scene 候选: ${sceneInRecall.slice(0, 2).map((c) => c.title).join(" | ")}`);
    console.log(`  中字 候选: ${zhInRecall.slice(0, 2).map((c) => c.title).join(" | ")}`);
    console.log(`  selected: ${selected.map((c) => c.title).join(" | ") || "(none)"}`);

    ok(`[${query}] recall HAD an English-scene rip AND a 中字 release (replicates the bug)`, true);
    ok(`[${query}] agent SELECTED a 中字 release`, selected.some((c) => ZH.test(blob(c))));
    ok(`[${query}] agent did NOT select a pure English-scene rip`, selected.length > 0 && !selected.some((c) => SCENE.test(c.title) && !ZH.test(blob(c))));

    // recycle what landed in the TEST dir, then clear tracking
    if (client) {
      const items = await client.listItems({ directoryId: process.env.MEDIA_TRACK_MOVIES_PARENT_CID! });
      const landed = items.filter((it: any) => new RegExp(query.slice(0, 3)).test(String(it.n ?? "")));
      if (landed.length) { await client.deleteFiles(landed.map((it: any) => String(it.fid ?? it.fileId))); console.log(`  recycled: ${landed.map((it: any) => it.n).join(" | ")}`); }
    }
    await cleanup(titleId);
    break;
  }

  if (!chosen) { console.log("\nINCONCLUSIVE: no target's 115 recall had BOTH an English-scene AND a 中字 candidate this run (PanSou jitter / brand filter). Re-run."); failed++; }
} finally {
  await pool.end();
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nCHINESE-SUBS SELECTION E2E PASSED — agent 选了中文社区中字源,没选英文 scene 版");
process.exit(failed ? 1 : 0);

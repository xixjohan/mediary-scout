#!/usr/bin/env node
// Live-verify the soft-TTL dead-link against the REAL dev SQLite DB: proves the
// dead_links table carries `permanent` and the SQL TTL filter resurrects a soft
// magnet link past its TTL while a permanent 115-share death never resurrects.
// Cleans up its rows.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadDotEnv, appDbPath, openAppDb } from "./_lib/sqlite-db.mjs";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv();

const { createSqliteWorkflowRepository } = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const repo = createSqliteWorkflowRepository({ path: appDbPath() });

const t0 = "2026-06-16T00:00:00.000Z";
const softKey = "magnet:ttl_live_test_hash", permKey = "115:ttl_live_test_share";
let pass = true;
try {
  await repo.recordDeadLink({ key: permKey, kind: "pan115", reason: "分享已取消", permanent: true, now: t0 });
  await repo.recordDeadLink({ key: softKey, kind: "magnet", reason: "no 秒传", permanent: false, now: t0 });

  const within = new Set(await repo.listDeadLinkKeys({ now: "2026-06-18T00:00:00.000Z" })); // +2d
  const past = new Set(await repo.listDeadLinkKeys({ now: "2026-07-16T00:00:00.000Z" }));   // +30d

  const a = within.has(softKey) && within.has(permKey);
  const b = !past.has(softKey) && past.has(permKey);
  console.log(`within TTL (+2d): soft=${within.has(softKey)} perm=${within.has(permKey)}  ${a ? "✅ both filtered" : "❌"}`);
  console.log(`past TTL (+30d):  soft=${past.has(softKey)} perm=${past.has(permKey)}  ${b ? "✅ soft resurrected, perm stays dead" : "❌"}`);
  pass = a && b;
} finally {
  const db = openAppDb();
  const r = db.prepare("DELETE FROM dead_links WHERE key IN (?, ?)").run(softKey, permKey);
  console.log(`cleanup: removed ${r.changes} test row(s)`);
  db.close();
}
console.log(pass ? "\n✅ PASS — SQLite TTL dead-link works (soft resurrects, permanent stays)" : "\n❌ FAIL");
process.exit(pass ? 0 : 1);

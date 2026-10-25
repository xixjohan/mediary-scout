#!/usr/bin/env node
// Reset the dev DB's test DATA (media titles, tracked seasons, episodes,
// workflow runs, resource snapshots, decisions, transfer attempts, notifications,
// tmdb cache, ...) while PRESERVING app_settings — the 115 cookie + push config —
// so the user NEVER has to re-QR-login. Credentials are backed up first.
//
// Pure-SQLite single engine (task S1.4b): this script DELETEs from every table
// except the preserved ones in the SQLite file the web app uses
// (MEDIA_TRACK_SQLITE_PATH). The old SQLite version silently no-op'd on the live DB.
//
//   node scripts/reset-dev-db.mjs          # dry run: back up creds + show plan
//   node scripts/reset-dev-db.mjs --apply  # wipe data rows, keep app_settings

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadDotEnv, openAppDb } from "./_lib/sqlite-db.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRESERVE = new Set(["app_settings"]);

loadDotEnv();
const apply = process.argv.includes("--apply");
const db = openAppDb();

try {
  // 1. Back up every setting (cookie, cookieMeta, push_*) to a gitignored file.
  const settings = db.prepare("SELECT key, value FROM app_settings ORDER BY key").all();
  const backupPath = path.join(repoRoot, ".media-track-credentials-backup.json");
  writeFileSync(backupPath, JSON.stringify({ savedAt: new Date().toISOString(), settings }, null, 2));
  const cookie = settings.find((s) => s.key === "pan115.cookie");
  console.log(
    `backed up ${settings.length} settings -> ${path.basename(backupPath)} ` +
      `(115 cookie: ${cookie ? "PRESENT len=" + String(cookie.value).length : "MISSING"})`,
  );

  // 2. Plan: every table except the preserved ones.
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const toReset = tables.filter((t) => !PRESERVE.has(t));
  console.log("\nall tables:", tables.join(", "));
  console.log("will RESET:", toReset.join(", "));
  console.log("will KEEP :", tables.filter((t) => PRESERVE.has(t)).join(", "));

  if (!apply) {
    console.log("\n(dry run) cookie backed up. pass --apply to wipe data rows.");
  } else {
    if (toReset.length > 0) {
      // Count first so the report shows what was wiped, then DELETE them all in
      // one transaction — no FK constraints in this schema, order is belt+braces.
      for (const t of toReset) {
        const c = db.prepare(`SELECT count(*) AS c FROM "${t}"`).get().c;
        console.log(`  reset ${t}: ${c} -> 0`);
      }
      const wipe = db.transaction(() => {
        for (const t of toReset) {
          db.prepare(`DELETE FROM "${t}"`).run();
        }
      });
      wipe();
    }

    // 3. Verify the 115 cookie survived (it lives in the preserved app_settings).
    const after = db.prepare("SELECT value FROM app_settings WHERE key = 'pan115.cookie'").get();
    console.log(
      `\napp_settings preserved; 115 cookie still present: ${
        after?.value ? "YES len=" + String(after.value).length : "MISSING (restore from backup!)"
      }`,
    );
  }
} finally {
  db.close();
}

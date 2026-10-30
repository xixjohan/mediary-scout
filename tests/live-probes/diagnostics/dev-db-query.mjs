#!/usr/bin/env node
// Dev-only ad-hoc query helper. Usage: node scripts/dev-db-query.mjs "<sql>"
// SQLite dialect (pure-SQLite single engine, task S1.4b): ? placeholders,
// datetime('now'), no $n. Reads MEDIA_TRACK_SQLITE_PATH or defaults to data/mediary.db.
// NOTE: connected_storages.payload and secret settings (cookies / API keys) are
// AES-256-GCM ciphertext at rest (task S1.5) — read them through the repository
// API, not raw SQL, if you want plaintext.
import { openAppDb } from "../_lib/sqlite-db.mjs";

const sql = process.argv[2];
if (!sql) {
  console.error("usage: node scripts/dev-db-query.mjs \"<sql>\"");
  process.exit(2);
}
const db = openAppDb();
const rows = db.prepare(sql).all();
for (const row of rows) {
  console.log(
    Object.entries(row)
      .map(([k, v]) => `${k}=${v && typeof v === "object" ? JSON.stringify(v) : v}`)
      .join("  |  "),
  );
}
console.log(`(${rows.length} rows)`);
db.close();

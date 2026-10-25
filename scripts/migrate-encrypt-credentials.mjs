#!/usr/bin/env node
// One-shot migration: rewrite LEGACY PLAINTEXT credentials as AES-256-GCM
// ciphertext (task S1.5 / P15). Idempotent — rows already carrying the enc:v1:
// prefix are skipped, so re-running is safe.
//
//   node scripts/migrate-encrypt-credentials.mjs           # dry run: report only
//   node scripts/migrate-encrypt-credentials.mjs --apply   # rewrite in place
//
// Covers: connected_storages.payload (every drive's cookie), app_settings and
// account_settings rows whose key is secret (see isSecretSettingKey). Run it once
// after upgrading; the app encrypts on every write from then on by itself.
import { initCredentialCryptoForDatabase, encryptSecret, isEncrypted } from "@media-track/shared";
import { isSecretSettingKey } from "@media-track/workflow";
import { appDbPath, loadDotEnv, openAppDb } from "./_lib/sqlite-db.mjs";

loadDotEnv();
const apply = process.argv.includes("--apply");
const db = openAppDb();
initCredentialCryptoForDatabase(appDbPath());

/** @returns {Array<{rid:number,key:string|null,value:string}>} 仍是明文、需要加密的行 */
function pending(table, column, keyColumn) {
  const rows = db
    .prepare(`SELECT rowid AS rid, ${column} AS v${keyColumn ? `, ${keyColumn} AS k` : ""} FROM ${table}`)
    .all();
  return rows
    .map((r) => ({ rid: r.rid, key: keyColumn ? r.k : null, value: r.v }))
    .filter((r) => typeof r.value === "string" && r.value.length > 0 && !isEncrypted(r.value));
}

const jobs = [
  { table: "connected_storages", column: "payload", keyColumn: null, filter: () => true },
  { table: "app_settings", column: "value", keyColumn: "key", filter: (r) => isSecretSettingKey(r.key) },
  { table: "account_settings", column: "value", keyColumn: "key", filter: (r) => isSecretSettingKey(r.key) },
];

let total = 0;
for (const job of jobs) {
  const rows = pending(job.table, job.column, job.keyColumn).filter(job.filter);
  console.log(`${job.table}.${job.column}: ${rows.length} 行待加密`);
  if (!apply || rows.length === 0) continue;
  const update = db.prepare(`UPDATE ${job.table} SET ${job.column} = ? WHERE rowid = ?`);
  const write = db.transaction((list) => {
    for (const r of list) update.run(encryptSecret(r.value), r.rid);
  });
  write(rows);
  total += rows.length;
}
db.close();
console.log(apply ? `\n已加密 ${total} 行` : "\n(dry run) 加 --apply 执行");
process.exit(0);

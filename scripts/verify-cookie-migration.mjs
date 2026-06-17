#!/usr/bin/env node
// P0.6 verify: run the legacy-cookie migration against the REAL dev Postgres and
// assert acct_default gets a connected_storage matching the global cookie + env
// CIDs, and that it is idempotent. Loads .env manually (no dotenv at root).
import fs from "node:fs";
import pg from "pg";
import {
  PostgresWorkflowRepository,
  initializeWorkflowPostgresSchema,
  migrateLegacyCookieToDefaultAccount,
  parsePan115Uid,
  DEFAULT_ACCOUNT_ID,
} from "../packages/workflow/dist/index.js";

// minimal .env loader (split on first '='; values may contain ; and ,)
for (const line of fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i === -1) continue;
  const k = t.slice(0, i).trim();
  if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim();
}

const url = process.env.MEDIA_TRACK_POSTGRES_URL || "postgresql://mediatrack:mediatrack@localhost:5432/media_track";
const pool = new pg.Pool({ connectionString: url });
await initializeWorkflowPostgresSchema(pool);
const repo = new PostgresWorkflowRepository(pool, Promise.resolve());

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failed++;
};

try {
  const globalCookie = (await repo.getSetting("pan115.cookie"))?.trim();
  check("dev DB has a legacy global cookie to migrate", !!globalCookie);
  const expectedUid = globalCookie ? parsePan115Uid(globalCookie) ?? "pan115_default" : null;

  const first = await migrateLegacyCookieToDefaultAccount({ repository: repo, env: process.env, now: new Date().toISOString() });
  console.log(`  migrate#1 → ${JSON.stringify(first)}`);

  const cs = await repo.findConnectedStorageByUid("pan115", expectedUid);
  check("connected_storage created for default account", cs?.accountId === DEFAULT_ACCOUNT_ID);
  check("cookie matches global byte-for-byte", (cs?.payload?.cookie ?? null) === globalCookie);
  check("tv_cid backfilled from env", cs?.tvCid === (process.env.MEDIA_TRACK_TV_PARENT_CID ?? null));
  check("movies_cid backfilled from env", cs?.moviesCid === (process.env.MEDIA_TRACK_MOVIES_PARENT_CID ?? null));
  check("anime_cid backfilled from env", cs?.animeCid === (process.env.MEDIA_TRACK_ANIME_PARENT_CID ?? null));

  const second = await migrateLegacyCookieToDefaultAccount({ repository: repo, env: process.env, now: new Date().toISOString() });
  check("idempotent: second run migrates nothing", second.migrated === false);
  check("idempotent: still exactly one pan115 connection", (await repo.listConnectedStorages(DEFAULT_ACCOUNT_ID)).filter((c) => c.provider === "pan115").length === 1);
} finally {
  await pool.end();
}

console.log(failed === 0 ? "\nMIGRATION VERIFIED" : `\n${failed} CHECKS FAILED`);
process.exit(failed === 0 ? 0 : 1);

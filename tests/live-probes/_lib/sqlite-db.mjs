// Shared script helper: open the app's SQLite database (pure-SQLite single engine,
// task S1.4b). Replaces the old pg.Pool/pg.Client plumbing — every probe/seed/verify
// script now talks to the same file the web process does.
//
//   import { openAppDb, appDbPath } from "./_lib/sqlite-db.mjs";
//   const db = openAppDb();
//   db.prepare("SELECT value FROM app_settings WHERE key = ?").get("pan115.cookie");
//
// better-sqlite3 is synchronous; the old `await client.query(...)` sites just drop
// the await. SQL dialect notes for conversions:
//   $1/$2 placeholders      -> ? positional
//   now()                   -> datetime('now')
//   INSERT ... ON CONFLICT  -> same syntax (SQLite supports it)
//   RETURNING               -> supported (SQLite >= 3.35)
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadDotEnv(envPath = path.join(repoRoot, ".env")) {
  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[t.slice(0, i).trim()] === undefined) process.env[t.slice(0, i).trim()] = v;
  }
}

/** The SQLite file the app uses. Env wins; .env fallback; default data/mediary.db. */
export function appDbPath() {
  if (process.env.MEDIA_TRACK_SQLITE_PATH?.trim()) return process.env.MEDIA_TRACK_SQLITE_PATH.trim();
  try {
    const line = readFileSync(path.join(repoRoot, ".env"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("MEDIA_TRACK_SQLITE_PATH="));
    if (line) return line.slice("MEDIA_TRACK_SQLITE_PATH=".length).trim().replace(/^["']|["']$/g, "");
  } catch {
    /* no .env — fall through */
  }
  return "data/mediary.db";
}

/** Open the app DB with the golden pragma set (see sqlite.ts). Caller closes it. */
export function openAppDb() {
  const file = appDbPath();
  mkdirSync(dirname(resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -64000");
  db.pragma("foreign_keys = ON");
  return db;
}

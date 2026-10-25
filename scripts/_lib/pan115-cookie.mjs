// Shared probe-script helper: load .env and pull the live 115 cookie from
// SQLite (app_settings key "pan115.cookie"), then set process.env.PAN115_COOKIE.
// Pure-SQLite single engine (task S1.4b): the same file the web process uses.
// Returns the cookie string (also sets the env var).
import { loadDotEnv, openAppDb } from "./sqlite-db.mjs";

export { loadDotEnv } from "./sqlite-db.mjs";

export function loadPan115Cookie() {
  loadDotEnv();
  const db = openAppDb();
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("pan115.cookie");
    if (!row?.value) {
      throw new Error("No pan115.cookie in SQLite app_settings — is the 115 account scanned/connected?");
    }
    process.env.PAN115_COOKIE = String(row.value);
    return String(row.value);
  } finally {
    db.close();
  }
}

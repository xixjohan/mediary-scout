// Owner escape hatch: reset ANY account's password (incl. the owner) from the box
// itself — for when someone (or the owner) forgets and no admin can reach the panel.
//   docker compose exec web node scripts/reset-password.mjs <username> [newPassword]
// No password arg → a random one is generated and printed. Revokes the account's
// sessions so the old (forgotten) cookie can't linger.
//
// SELF-CONTAINED ON PURPOSE: the Next `output: standalone` runner bundles
// @media-track/workflow into .next (NOT resolvable as a module) and ships no
// packages/workflow/dist — so this script must NOT import the workflow package. It
// uses `better-sqlite3` (the same native module the standalone web process opens
// /app/data/mediary.db with) + raw SQL, and replicates the scrypt hash format from
// packages/workflow/src/auth/password.ts EXACTLY:
//   stored = `scrypt:<saltHex(16B)>:<keyHex(64B)>`. If that KDF ever changes, update
// this script too.
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

const scrypt = promisify(scryptCb);

async function hashPassword(plain) {
  const salt = randomBytes(16);
  const key = await scrypt(plain, salt, 64);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

/** 纯 SQLite 单引擎（任务单 S1.4b）：compose 注入 MEDIA_TRACK_SQLITE_PATH；
 *  dev shell 下 best-effort 读 ./.env，让 `node scripts/...` 直接可用。 */
function resolveDbPath() {
  if (process.env.MEDIA_TRACK_SQLITE_PATH?.trim()) return process.env.MEDIA_TRACK_SQLITE_PATH.trim();
  try {
    const line = readFileSync(".env", "utf8")
      .split("\n")
      .find((l) => l.startsWith("MEDIA_TRACK_SQLITE_PATH="));
    if (line) return line.slice("MEDIA_TRACK_SQLITE_PATH=".length).trim().replace(/^["']|["']$/g, "");
  } catch {
    /* no .env — fall through */
  }
  return "data/mediary.db";
}

const username = process.argv[2];
if (!username) {
  console.error("用法: node scripts/reset-password.mjs <username> [newPassword]");
  process.exit(1);
}
const newPassword = process.argv[3] ?? randomBytes(6).toString("base64url");

const db = new Database(resolveDbPath());
db.pragma("busy_timeout = 5000");
let exitCode = 0;
try {
  const account = db.prepare("SELECT id FROM accounts WHERE username = ?").get(username);
  if (!account) {
    console.error(`找不到账号: ${username}`);
    exitCode = 1;
  } else {
    const hash = await hashPassword(newPassword);
    // Atomic: rotate the hash AND revoke sessions together, so a failed DELETE can't
    // leave the password changed while old session cookies still work.
    const rotate = db.transaction(() => {
      db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").run(hash, account.id);
      db.prepare("DELETE FROM sessions WHERE account_id = ?").run(account.id);
    });
    rotate();
    console.log(`已重置账号「${username}」的密码为: ${newPassword}`);
    console.log("请用该密码登录后到「设置 → 修改密码」改成你自己的。");
  }
} catch (err) {
  // SQLITE_ERROR + "no such table: accounts" = schema not initialized yet (web never
  // started once). better-sqlite3 不暴露稳定错误码,按 message 匹配。
  if (err && typeof err === "object" && /no such table/.test(String(err.message))) {
    console.error("数据库尚未初始化(accounts 表不存在)。请先启动一次 web 服务完成 schema 初始化,再跑本脚本。");
    exitCode = 1;
  } else {
    throw err;
  }
} finally {
  db.close();
}
process.exit(exitCode);

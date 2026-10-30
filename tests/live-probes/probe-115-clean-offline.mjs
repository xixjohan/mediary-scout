#!/usr/bin/env node
// List the account's cloud-download (offline) tasks and cancel the junk ones —
// tasks stuck at 0% (non-秒传 that never materialized). Completed downloads are
// left alone. Test account only; delete freely.
//
//   node scripts/probe-115-clean-offline.mjs          # dry run (list only)
//   node scripts/probe-115-clean-offline.mjs --apply  # actually cancel 0% junk

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadDotEnv(p) {
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv(path.join(repoRoot, ".env"));

const { Pan115CookieClient } = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const client = new Pan115CookieClient({ cookie: process.env.PAN115_COOKIE });
const apply = process.argv.includes("--apply");

const junk = [];
for (let page = 1; page <= 20; page += 1) {
  const tasks = await client.listOfflineTasks({ page });
  if (tasks.length === 0) break;
  for (const t of tasks) {
    if (t.percentDone === 0) junk.push(t);
  }
  if (tasks.length < 30) break;
}

console.log(`found ${junk.length} stuck (0%) task(s):`);
for (const t of junk) console.log(`  ${t.infoHash}  [${t.statusText}]  ${t.name}`);

if (!apply) {
  console.log("\n(dry run — pass --apply to cancel these)");
} else if (junk.length > 0) {
  const result = await client.removeOfflineTask({ infoHashes: junk.map((t) => t.infoHash) });
  console.log("\nremoveOfflineTask result:", JSON.stringify(result));
  const after = (await client.listOfflineTasks({ page: 1 })).filter((t) => t.percentDone === 0);
  console.log("remaining 0% tasks on page 1:", after.length);
}

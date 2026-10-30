#!/usr/bin/env node
// Probe: cancel a 115 cloud-download (offline) task by its info_hash via our
// cookie client's removeOfflineTask (RSA-encrypted lixianssp `ac=task_del`).
// Settles whether the delete method actually works against the live API.
//
// The two junk tasks the user left downloading at 0% are the test targets; the
// second one's display name IS a 40-hex info_hash, so we can cancel it directly.
//
//   node scripts/probe-115-remove-offline.mjs <info_hash> [<info_hash> ...]
//
// With no args it defaults to the known junk hash from the screenshot.

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

const hashes = process.argv.slice(2);
if (hashes.length === 0) {
  hashes.push("57e6d442793c87d7f81eecc675ab4eb3b4925bd3");
}

const client = new Pan115CookieClient({ cookie: process.env.PAN115_COOKIE });

console.log("cancelling offline task(s):", JSON.stringify(hashes));
const result = await client.removeOfflineTask({ infoHashes: hashes });
console.log("removeOfflineTask result:", JSON.stringify(result));

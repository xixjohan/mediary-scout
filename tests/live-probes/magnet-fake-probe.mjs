#!/usr/bin/env node
// Test the user's hypothesis: a FAKE / non-existent magnet (random infohash, no
// real torrent) — what does 115 show as the offline-task name? If it's garbled /
// the raw infohash, that's likely the "乱码名" they saw. Transfers several fake
// infohashes (no dn, an all-0, an all-f, plus a fake WITH a junk dn) and captures
// name / statusText / percentDone. TEST ROOT only; cancels + cleans up.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadDotEnv(p) { let raw; try { raw = readFileSync(p, "utf8"); } catch { return; }
  for (const line of raw.split("\n")) { const t = line.trim(); if (!t || t.startsWith("#")) continue; const eq = t.indexOf("="); if (eq === -1) continue; const k = t.slice(0, eq).trim(); let v = t.slice(eq + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (process.env[k] === undefined) process.env[k] = v; } }
loadDotEnv(path.join(repoRoot, ".env"));

const { createProtectedPan115CookieStorageExecutorFromEnv, Pan115CookieClient } =
  await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const testRoot = process.env.MEDIA_TRACK_115_TEST_ROOT_CID;
const storage = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });
const client = new Pan115CookieClient({ cookie: process.env.PAN115_COOKIE });

const randHex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cases = [
  ["random fake #1 (no dn)", `magnet:?xt=urn:btih:${randHex(40)}`],
  ["random fake #2 (no dn)", `magnet:?xt=urn:btih:${randHex(40)}`],
  ["all-zero infohash", "magnet:?xt=urn:btih:0000000000000000000000000000000000000000"],
  ["all-f infohash", "magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff"],
  ["fake WITH junk dn", `magnet:?xt=urn:btih:${randHex(40)}&dn=%FF%FE%AB%CD%garbage`],
];

const infoHashOf = (u) => (u.match(/btih:([0-9a-fA-F]{40})/) ?? [])[1]?.toLowerCase() ?? null;

for (const [label, url] of cases) {
  const h = infoHashOf(url);
  const dir = await storage.createDirectory({ name: `fakeprobe-${Date.now()}-${h.slice(0, 6)}`, parentId: testRoot });
  const add = await client.addOfflineTask({ url, directoryId: dir });
  let name = "", statusText = "", pct = "-";
  if (add.ok && !add.alreadyTransferred) {
    for (let i = 0; i < 4; i += 1) {
      await sleep(1800);
      try { const tasks = await client.listOfflineTasks({ page: 1 }); const t = tasks.find((x) => x.infoHash?.toLowerCase() === h); if (t) { name = t.name; statusText = t.statusText; pct = t.percentDone; } } catch {}
    }
  }
  // show the name AND its raw code points so true mojibake/hex is unambiguous
  const codes = [...name].slice(0, 12).map((ch) => "U+" + ch.codePointAt(0).toString(16).padStart(4, "0")).join(" ");
  console.log(`\n${label}\n  infohash: ${h}\n  addOfflineTask → ${JSON.stringify(add)}`);
  console.log(`  offline-task: name=${JSON.stringify(name)}  statusText=${JSON.stringify(statusText)} pct=${pct}`);
  console.log(`  name codepoints: ${codes || "(empty)"}  ${name.toLowerCase() === h ? "← NAME == INFOHASH" : ""}`);
  try { await client.removeOfflineTask({ infoHashes: [h] }); } catch {}
  try { await storage.removeDirectory(dir); } catch {}
}
console.log("\nDone.");

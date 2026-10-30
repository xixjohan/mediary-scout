#!/usr/bin/env node
// systematic-debugging Phase 1 — EVIDENCE for the magnet dead-link methodology.
// For each magnet: addOfflineTask, then poll BOTH the landing dir AND the offline
// task fields (status / statusText / percentDone) every ~1.5s for ~30s, printing
// a timeline. Answers three questions the #14 single data point left open:
//   (a) how fast does a real 秒传 land at the drop dir? (window sizing)
//   (b) what do the offline-task fields look like FOR a 秒传 over time — does
//       percentDone ever reach 100, or is statusText="下载成功" the real signal?
//   (c) what does a dead / no-cache magnet look like (the "stuck forever" case)?
// TEST ROOT only; cancels every task + removes every dir at the end.
//
//   node scripts/magnet-probe-timing.mjs            # default: known-秒传 + a fake-infohash dead one
//   node scripts/magnet-probe-timing.mjs "<magnet>" ...

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

const { Pan115CookieClient, createProtectedPan115CookieStorageExecutorFromEnv } = await import(
  path.join(repoRoot, "packages/workflow/dist/index.js")
);

const testRoot = process.env.MEDIA_TRACK_115_TEST_ROOT_CID;
const storage = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });
const client = new Pan115CookieClient({ cookie: process.env.PAN115_COOKIE });

const DEFAULTS = [
  // Known 秒传 from #14 (Oppenheimer UHD remux) — re-measure landing time + fields.
  ["KNOWN-秒传 (Oppenheimer)", "magnet:?xt=urn:btih:edef9b0fc91c9ccdf5b3e43f6cc5278160e81dd5"],
  // A syntactically valid but almost-certainly-uncached infohash — the "115
  // accepts it, queues a real download, nothing ever lands" dead case.
  ["FAKE infohash (expect dead/no-cache)", "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"],
];

const argv = process.argv.slice(2);
const magnets = argv.length > 0 ? argv.map((m, i) => [`arg #${i}`, m]) : DEFAULTS;

const infoHashOf = (m) => (m.match(/btih:([0-9a-fA-F]{40})/) ?? [])[1]?.toLowerCase() ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [label, magnet] of magnets) {
  const hash = infoHashOf(magnet);
  console.log(`\n${"=".repeat(74)}\n${label}\n  ${magnet.slice(0, 70)}\n  infohash: ${hash}`);
  const dir = await storage.createDirectory({ name: `mtiming-${Date.now()}-${(hash ?? "x").slice(0, 6)}`, parentId: testRoot });

  const tAdd = Date.now();
  const add = await client.addOfflineTask({ url: magnet, directoryId: dir });
  console.log(`  [+0.0s] addOfflineTask → ${JSON.stringify(add)}`);
  if (!add.ok) {
    console.log(`  → rejected fail-loud, no task queued. (cleanup dir)`);
    try { await storage.removeDirectory(dir); } catch {}
    continue;
  }

  let firstVideoAt = null;
  for (let i = 0; i < 18; i += 1) {
    await sleep(1500);
    const elapsed = ((Date.now() - tAdd) / 1000).toFixed(1);
    let videos = 0;
    try {
      const tree = await storage.listTree({ directoryId: dir });
      videos = tree.filter((f) => /\.(mkv|mp4|avi|ts|m2ts|mov|flv|wmv)$/i.test(f.path)).length;
    } catch (e) {
      // listTree may transiently fail; keep going.
    }
    if (videos > 0 && firstVideoAt === null) firstVideoAt = elapsed;
    let task = null;
    try {
      const tasks = await client.listOfflineTasks({ page: 1 });
      task = hash ? tasks.find((t) => t.infoHash?.toLowerCase() === hash) : null;
    } catch {}
    const taskStr = task
      ? `status=${task.status} ${JSON.stringify(task.statusText)} pct=${task.percentDone}`
      : "(task not in list)";
    console.log(`  [+${elapsed}s] dir-videos=${videos} | offline-task ${taskStr}`);
    if (videos > 0 && i >= 2) break; // landed + a couple more samples → enough
  }

  console.log(`  RESULT: ${firstVideoAt !== null ? `秒传 — first video listed at +${firstVideoAt}s` : "NO video in ~27s (dead / no-cache)"}`);

  // Cleanup: cancel the task + remove the dir.
  if (hash) {
    try {
      const rm = await client.removeOfflineTask({ infoHashes: [hash] });
      console.log(`  cleanup removeOfflineTask → ${JSON.stringify(rm)}`);
    } catch (e) {
      console.log(`  cleanup removeOfflineTask failed: ${e.message}`);
    }
  }
  try { await storage.removeDirectory(dir); } catch (e) { console.log(`  dir cleanup failed: ${e.message}`); }
}

console.log("\nDone.");

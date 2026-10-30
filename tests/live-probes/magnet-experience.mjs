#!/usr/bin/env node
// #14 hands-on: transfer magnets ONE AT A TIME on the 115 TEST ROOT and watch
// what 115 actually does — does it 秒传 (land at the drop dir within seconds), or
// queue a real cloud download (an offline task stuck at 0% = effectively a dead
// resource we must cancel)? This is the use-it-first experience that grounds the
// dead-link DB feature (#15). TEST ROOT only — production clawd-media is never
// touched (the executor's write scope + protected-cid guards forbid it).
//
//   node scripts/magnet-experience.mjs                 # default Oppenheimer + control magnets
//   node scripts/magnet-experience.mjs "<magnet>" ...  # specific magnets
//
// For each magnet: create a fresh drop dir → addOfflineTask → poll the drop dir
// (秒传?) AND listOfflineTasks (status/percentDone) over ~16s → removeOfflineTask
// (unless 任务已存在) → delete the drop dir. Reports a per-magnet verdict.

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

const DEFAULT_MAGNETS = [
  // From PanSou "奥本海默 2023" (candidate #10) — a clean 40-hex infohash.
  "magnet:?xt=urn:btih:edef9b0fc91c9ccdf5b3e43f6cc5278160e81dd5",
  // Candidate #9 — note the junk "2160P" glued onto the infohash by PanSou's
  // loose parsing. A real-world wart the dead-link infohash extractor must survive.
  "magnet:?xt=urn:btih:8e39a62e48e3cedb488355d863a4a27df8ed720a2160P",
  // Control: Big Buck Bunny — a famous well-seeded torrent 115 very likely has
  // cached (so it should 秒传 instantly), to contrast against a dead resource.
  "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337",
];

const magnets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_MAGNETS;
const infoHashOf = (m) => (m.match(/btih:([0-9a-fA-F]{40})/) ?? [])[1] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

for (const magnet of magnets) {
  const hash = infoHashOf(magnet);
  console.log(`\n${"=".repeat(70)}\nMAGNET ${magnet.slice(0, 80)}\n  infohash: ${hash ?? "(none extracted)"}`);
  const stamp = new Date(t0).toISOString().replace(/[:.]/g, "-");
  const dir = await storage.createDirectory({ name: `magnet-exp-${stamp}-${(hash ?? "x").slice(0, 8)}`, parentId: testRoot });

  const add = await client.addOfflineTask({ url: magnet, directoryId: dir });
  console.log(`  [${since()}] addOfflineTask → ${JSON.stringify(add)}`);

  let landed = false;
  for (let i = 1; i <= 4; i += 1) {
    await sleep(4000);
    const tree = await storage.listTree({ directoryId: dir });
    const task = hash
      ? (await client.listOfflineTasks({ page: 1 })).find((x) => x.infoHash?.toLowerCase() === hash.toLowerCase())
      : null;
    console.log(
      `  [${since()}] poll ${i}: drop-dir ${tree.length} file(s)${tree.length ? " " + JSON.stringify(tree.map((f) => f.path)) : ""}` +
        (task ? ` | offline-task status=${task.status} ${JSON.stringify(task.statusText)} ${task.percentDone}%` : " | offline-task: (not in list)"),
    );
    if (tree.length > 0) {
      landed = true;
      break;
    }
  }

  // Cleanup: cancel a non-秒传 task (unless 115 said 任务已存在 — that is a prior
  // GOOD task we must not kill), then drop the experiment dir.
  if (hash && !add.alreadyTransferred) {
    const rm = await client.removeOfflineTask({ infoHashes: [hash] });
    console.log(`  [${since()}] removeOfflineTask(${hash.slice(0, 8)}…) → ${JSON.stringify(rm)}`);
  } else if (add.alreadyTransferred) {
    console.log(`  [${since()}] skip removeOfflineTask — 任务已存在 (a prior good task, never cancel)`);
  }
  try {
    await storage.removeDirectory(dir);
    console.log(`  [${since()}] removed experiment dir`);
  } catch (e) {
    console.log(`  [${since()}] dir cleanup failed: ${e.message}`);
  }

  console.log(`  VERDICT: ${landed ? "秒传 — landed at the drop dir (live resource)" : "NO 秒传 — nothing landed (dead/slow → cancel, switch candidate)"}`);
}

console.log(`\nDone (${since()}).`);

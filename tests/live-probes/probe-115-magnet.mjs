#!/usr/bin/env node
// Probe: add a KNOWN well-seeded magnet (with a display name) via our cookie
// client's addOfflineTask, into a fresh staging dir under the 115 TEST ROOT,
// then poll the dir to see whether 115 names/materializes it. Settles whether
// the magnet method is correct or corrupts the link.
//
//   node scripts/probe-115-magnet.mjs

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

// Big Buck Bunny — canonical WebTorrent test torrent: well-seeded, has a dn.
const magnet =
  "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = await storage.createDirectory({ name: `probe-magnet-${stamp}`, parentId: testRoot });
console.log("staging dir:", dir);

const result = await client.addOfflineTask({ url: magnet, directoryId: dir });
console.log("addOfflineTask result:", JSON.stringify(result));

for (let i = 1; i <= 4; i += 1) {
  await new Promise((r) => setTimeout(r, 4000));
  const tree = await storage.listTree({ directoryId: dir });
  console.log(`poll ${i} (after ${i * 4}s): ${tree.length} item(s)`, JSON.stringify(tree.map((f) => f.path)));
  if (tree.length > 0) break;
}

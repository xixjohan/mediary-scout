#!/usr/bin/env node
// Live verification of the #16 fix end-to-end: run the REAL executor's transfer()
// through RealStorageV2 (with a dead-link store) on the 115 TEST ROOT, for both
// real magnet outcomes:
//   - a stuck "等待中" magnet (fake infohash 115 accepts but never 秒传s) → the
//     executor reports no_target_change, cancels the task, and #15 records it dead;
//   - an alive magnet (Oppenheimer, cached) → NOT recorded dead.
// Proves the fixed isOfflineTaskComplete + the dead-link recorder agree with what
// 115 actually does. Cleans up dirs + tasks. TEST ROOT only.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadDotEnv(p) {
  let raw;
  try { raw = readFileSync(p, "utf8"); } catch { return; }
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

const { createProtectedPan115CookieStorageExecutorFromEnv, Pan115CookieClient, CandidateRegistry, RealStorageV2, deadLinkKey } =
  await import(path.join(repoRoot, "packages/workflow/dist/index.js"));

const testRoot = process.env.MEDIA_TRACK_115_TEST_ROOT_CID;
const executor = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });
const client = new Pan115CookieClient({ cookie: process.env.PAN115_COOKIE });

// In-memory dead-link store to observe what RealStorageV2 records.
const store = {
  recorded: [],
  async recordDeadLink(input) { this.recorded.push(input); },
  async listDeadLinkKeys() { return this.recorded.map((r) => r.key); },
};

const registry = new CandidateRegistry();
const storage = new RealStorageV2({ executor, registry, workflowRunId: "exec-deadlink-live", deadLinkStore: store });

const cases = [
  { label: "ALIVE (Oppenheimer, cached)", url: "magnet:?xt=urn:btih:edef9b0fc91c9ccdf5b3e43f6cc5278160e81dd5", expectDead: false },
  { label: "STUCK 等待中 (fake infohash, no cache)", url: "magnet:?xt=urn:btih:fedcba9876543210fedcba9876543210fedcba98", expectDead: true },
];

const dirs = [];
let pass = true;
for (const c of cases) {
  const id = `cand_${c.url.match(/btih:([0-9a-f]{8})/i)[1]}`;
  registry.record({ id, snapshotId: "s", index: 0, title: c.label, type: "magnet", source: "pansou", episodeHints: [], qualityHints: [], providerPayload: { url: c.url } });
  const dir = await executor.createDirectory({ name: `exec-dl-${Date.now()}-${id.slice(5, 11)}`, parentId: testRoot });
  dirs.push(dir);
  const before = store.recorded.length;
  const t0 = Date.now();
  const res = await storage.transferCandidate({ candidateId: id, intoDirectoryId: dir });
  const recordedThis = store.recorded.slice(before);
  const wasRecorded = recordedThis.length > 0;
  const key = deadLinkKey(c.url).key;
  const ok = wasRecorded === c.expectDead;
  if (!ok) pass = false;
  console.log(`\n${c.label}`);
  console.log(`  transfer(${((Date.now() - t0) / 1000).toFixed(1)}s) → status=${res.status}, materialized=${res.materializedFileIds.length}`);
  console.log(`  dead-linked? ${wasRecorded}${wasRecorded ? " " + JSON.stringify(recordedThis[0]) : ""} (expected ${c.expectDead})  ${ok ? "✅" : "❌"}`);
}

console.log("\n=== cleanup ===");
for (const c of cases) {
  const h = c.url.match(/btih:([0-9a-fA-F]{40})/)[1].toLowerCase();
  try { await client.removeOfflineTask({ infoHashes: [h] }); } catch {}
}
for (const dir of dirs) {
  try { await executor.removeDirectory(dir); console.log(`  removed dir ${dir}`); } catch (e) { console.log(`  dir cleanup failed: ${e.message}`); }
}
console.log(`\n${pass ? "✅ ALL PASS — alive magnet kept, stuck magnet cancelled + dead-linked" : "❌ FAIL"}`);
process.exit(pass ? 0 : 1);

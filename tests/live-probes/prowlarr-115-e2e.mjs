#!/usr/bin/env node
// Live e2e: take real magnets from Prowlarr → run the PRODUCTION 115 transfer()
// path → confirm whether 115 秒传 (hash-match) actually hits. Tries the top
// seeded magnets until one 秒传s. Honest about hit rate (Prowlarr's English
// scene/YTS infohashes may be in 115's pool less often than PanSou's CN shares).
//
//   node scripts/prowlarr-115-e2e.mjs ["search keyword"]

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

const { ProwlarrResourceProvider, createProtectedPan115CookieStorageExecutorFromEnv } = await import(
  path.join(repoRoot, "packages/workflow/dist/index.js")
);

const keyword = process.argv[2] ?? "Oppenheimer 2023";
const testRoot = process.env.MEDIA_TRACK_115_TEST_ROOT_CID;
const TOP_N = 6;

const prowlarr = new ProwlarrResourceProvider({
  baseURL: "http://192.168.100.1:9696",
  apiKey: "d5dd35656d9e4287b16613e033ed52c6",
});
const storage = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });

const snap = await prowlarr.search({ keyword });
const ranked = snap.candidates
  .filter((c) => c.providerPayload.infoHash)
  .sort((a, b) => Number(b.providerPayload.seeders ?? 0) - Number(a.providerPayload.seeders ?? 0))
  .slice(0, TOP_N);

console.log(`Prowlarr "${keyword}": ${snap.candidates.length} candidates, trying top ${ranked.length} by seeders\n`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
let hit = false;
for (let i = 0; i < ranked.length; i += 1) {
  const c = ranked[i];
  const dir = await storage.createDirectory({ name: `prowlarr-115-${stamp}-${i + 1}`, parentId: testRoot });
  let attempt;
  try {
    attempt = await storage.transfer({ workflowRunId: `prowlarr-e2e-${stamp}`, directoryId: dir, candidate: c });
  } catch (e) {
    console.log(`#${i + 1} [${c.source}] seeders=${c.providerPayload.seeders} ${c.title.slice(0, 40)}\n   THREW: ${String(e).slice(0, 100)}`);
    continue;
  }
  const files = attempt.status === "succeeded" ? await storage.listVideoFiles(dir) : [];
  console.log(`#${i + 1} [${c.source}] seeders=${c.providerPayload.seeders} btih=${String(c.providerPayload.infoHash).slice(0, 12)} ${c.title.slice(0, 38)}`);
  console.log(`   status=${attempt.status} files=${files.length} msg=${attempt.providerMessage ?? "-"}`);
  if (attempt.status === "succeeded" && files.length > 0) {
    console.log(`   ✅ 秒传 HIT → ${files[0].path} (${files[0].sizeBytes ?? "?"} bytes)`);
    hit = true;
    break;
  }
}

console.log(hit
  ? "\n✅ Prowlarr magnet → 115 秒传 confirmed (production transfer path)"
  : "\n⚠️ no 秒传 hit among top candidates — these infohashes aren't in 115's pool (expected for some English releases; agent would judge weak coverage & move on)");
process.exit(hit ? 0 : 2);

#!/usr/bin/env node
// Read-only: list the video files in a 115 directory (under the test root) with
// sizes, so we can see duplicates before deciding what to prune. Never deletes.
//
//   node scripts/probe-115-list-dir.mjs <directoryId>

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

const dirId = process.argv[2];
if (!dirId) {
  console.error("usage: node scripts/probe-115-list-dir.mjs <directoryId>");
  process.exit(1);
}

const { createProtectedPan115CookieStorageExecutorFromEnv } = await import(
  path.join(repoRoot, "packages/workflow/dist/index.js")
);
const storage = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });

const files = await storage.listVideoFiles(dirId);
const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
console.log(`dir ${dirId}: ${files.length} video file(s)`);
for (const f of files.sort((a, b) => b.sizeBytes - a.sizeBytes)) {
  console.log(`  ${gb(f.sizeBytes).padStart(10)}  ${f.providerFileId}  ${f.name}`);
}

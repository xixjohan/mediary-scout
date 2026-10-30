#!/usr/bin/env node
// Delete specific file ids from a 115 directory (under the test root), via the
// protected executor — which enforces write-scope + verifies the ids actually
// belong to that directory before deleting. Used to prune duplicate movie files
// down to the single highest-quality keeper.
//
//   node scripts/probe-115-delete-files.mjs <directoryId> <fileId> [<fileId> ...]

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

const [dirId, ...fileIds] = process.argv.slice(2);
if (!dirId || fileIds.length === 0) {
  console.error("usage: node scripts/probe-115-delete-files.mjs <directoryId> <fileId> [<fileId> ...]");
  process.exit(1);
}

const { createProtectedPan115CookieStorageExecutorFromEnv } = await import(
  path.join(repoRoot, "packages/workflow/dist/index.js")
);
const storage = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });

console.log("before:", (await storage.listVideoFiles(dirId)).map((f) => f.name));
const result = await storage.deleteFiles({ directoryId: dirId, fileIds });
console.log("deleted:", JSON.stringify(result));
console.log("after:", (await storage.listVideoFiles(dirId)).map((f) => f.name));

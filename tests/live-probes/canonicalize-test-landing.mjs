#!/usr/bin/env node
// One-off helper: build the canonical `Title (Year)/Season N` structure under
// the 115 test root and move the video files from a non-canonical smoke
// landing directory into the season leaf. Everything stays inside test root.
//
// Usage: node scripts/canonicalize-test-landing.mjs --from <oldDirCid> --title "翘楚 (2026)" --season 1

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      continue;
    }
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

function loadDotEnv(envPath) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.from || !args.title) {
  console.log('Usage: node scripts/canonicalize-test-landing.mjs --from <oldDirCid> --title "翘楚 (2026)" [--season 1]');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv(path.join(repoRoot, ".env"));

const testRoot = process.env.MEDIA_TRACK_115_TEST_ROOT_CID;
if (!testRoot || !process.env.PAN115_COOKIE) {
  console.error("Need MEDIA_TRACK_115_TEST_ROOT_CID and PAN115_COOKIE in .env");
  process.exit(1);
}

const {
  createProtectedPan115CookieStorageExecutorFromEnv,
  Pan115CookieClient,
} = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));

const executor = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });
const rawClient = new Pan115CookieClient({ cookie: process.env.PAN115_COOKIE });

console.log("[1/4] listing videos in old landing directory", args.from, "...");
const videos = await executor.listVideoFiles(args.from);
console.log(`      found ${videos.length} videos:`, videos.map((v) => v.episodeCode).sort().join(", "));
if (videos.length === 0) {
  console.error("nothing to move; aborting");
  process.exit(1);
}

console.log(`[2/4] creating canonical structure "${args.title}/Season ${args.season ?? 1}" under test root ...`);
const showDirectoryId = await executor.createDirectory({ name: args.title, parentId: testRoot });
const seasonDirectoryId = await executor.createDirectory({
  name: `Season ${args.season ?? 1}`,
  parentId: showDirectoryId,
});
console.log("      show dir:", showDirectoryId, "season dir:", seasonDirectoryId);

console.log("[3/4] moving video files into the season leaf (within test root) ...");
const moveResult = await rawClient.moveItems({
  fileIds: videos.map((video) => video.providerFileId),
  targetDirectoryId: seasonDirectoryId,
});
console.log("      move result:", JSON.stringify(moveResult));

console.log("[4/4] verifying ...");
const after = await executor.listVideoFiles(seasonDirectoryId);
console.log(`      season leaf now has ${after.length} videos:`, after.map((v) => v.episodeCode).sort().join(", "));
console.log("\nseason directory cid:", seasonDirectoryId);

// Inspect the REAL 115 state of a title's acquisition dirs (verification, not
// assumption): does staging leak, what's in it, what's the dir naming.
//   npm run build:workflow && node scripts/inspect-115.mjs 斗破苍穹
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv, loadPan115Cookie } from "./_lib/pan115-cookie.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv();
await loadPan115Cookie();
const mod = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const executor = mod.createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });

const needle = process.argv[2] ?? "斗破苍穹";
const ANIME = process.env.MEDIA_TRACK_ANIME_PARENT_CID;

async function subdirs(cid, label) {
  try {
    const subs = await executor.listSubdirectories({ directoryId: String(cid), maxDepth: 1 });
    console.log(`\n[${label}] cid=${cid} → ${subs.length} subdir(s):`);
    for (const s of subs) console.log(`   DIR  ${s.path}   (id=${s.id})`);
    return subs;
  } catch (e) {
    console.log(`\n[${label}] cid=${cid} → SUBDIR ERROR: ${String(e).slice(0, 150)}`);
    return [];
  }
}
async function videos(cid, label) {
  try {
    const vids = await executor.listVideoFiles(String(cid));
    console.log(`   [${label}] videos=${vids.length}`);
    for (const v of vids.slice(0, 8)) console.log(`      ${JSON.stringify(v).slice(0, 160)}`);
    if (vids.length > 8) console.log(`      … +${vids.length - 8} more`);
  } catch (e) {
    console.log(`   [${label}] listVideoFiles ERROR: ${String(e).slice(0, 150)}`);
  }
}

console.log("ANIME_PARENT =", ANIME);
const shows = await subdirs(ANIME, "ANIME_PARENT");
const show = shows.find((s) => s.path.includes(needle));
if (!show) {
  console.log(`\n(no show dir matching "${needle}")`);
} else {
  const kids = await subdirs(show.id, `SHOW ${show.path}`);
  for (const k of kids) {
    if (/staging/i.test(k.path)) {
      console.log(`\n   ⚠️ STAGING STILL EXISTS: ${k.path} (id=${k.id}) — inspecting contents:`);
      await videos(k.id, "staging");
      await subdirs(k.id, "staging-subdirs");
    }
  }
}
console.log("\n(done)");

// Verify #13 against REAL 115 (not assumption): sum the landed video bytes of an
// already-acquired title's season dirs and render the exact size line the card +
// push will show. Proves the genuinely-new IO (readLandedSize) + the render.
//   npm run build:workflow && node scripts/verify-landed-size.mjs 斗破苍穹
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv, loadPan115Cookie } from "./_lib/pan115-cookie.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv();
await loadPan115Cookie();
const mod = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const { readLandedSize } = await import(
  path.join(repoRoot, "packages/workflow/dist/acquisition-v2/landed-size.js")
);
const executor = mod.createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });

const needle = process.argv[2] ?? "斗破苍穹";
const ANIME = process.env.MEDIA_TRACK_ANIME_PARENT_CID;

const shows = await executor.listSubdirectories({ directoryId: String(ANIME), maxDepth: 1 });
const show = shows.find((s) => s.path.includes(needle));
if (!show) {
  console.log(`(no show dir matching "${needle}")`);
  process.exit(0);
}
const seasons = await executor.listSubdirectories({ directoryId: String(show.id), maxDepth: 1 });
const seasonDirs = seasons.filter((s) => !/staging/i.test(s.path));
console.log(`SHOW ${show.path} → ${seasonDirs.length} season dir(s):`);
for (const s of seasonDirs) console.log(`   ${s.path} (id=${s.id})`);

const landed = await readLandedSize(executor, seasonDirs.map((s) => String(s.id)));
console.log("\nreadLandedSize →", landed);
if (landed) {
  console.log("formatBytes(total) =", mod.formatBytes(landed.totalBytes));
  // Exactly what the card/push will render for a still-airing series:
  const report = mod.buildSeasonReport({
    titleName: needle,
    season: { id: "s", mediaTitleId: "t", seasonNumber: 1, status: "active", qualityPreference: "4K", storageDirectoryId: "d", totalEpisodes: 999, latestAiredEpisode: 1, latestAiredSource: "metadata" },
    episodes: [],
    fileCount: landed.fileCount,
    totalBytes: landed.totalBytes,
  });
  console.log("landedSize(report) →", mod.landedSize(report), "  (card chip + 🎞 push line)");
}
console.log("\n(done)");

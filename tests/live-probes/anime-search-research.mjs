// Research: how should the agent search PanSou for ANIME to actually land resources?
// Read-only (PanSou search only, no 115). Compares keyword strategies per title so
// we can de-mechanize the prompt (esp. the 4K insistence).
//
//   npm run build:workflow && node scripts/anime-search-research.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Load repo-root .env (PANSOU_BASE_URL etc.) the same way next.config does.
try {
  const { readFileSync } = await import("node:fs");
  for (const line of readFileSync(path.join(repoRoot, ".env"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] ??= v;
  }
} catch {}

const { createPanSouResourceProviderFromEnv } = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const provider = createPanSouResourceProviderFromEnv();

const QUALITY = /4k|2160|1080|720|bdrip|webrip|web-dl|hevc|x265|remux|uhd/i;
function qualityBuckets(titles) {
  let hi = 0, sd = 0;
  for (const t of titles) {
    if (/4k|2160|uhd|remux/i.test(t)) hi++;
    else if (/1080|720|bdrip|webrip|web-dl|hevc|x265/i.test(t)) sd++;
  }
  return { hi4k: hi, hd: sd };
}

// title → keyword strategies to compare
const CASES = [
  { name: "莉可丽丝", kws: ["莉可丽丝", "莉可丽丝 4K", "莉可丽丝 1080P", "Lycoris Recoil", "リコリス・リコイル"] },
  { name: "一人之下", kws: ["一人之下", "一人之下 4K", "一人之下 第六季", "一人之下 全集", "Hitori no Shita"] },
  { name: "鬼灭之刃", kws: ["鬼灭之刃", "鬼灭之刃 4K", "鬼灭之刃 1080P", "Demon Slayer"] },
  { name: "间谍过家家", kws: ["间谍过家家", "间谍过家家 4K", "SPY×FAMILY"] },
  { name: "无敌少侠(美漫)", kws: ["无敌少侠", "Invincible", "Invincible 1080P"] },
  { name: "凉宫春日(老番)", kws: ["凉宫春日的忧郁", "凉宫春日", "凉宫春日 BD"] },
];

for (const c of CASES) {
  console.log(`\n========== ${c.name} ==========`);
  for (const kw of c.kws) {
    try {
      const snap = await provider.search({ keyword: kw, workflowRunId: "research" });
      const titles = snap.candidates.map((x) => x.title ?? "");
      const q = qualityBuckets(titles);
      const withQuality = titles.filter((t) => QUALITY.test(t)).length;
      console.log(
        `  ${JSON.stringify(kw).padEnd(26)} → ${String(snap.candidates.length).padStart(3)} cands | 4K:${q.hi4k} HD:${q.hd} | anyQuality:${withQuality}`,
      );
      // show top 2 titles so we can eyeball relevance
      for (const t of titles.slice(0, 2)) console.log(`        · ${t.slice(0, 80)}`);
    } catch (e) {
      console.log(`  ${JSON.stringify(kw).padEnd(26)} → ERROR ${String(e).slice(0, 80)}`);
    }
  }
}
console.log("\n(done)");

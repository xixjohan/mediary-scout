// Research for the quality-preference feature (高/中/不限).
// Read-only PanSou search (NO 115). Goal: build an EVIDENCE-BASED taxonomy of how
// quality tokens are actually written in result TITLES, per media subtype, and —
// crucially — whether each tier (高≈4K / 中≈1080p) even EXISTS per subtype. That
// availability grounds the "prefer the tier, fall back to next-best coverage" rule.
//
// Uses A.2-recommended (NON quality-polluted) keywords so recall reflects reality
// (守 search-methodology 铁律: 画质不进查询词). PanSou client file-caches, so reruns
// are free. NOT a DDoS — bounded keyword set.
//
//   node scripts/quality-token-research.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
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

const { createPanSouResourceProviderFromEnv } = await import(
  path.join(repoRoot, "packages/workflow/dist/index.js")
);
const provider = createPanSouResourceProviderFromEnv();

// Token catalog: every quality-ish token we want to count in titles.
const TOKENS = [
  // 高 tier (≈4K / UHD / remux / HDR / Dolby Vision)
  "2160p", "4K", "UHD", "REMUX", "HDR", "杜比视界", "DoVi", "DV",
  // 中 tier (≈1080p / 蓝光 / BD source)
  "1080p", "FHD", "蓝光", "BluRay", "Blu-ray", "BDRip", "BD",
  // lower / source-only (context, not a target tier)
  "720p", "WEB-DL", "WEBRip", "HDTV", "x265", "HEVC", "H265", "x264", "H264",
];
const TOKEN_RE = TOKENS.map((t) => ({
  token: t,
  // word-boundary for ascii; raw for CJK
  re: /[一-鿿]/.test(t) ? new RegExp(t, "i") : new RegExp(`(?<![A-Za-z0-9])${t.replace(/[-]/g, "\\-")}(?![A-Za-z0-9])`, "i"),
}));

const HI_RE = /2160p|\b4K\b|UHD|REMUX|杜比视界|DoVi/i; // 高 tier presence (DV/HDR alone too ambiguous → exclude from gate)
const MID_RE = /1080p|FHD|蓝光|blu-?ray|BDRip|\bBD\b/i; // 中 tier presence

// 8 subtypes × representative titles × A.2-recommended keyword (NOT quality-polluted).
const GROUPS = [
  {
    subtype: "movie",
    cases: [
      { name: "奥本海默", kws: ["奥本海默", "奥本海默 2023"] },
      { name: "沙丘2", kws: ["沙丘2"] },
      { name: "热辣滚烫", kws: ["热辣滚烫"] },
      { name: "飞驰人生2", kws: ["飞驰人生2"] },
    ],
  },
  {
    subtype: "cn-tv",
    cases: [
      { name: "三体", kws: ["三体 2023"] },
      { name: "庆余年", kws: ["庆余年"] },
      { name: "狂飙", kws: ["狂飙"] },
    ],
  },
  {
    subtype: "us-tv",
    cases: [
      { name: "权力的游戏", kws: ["权力的游戏", "Game of Thrones Complete"] },
      { name: "最后生还者", kws: ["最后生还者", "The Last of Us"] },
      { name: "绝命毒师", kws: ["绝命毒师", "Breaking Bad Complete"] },
    ],
  },
  {
    subtype: "kr-tv",
    cases: [
      { name: "鱿鱼游戏", kws: ["鱿鱼游戏"] },
      { name: "财阀家的小儿子", kws: ["财阀家的小儿子", "Reborn Rich"] },
    ],
  },
  {
    subtype: "jp-tv",
    cases: [
      { name: "半泽直树", kws: ["半泽直树", "Hanzawa Naoki"] },
      { name: "胜者即是正义", kws: ["胜者即是正义"] },
    ],
  },
  {
    subtype: "jp-anime",
    cases: [
      { name: "鬼灭之刃", kws: ["鬼灭之刃"] },
      { name: "间谍过家家", kws: ["间谍过家家"] },
      { name: "莉可丽丝", kws: ["莉可丽丝"] },
    ],
  },
  {
    subtype: "cn-anime",
    cases: [
      { name: "斗破苍穹", kws: ["斗破苍穹 国漫"] },
      { name: "斗罗大陆", kws: ["斗罗大陆 国漫"] },
      { name: "凡人修仙传", kws: ["凡人修仙传 国漫"] },
    ],
  },
  {
    subtype: "us-anime",
    cases: [
      { name: "瑞克和莫蒂", kws: ["瑞克和莫蒂", "Rick and Morty 1080P"] },
      { name: "无敌少侠", kws: ["无敌少侠", "Invincible"] },
    ],
  },
];

function catalog(titles) {
  const counts = Object.fromEntries(TOKENS.map((t) => [t, 0]));
  let hi = 0, mid = 0;
  for (const t of titles) {
    for (const { token, re } of TOKEN_RE) if (re.test(t)) counts[token]++;
    if (HI_RE.test(t)) hi++;
    if (MID_RE.test(t)) mid++;
  }
  return { counts, hi, mid };
}

const perSubtype = {};
for (const g of GROUPS) {
  console.log(`\n################## ${g.subtype} ##################`);
  const allTitles = [];
  for (const c of g.cases) {
    let titles = [];
    for (const kw of c.kws) {
      try {
        const snap = await provider.search({ keyword: kw, workflowRunId: "qresearch" });
        const ts = snap.candidates.map((x) => x.title ?? "");
        titles = titles.concat(ts);
        const cc = catalog(ts);
        console.log(
          `  ${JSON.stringify(kw).padEnd(28)} → ${String(ts.length).padStart(3)} cands | 高:${cc.hi} 中:${cc.mid}`,
        );
      } catch (e) {
        console.log(`  ${JSON.stringify(kw).padEnd(28)} → ERROR ${e.message}`);
      }
    }
    // sample a few titles for eyeballing
    for (const t of titles.slice(0, 3)) console.log(`        · ${t.slice(0, 90)}`);
    allTitles.push(...titles);
  }
  const c = catalog(allTitles);
  perSubtype[g.subtype] = { total: allTitles.length, ...c };
  const nonzero = Object.entries(c.counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  console.log(`  ── ${g.subtype} TOTALS: ${allTitles.length} titles | 高:${c.hi} 中:${c.mid}`);
  console.log(`     tokens: ${nonzero.map(([k, n]) => `${k}=${n}`).join("  ")}`);
}

console.log("\n\n========== SUMMARY (高/中 availability per subtype) ==========");
for (const [subtype, s] of Object.entries(perSubtype)) {
  const hiPct = s.total ? Math.round((s.hi / s.total) * 100) : 0;
  const midPct = s.total ? Math.round((s.mid / s.total) * 100) : 0;
  console.log(`  ${subtype.padEnd(10)} titles=${String(s.total).padStart(4)}  高=${String(s.hi).padStart(3)}(${hiPct}%)  中=${String(s.mid).padStart(3)}(${midPct}%)`);
}

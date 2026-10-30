// §6a 问询: with quality=high, does the real MiMo now REJECT the 4K 原盘/ISO and
// pick a playable 4K REMUX/video? (Verifies the live-e2e ISO fix at the decision
// level, using the REAL movie system prompt — no 115 run.)
//   node scripts/iso-rejection-inquiry.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

const { generateText } = await import("ai");
const { createAgentModelFromEnv, getQualityGuidance, buildMovieSystemPrompt } = await import(
  path.join(repoRoot, "packages/workflow/dist/index.js")
);
const model = createAgentModelFromEnv(process.env);

const system = buildMovieSystemPrompt({ qualityGuidance: getQualityGuidance("movie", "high") });

// A 沙丘2-style recall: the 4K 原盘 ISO (highest nominal quality, but isVideo=false),
// a 4K REMUX mkv (playable), and a 1080p mkv.
const candidates = [
  { id: "c1", title: "沙丘2-Dune.Part.Two.2024.1080p.WEBRip.x264-GalaxyRG [1.6G]" },
  { id: "c2", title: "[沙丘2 2024][4K DIY 全景声 简繁双语特效字幕 全花絮][Dolby Vision HDR10 Atmos 7.1].iso [100.5G]" },
  { id: "c3", title: "沙丘2.Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.HDR.DV.TrueHD.Atmos-FGT.mkv [82G]" },
];

const prompt = `任务:获取电影《沙丘2》(2024)。质量偏好=高。
召回到这些候选(只列标题,你按规则判断):
${candidates.map((c) => `- ${c.id}: ${c.title}`).join("\n")}

请简短回答(中文,3-4句):你会 transfer 哪个候选 id?为什么?会要那个 100.5G 的 4K 原盘 .iso 吗?为什么要/不要?`;

const { text } = await generateText({ model, system, prompt });
console.log("[candidates]");
for (const c of candidates) console.log(`  ${c.id}: ${c.title}`);
console.log("\n[MiMo decision]\n" + text.trim());

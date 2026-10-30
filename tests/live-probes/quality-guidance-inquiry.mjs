// §6a 问询测试 (real MiMo): does the model actually UNDERSTAND + OBEY the quality
// guidance — especially the 4K-scarce types' "don't over-search for 4K, coverage
// first"? Cheap real-model check (no 115). Run after the unit/integration tests.
//
//   node scripts/quality-guidance-inquiry.mjs
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
const { createAgentModelFromEnv, getQualityGuidance } = await import(
  path.join(repoRoot, "packages/workflow/dist/index.js")
);
const model = createAgentModelFromEnv(process.env);

const CASES = [
  { label: "movie + 高 (4K reachable)", profile: "movie", pref: "high" },
  { label: "jp-anime + 高 (4K scarce)", profile: "jp-anime", pref: "high" },
  { label: "cn-anime + 中 (1080p)", profile: "cn-anime", pref: "medium" },
];

for (const c of CASES) {
  const guidance = getQualityGuidance(c.profile, c.pref);
  const question = `这是你获取资源时的画质偏好指引:\n\n${guidance}\n\n请简短回答(中文,3-4句):\n1. 你理解这条指引要你怎么选片?\n2. 如果召回的候选里没有目标画质,你会怎么做?\n3. 你会为了凑到目标画质而反复改关键词多搜吗?会把画质塞进搜索关键词吗?`;
  const { text } = await generateText({
    model,
    prompt: question,
  });
  console.log(`\n========== ${c.label} ==========`);
  console.log("[guidance]", guidance);
  console.log("[MiMo]", text.trim());
}

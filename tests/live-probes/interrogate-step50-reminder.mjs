// §6a interrogation: does the REAL agent (MiMo) understand the step-50 wrap-up
// reminder, and behave right (clean up + finish, NOT panic-drop gettable episodes)?
// Text-only (no tools, no 115) — one cheap generateText.
//   npm run build:workflow && node scripts/interrogate-step50-reminder.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { generateText } from "ai";

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

const { createAgentModelFromEnv, buildTvAnimeSystemPrompt, STEP_50_REMINDER } = await import(
  path.join(repoRoot, "packages/workflow/dist/index.js")
);

const model = createAgentModelFromEnv();
const system = `${buildTvAnimeSystemPrompt({})}\n\n${STEP_50_REMINDER}`;

const prompt = `[场景] 你正在获取国漫《一人之下》(共 6 季,最新第六季仍在更新)。你已经走了 50 步:
- 已经 markObtained 了 71 集;
- 但本次 staging 目录里第六季的 E04、E05 两个视频已经转存好了、还没 moveToSeason 进季目录;
- PanSou 里其实还能搜到更多候选。
你刚刚收到上面系统消息里的那条【进度提醒】。

请用中文回答(不要调用任何工具,只用文字说明你的计划):
① 你怎么理解这条提醒——是判定你失败了,还是正常收尾信号?
② 你接下来具体会按什么顺序做哪些动作?
③ 第六季 E04/E05 你会怎么处理?会不会为了"赶紧多拿一点"而继续 search/transfer?为什么?`;

console.log("=== interrogating MiMo on the step-50 reminder (text-only) ===\n");
const res = await generateText({ model, system, prompt });
console.log(res.text);
console.log(`\n--- (finishReason=${res.finishReason}, tokens=${res.usage?.totalTokens ?? "n/a"}) ---`);

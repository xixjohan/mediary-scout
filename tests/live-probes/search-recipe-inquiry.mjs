// §6a 问询: does the real MiMo understand the NEW (more complex) search recipe?
// Builds the actual TV-agent system prompt (searchHints=new recipe + 中文 字幕偏好)
// and poses the tricky scenarios. No 115 / no PanSou — pure comprehension check.
//   node scripts/search-recipe-inquiry.mjs
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
const { createAgentModelFromEnv, getSearchRecipe, buildTvAnimeSystemPrompt } = await import(
  path.join(repoRoot, "packages/workflow/dist/index.js")
);
const model = createAgentModelFromEnv(process.env);

const CASES = [
  {
    label: "美剧 (us-tv) + 中文字幕偏好",
    profile: "us-tv",
    q: `这是一部美剧《怪奇物语》,用户偏好中文字幕。逐条简短回答(中文):
1. 你首搜用什么关键词?(裸中文译名 还是 裸英文名?为什么)
2. 这个关键词单次返回 0 条,你立刻怎么做?
3. 假设最终只搜出一堆纯英文 scene 包(标题无中字),但用户要中文字幕,你怎么处理?
4. 你会不会用「怪奇物语 美剧」这种带子类型词的关键词?为什么?`,
  },
  {
    label: "国漫 (cn-anime) + 中文字幕偏好",
    profile: "cn-anime",
    q: `这是一部国漫《完美世界》,用户偏好中文字幕。逐条简短回答(中文):
1. 你首搜用什么关键词?
2. 裸名搜出来 top 全是同名真人剧/网文(不是国漫动画),你怎么办?
3. 你会不会加「+年份」(完美世界 2021)来收窄?为什么?
4. 单次返回 0,你会立刻判定『无资源』吗?`,
  },
];

for (const c of CASES) {
  const system = buildTvAnimeSystemPrompt({
    preferredLanguage: "中文",
    searchHints: getSearchRecipe(c.profile),
  });
  const { text } = await generateText({ model, system, prompt: c.q });
  console.log(`\n========== ${c.label} ==========`);
  console.log(text.trim());
}

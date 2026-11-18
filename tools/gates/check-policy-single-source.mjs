#!/usr/bin/env node
/**
 * 订阅策略「同一逻辑只有一份实现」门禁 (tools/gates/check-policy-single-source.mjs)
 *
 * 守护契约：
 *   1. [No-Duplicate-Term-Splitting] `apps/web/features/acquisition` 内禁止用 `split(",")`
 *      直接切分订阅策略词表——必须走 `core/policy-draft.splitTerms`。
 *      （历史缺陷：面板 `split(",")` 不切全角逗号，向导 `/[,，\s]+/` 会切碎正则，
 *        同一个字符串在读回/编辑/保存三处形状不同。）
 *   2. [Single-Template-CRUD] 订阅策略模板的四个动词（POST/PUT/DELETE/GET）只允许
 *      出现在 `policy-template-tools.tsx` 一处；向导与详情页面板不得各写一份。
 *   3. [Draft-Conversion-Single-Source] `draftToPolicy` / `mapSavedPolicy` 的定义只允许
 *      在 `core/policy-draft.ts`，components 目录禁止重新定义。
 *   4. [Priority-Group-Id-In-Range] 生成的优先级组 ID 必须落在服务端上限内
 *      （`PRIORITY_GROUP_ID_MAX_LENGTH`），禁止再出现 `group_${crypto.randomUUID()}`
 *      这种 42 字符写法。
 *   5. [No-Subtitle-Hard-Term] 预设/默认规则禁止把「简中字幕」四字连写放进 mustContain
 *      （标题几乎不这么写，AND 子串会让默认规则恒 false）。
 *
 * 退出码 0 = 通过；1 = 违规（逐条打印文件与行号）
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const acquisitionDir = join(root, "apps/web/features/acquisition");
const coreDraftPath = join(acquisitionDir, "core/policy-draft.ts");
const templateToolsPath = join(acquisitionDir, "components/policy-template-tools.tsx");

const violations = [];
let scanned = 0;

function collect(dir, list = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      collect(full, list);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      list.push(full);
    }
  }
  return list;
}

function report(file, line, rule, message) {
  violations.push({ file: relative(root, file).replace(/\\/g, "/"), line, rule, message });
}

const files = collect(acquisitionDir);
for (const file of files) {
  scanned += 1;
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  const rel = relative(root, file).replace(/\\/g, "/");

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;

    // 1) 词表切分只能走共享层
    if (/\.split\(\s*["'`]\,["'`]\s*\)/.test(line) && rel !== "apps/web/features/acquisition/core/policy-draft.ts") {
      report(file, lineNo, "No-Duplicate-Term-Splitting", "禁止用 .split(\",\") 切分订阅策略词表；改用 core/policy-draft.splitTerms（它同时处理全角逗号/顿号/分号，并在正则模式下按行切）");
    }

    // 2) 模板 CRUD 只允许一个实现
    if (/\/api\/titles\/subscription-policy\/templates/.test(line) && rel !== "apps/web/features/acquisition/components/policy-template-tools.tsx") {
      report(file, lineNo, "Single-Template-CRUD", "模板 CRUD 请求只允许出现在 policy-template-tools.tsx；向导与详情页面板必须复用它");
    }

    // 3) 转换函数不能在组件里重新定义
    if (/export function (draftToPolicy|mapSavedPolicy)\s*\(/.test(line) && rel !== "apps/web/features/acquisition/core/policy-draft.ts") {
      report(file, lineNo, "Draft-Conversion-Single-Source", "draftToPolicy / mapSavedPolicy 只能定义在 core/policy-draft.ts");
    }

    // 4) 优先级组 ID 不得再用完整 UUID 拼接
    if (/group_\$\{?crypto\.randomUUID/.test(line)) {
      report(file, lineNo, "Priority-Group-Id-In-Range", "group_ + 完整 UUID 是 42 字符，超出服务端上限；改用 core/policy-draft.makePriorityGroup（group_ + 12 位）");
    }

    // 5) 简中字幕不得作为硬条件（只看 mustContain 那一侧的字面量赋值）
    if (/mustContain\s*[=:]\s*[^\n]*简中字幕/.test(line) || /^\s*mustContain:\s*"[^"]*简中字幕/.test(line)) {
      report(file, lineNo, "No-Subtitle-Hard-Term", "「简中字幕」四字连写几乎不出现在真实标题里；字幕必须走 subtitlePreference（OR 词表，默认不强制）");
    }
  });
}

// 6) 共享层与模板工具必须存在
for (const required of [coreDraftPath, templateToolsPath]) {
  if (!existsSync(required)) {
    violations.push({
      file: relative(root, required).replace(/\\/g, "/"),
      line: 0,
      rule: "Required-Single-Source-File",
      message: "共享适配层/模板工具缺失：向导与详情页面板会各自再写一份实现",
    });
  }
}

if (violations.length === 0) {
  console.log(`\u001b[32m\u2714 [Policy Single Source Gate] 通过：扫描 ${scanned} 个文件，0 项违规\u001b[0m`);
  process.exit(0);
}

for (const v of violations) {
  console.error(`\u001b[31m\u2716 [${v.rule}]\u001b[0m ${v.file}:${v.line}`);
  console.error(`  ${v.message}`);
}
console.error(`\u001b[31m共 ${violations.length} 项违规（扫描 ${scanned} 个文件）\u001b[0m`);
process.exit(1);

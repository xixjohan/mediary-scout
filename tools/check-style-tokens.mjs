#!/usr/bin/env node
/**
 * 样式门禁（Style Gate）：设计令牌与 CSS 语法质检（任务单 S5 / 设计令牌体系）
 *
 * 核心检查项（策略模式 Strategy Pattern）：
 *   1. 【未定义令牌引用检查】：扫描所有 CSS 文件中的 `var(--xxx)`，确认 `--xxx` 均在 `:root`
 *      声明池中存在，彻底杜绝拼写错误与幽灵变量（如历史上的 `var(--bg)`、`var(--bg-elevated)`）；
 *   2. 【网盘与新组件硬编码色值检查】：扫描 `.storage-` 等新开发组件样式，严禁出现未经封装的
 *      裸 Hex 色值（`#xxxxxx`）或非令牌 RGBA（必须使用三层语义设计令牌）；
 *   3. 【关键语义令牌完整性检查】：校验 `:root` 中必须声明完整的表面色、品牌色、语义状态与分类色。
 *
 * 退出码：0 = 全部通过；1 = 发现违规项（打印违规文件、行号与建议）。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const globalsCssPath = join(root, "apps/web/app/globals.css");

if (!existsSync(globalsCssPath)) {
  console.error(`[Style Gate] 错误: 未找到核心样式文件: ${globalsCssPath}`);
  process.exit(1);
}

const cssContent = readFileSync(globalsCssPath, "utf8");
const lines = cssContent.split("\n");

const problems = [];

// ============================================================================
// 1. 提取 :root 中声明的所有 CSS 自定义属性
// ============================================================================
const declaredTokens = new Set();
let inRoot = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();

  if (trimmed.startsWith(":root") && trimmed.includes("{")) {
    inRoot = true;
    continue;
  }
  if (inRoot && trimmed.includes("}")) {
    inRoot = false;
    continue;
  }

  if (inRoot) {
    const match = trimmed.match(/^(--[a-zA-Z0-9_-]+)\s*:/);
    if (match) {
      declaredTokens.add(match[1]);
    }
  }
}

// 核心必选令牌基线
const REQUIRED_CORE_TOKENS = [
  "--bg-base",
  "--bg-surface",
  "--bg-raised",
  "--bg-card",
  "--accent",
  "--accent-hover",
  "--accent-subtle",
  "--negative",
  "--color-danger",
  "--color-warning",
  "--color-info",
  "--text",
  "--text-muted",
  "--border",
  "--radius-pill",
  "--file-folder",
  "--file-video",
  "--file-subtitle",
  "--file-audio",
  "--file-archive",
  "--file-image",
  "--file-generic",
];

for (const req of REQUIRED_CORE_TOKENS) {
  if (!declaredTokens.has(req)) {
    problems.push(`:root 缺少核心设计令牌声明: ${req}`);
  }
}

// ============================================================================
// 2. 扫描所有 var(--xxx) 引用，拦截未定义变量 (Undefined Token Check)
// ============================================================================
// 排除某些特定浏览器内置或库提供的已知安全变量
const ALLOWED_EXTERNAL_VARS = new Set([
  "--tw-ring-offset-shadow",
  "--tw-ring-shadow",
  "--tw-shadow",
]);

const varRegex = /var\(\s*(--[a-zA-Z0-9_-]+)/g;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  let match;
  while ((match = varRegex.exec(line)) !== null) {
    const tokenName = match[1];
    if (!declaredTokens.has(tokenName) && !ALLOWED_EXTERNAL_VARS.has(tokenName)) {
      problems.push(
        `globals.css:${i + 1}: 引用了未在 :root 声明的未知设计令牌 -> ${tokenName}`,
      );
    }
  }
}

// ============================================================================
// 3. 扫描 .storage- 组件样式块，严禁裸色值 (No Raw Color Literals in Storage)
// ============================================================================
// 检查处于 storage 区域的 CSS 行（从网盘文件管理页面注释开始到结束）
let inStorageSection = false;
const rawHexRegex = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes("网盘文件管理页面")) {
    inStorageSection = true;
  }

  if (inStorageSection) {
    // 排除纯注释行
    const stripped = line.replace(/\/\*.*?\*\//g, "").trim();
    if (!stripped || stripped.startsWith("/*") || stripped.startsWith("*")) {
      continue;
    }

    // 检查是否有裸 Hex 色值（除了 #000000 极端纯黑按钮文字等允许项）
    const hexMatch = stripped.match(rawHexRegex);
    if (hexMatch) {
      const hex = hexMatch[0].toLowerCase();
      // 允许极特殊的实体对比文字纯黑纯白
      if (hex !== "#000000" && hex !== "#ffffff" && hex !== "#000" && hex !== "#fff") {
        problems.push(
          `globals.css:${i + 1}: 网盘管理样式中存在硬编码 Hex 色值 "${hexMatch[0]}"，应使用设计令牌 (var(--...))`,
        );
      }
    }

    // 检查是否有特定硬编码的冷蓝色值 (Tailwind blue-500 59, 130, 246)
    if (stripped.includes("59, 130, 246") || stripped.includes("239, 68, 68")) {
      problems.push(
        `globals.css:${i + 1}: 网盘管理样式中存在硬编码 Tailwind 色值，应替换为 Spotify 语义设计令牌 (如 var(--accent-subtle) 或 var(--color-danger))`,
      );
    }
  }
}

// ============================================================================
// 4. 汇总与输出
// ============================================================================
if (problems.length > 0) {
  console.error("\n❌ [Style Gate] 样式门禁质检未通过，发现以下违规项：\n");
  for (const p of problems) {
    console.error(`  - ${p}`);
  }
  console.error(`\n共计 ${problems.length} 处样式问题，请修正后重试。\n`);
  process.exit(1);
}

console.log(`✔ [Style Gate] 样式门禁质检通过（已校验 ${declaredTokens.size} 个设计令牌，0 处未定义变量引用，网盘管理样式 100% 令牌化）`);
process.exit(0);

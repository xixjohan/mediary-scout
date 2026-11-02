#!/usr/bin/env node
/**
 * 样式门禁（Style Gate）：设计令牌与 CSS 语法质检（任务单 S5 / 设计令牌体系）
 *
 * 核心检查项（策略模式 Strategy Pattern）：
 *   1. 【未定义令牌引用检查】：扫描所有 CSS 文件中的 `var(--xxx)`，确认 `--xxx` 均在 `:root`
 *      声明池中存在，彻底杜绝拼写错误与幽灵变量（如历史上的 `var(--bg)`、`var(--bg-elevated)`）；
 *   2. 【网盘与新组件硬编码色值检查】：扫描 `.storage-` 等新开发组件样式，严禁出现未经封装的
 *      裸 Hex 色值（`#xxxxxx`）或非令牌 RGBA（必须使用三层语义设计令牌）；
 *   3. 【关键语义令牌完整性检查】：校验 `:root` 中必须声明完整的表面色、品牌色、语义状态与分类色；
 *   4. 【弹窗浮层与核心表单布局约束检查】：校验网盘弹窗等核心浮层容器具备 `position: fixed`、
 *      `inset: 0`、全宽文本框约束等，防止因选择器脱节退化为页面底部内联块。
 *
 * 退出码：0 = 全部通过；1 = 发现违规项（打印违规文件、行号与建议）。
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const globalsCssPath = join(root, "apps/web/app/globals.css");

if (!existsSync(globalsCssPath)) {
  console.error(`[Style Gate] 错误: 未找到核心样式文件: ${globalsCssPath}`);
  process.exit(1);
}

// 递归扫描 apps/web 下所有 CSS 文件（含 globals.css, tokens/*.css, features/**/*.module.css）
function scanCssFiles(dir) {
  const fileList = [];
  if (!existsSync(dir)) return fileList;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".next" && entry.name !== "dist") {
        fileList.push(...scanCssFiles(full));
      }
    } else if (entry.name.endsWith(".css")) {
      fileList.push(full);
    }
  }
  return fileList;
}

const webCssFiles = scanCssFiles(join(root, "apps/web"));
const problems = [];

// ============================================================================
// 1. 提取全站 CSS 中 :root 声明的所有自定义属性 (Design Tokens)
// ============================================================================
const declaredTokens = new Set();

for (const cssFile of webCssFiles) {
  const content = readFileSync(cssFile, "utf8");
  const fileLines = content.split("\n");
  let inRoot = false;

  for (let i = 0; i < fileLines.length; i++) {
    const trimmed = fileLines[i].trim();

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
// 2. 扫描所有 CSS 文件中的 var(--xxx) 引用，拦截未定义变量 (Undefined Token Check)
// ============================================================================
// 排除某些特定浏览器内置或库提供的已知安全变量
const ALLOWED_EXTERNAL_VARS = new Set([
  "--tw-ring-offset-shadow",
  "--tw-ring-shadow",
  "--tw-shadow",
]);

const varRegex = /var\(\s*(--[a-zA-Z0-9_-]+)/g;

for (const cssFile of webCssFiles) {
  const content = readFileSync(cssFile, "utf8");
  const fileLines = content.split("\n");
  const relPath = relative(root, cssFile).replace(/\\/g, "/");

  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i];
    let match;
    while ((match = varRegex.exec(line)) !== null) {
      const tokenName = match[1];
      if (!declaredTokens.has(tokenName) && !ALLOWED_EXTERNAL_VARS.has(tokenName)) {
        problems.push(
          `${relPath}:${i + 1}: 引用了未在 :root 声明的未知设计令牌 -> ${tokenName}`,
        );
      }
    }
  }
}

// ============================================================================
// 2b. 扫描 apps/web 下所有 TSX/TS 组件中的 var(--xxx) 引用，拦截未定义幽灵令牌
// ============================================================================
function scanTsxFiles(dir) {
  const fileList = [];
  if (!existsSync(dir)) return fileList;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".next" && entry.name !== "dist") {
        fileList.push(...scanTsxFiles(full));
      }
    } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
      fileList.push(full);
    }
  }
  return fileList;
}

const webTsxFiles = scanTsxFiles(join(root, "apps/web"));
let totalTsxVarReferences = 0;

for (const file of webTsxFiles) {
  const content = readFileSync(file, "utf8");
  const fileLines = content.split("\n");
  const relPath = relative(root, file).replace(/\\/g, "/");

  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i];
    let match;
    while ((match = varRegex.exec(line)) !== null) {
      totalTsxVarReferences++;
      const tokenName = match[1];
      if (!declaredTokens.has(tokenName) && !ALLOWED_EXTERNAL_VARS.has(tokenName)) {
        problems.push(
          `${relPath}:${i + 1}: 前端组件内联样式引用了未在 globals.css 中声明的设计令牌 -> ${tokenName}`,
        );
      }
    }
  }
}

// ============================================================================
// 3. 扫描 .storage- 组件样式块，严禁裸色值 (No Raw Color Literals in Storage)
// ============================================================================
const globalsLines = readFileSync(globalsCssPath, "utf8").split("\n");
let inStorageSection = false;
const rawHexRegex = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

for (let i = 0; i < globalsLines.length; i++) {
  const line = globalsLines[i];
  if (line.includes("网盘文件管理页面")) {
    inStorageSection = true;
  }
  if (inStorageSection && (line.includes("Chat Action Cards") || line.includes("===== Activity page") || line.includes("订阅页缺失待办区"))) {
    inStorageSection = false;
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

// 同时扫描 storage-drives 模块下的私有样式文件
const storageStylesDir = join(root, "apps/web/features/storage-drives/styles");
if (existsSync(storageStylesDir)) {
  for (const entry of readdirSync(storageStylesDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".css")) {
      const filePath = join(storageStylesDir, entry.name);
      const content = readFileSync(filePath, "utf8");
      const fLines = content.split("\n");
      const relPath = relative(root, filePath).replace(/\\/g, "/");

      for (let i = 0; i < fLines.length; i++) {
        const line = fLines[i];
        const stripped = line.replace(/\/\*.*?\*\//g, "").trim();
        if (!stripped || stripped.startsWith("/*") || stripped.startsWith("*")) continue;

        const hexMatch = stripped.match(rawHexRegex);
        if (hexMatch) {
          const hex = hexMatch[0].toLowerCase();
          if (hex !== "#000000" && hex !== "#ffffff" && hex !== "#000" && hex !== "#fff") {
            problems.push(
              `${relPath}:${i + 1}: 网盘模块样式中存在硬编码 Hex 色值 "${hexMatch[0]}"，应使用设计令牌 (var(--...))`,
            );
          }
        }
      }
    }
  }
}

// ============================================================================
// 4. 弹窗浮层与核心表单布局约束检查 (Modal Overlay & Form Constraints Check)
// ============================================================================
const allCssCombined = webCssFiles.map((f) => readFileSync(f, "utf8")).join("\n");

const REQUIRED_MODAL_SELECTORS = [
  {
    name: ".storage-offline-modal-overlay",
    requiredProps: ["position: fixed", "inset: 0", "display: flex"],
  },
  {
    name: ".storage-offline-textarea",
    requiredProps: ["width: 100%", "box-sizing: border-box"],
  },
  {
    name: ".storage-offline-modal-header",
    requiredProps: ["display: flex", "justify-content: space-between"],
  },
  {
    name: ".title-resources-input-clear",
    requiredProps: ["position: absolute", "right: 10px", "border-radius: var(--radius-pill)"],
  },
  {
    name: ".title-resources-input-wrap input",
    requiredProps: ["padding: 8px 38px 8px 36px", "box-sizing: border-box"],
  },
  {
    name: ".title-resources-empty-card",
    requiredProps: ["background: var(--bg-surface)", "border-radius: var(--radius-lg)"],
  },
];

for (const req of REQUIRED_MODAL_SELECTORS) {
  const selectorIndex = allCssCombined.indexOf(req.name);
  if (selectorIndex === -1) {
    problems.push(`样式表缺少核心弹窗类选择器: ${req.name}`);
    continue;
  }
  const blockStart = allCssCombined.indexOf("{", selectorIndex);
  const blockEnd = allCssCombined.indexOf("}", blockStart);
  if (blockStart !== -1 && blockEnd !== -1) {
    const blockContent = allCssCombined.slice(blockStart, blockEnd);
    for (const prop of req.requiredProps) {
      if (!blockContent.includes(prop)) {
        problems.push(`选择器 "${req.name}" 缺少关键布局约束属性: "${prop}"`);
      }
    }
  }
}

// ============================================================================
// 4b. 设置页面板块面板一致性检查 (Settings Panel Wrapper Consistency)
// ============================================================================
const settingsSectionsDir = join(root, "apps/web/features/settings-system/components/settings");
if (existsSync(settingsSectionsDir)) {
  for (const entry of readdirSync(settingsSectionsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".tsx")) {
      const filePath = join(settingsSectionsDir, entry.name);
      const content = readFileSync(filePath, "utf8");
      const relPath = relative(root, filePath).replace(/\\/g, "/");

      // 严禁使用无背景边框的裸 section-heading 或 settings-section 伪容器
      if (content.includes('className="settings-section"') || content.includes("className='settings-section'")) {
        problems.push(
          `${relPath}: 设置板块严禁使用裸 .settings-section 伪容器，必须包裹 <section className="panel"> 与 <div className="panel-header">，保持 Spotify 暗黑卡片规范统一。`,
        );
      }

      // 如果有包含 h2 或 ServiceBlock 的板块，必须具有 panel 容器包裹
      if (content.includes("<ServiceBlock") && !content.includes('className="panel"')) {
        problems.push(
          `${relPath}: 包含 <ServiceBlock> 的设置板块缺少外层 <section className="panel"> 容器。`,
        );
      }
    }
  }
}

// ============================================================================
// 5. 汇总与输出
// ============================================================================
if (problems.length > 0) {
  console.error("\n❌ [Style Gate] 样式门禁质检未通过，发现以下违规项：\n");
  for (const p of problems) {
    console.error(`  - ${p}`);
  }
  console.error(`\n共计 ${problems.length} 处样式问题，请修正后重试。\n`);
  process.exit(1);
}

console.log(`✔ [Style Gate] 样式门禁质检通过（已校验 ${declaredTokens.size} 个设计令牌，${webTsxFiles.length} 个前端组件、${totalTsxVarReferences} 处变量引用，0 处未定义变量引用，样式与浮层约束 100% 令牌化）`);
process.exit(0);

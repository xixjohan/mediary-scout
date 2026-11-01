#!/usr/bin/env node
// @ts-check

/**
 * 架构质量门禁脚本：单文件代码行数与体积限制 + 棘轮递减机制 (Ratchet Mechanism)
 *
 * 目标：
 * 1. 严格阻断新增任何超过 600 行或 60KB 的上帝类/超大文件；
 * 2. 存量超标文件通过 baseline 登记，实行【只降不升】的棘轮约束；
 * 3. 驱动复杂文件逐步向单一职责、领域模块化重构。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_MAX_LINES = 600;
const DEFAULT_MAX_SIZE_KB = 60;
const BASELINE_PATH = path.resolve(process.cwd(), "tools/code-limits-baseline.json");

const IGNORE_PATTERNS = [
  /[\\/]dist[\\/]/,
  /[\\/]\.next[\\/]/,
  /[\\/]node_modules[\\/]/,
  /[\\/]\.omo[\\/]/,
  /[\\/]\.git[\\/]/,
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /[\\/]next-env\.d\.ts$/,
];

function scanFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const normalized = fullPath.replace(/\\/g, "/");

    if (IGNORE_PATTERNS.some((p) => p.test(normalized))) {
      continue;
    }

    if (entry.isDirectory()) {
      scanFiles(fullPath, fileList);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      fileList.push(fullPath);
    }
  }

  return fileList;
}

function getLineCount(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  // 过滤纯空行以对齐 ESLint max-lines 的 skipBlankLines 语义
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const sizeBytes = fs.statSync(filePath).size;
  return {
    lineCount: lines.length,
    rawLineCount: content.split(/\r?\n/).length,
    sizeKb: Math.round((sizeBytes / 1024) * 10) / 10,
  };
}

function loadBaseline() {
  if (fs.existsSync(BASELINE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

function saveBaseline(data) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function main() {
  const args = process.argv.slice(2);
  const isUpdateMode = args.includes("--update-baseline");

  const scanRoots = ["packages", "apps"];
  const allFiles = [];
  for (const root of scanRoots) {
    scanFiles(path.resolve(process.cwd(), root), allFiles);
  }

  const baseline = loadBaseline();
  const violations = [];
  const oversizedFiles = [];
  const newBaseline = {};

  for (const file of allFiles) {
    const relPath = path.relative(process.cwd(), file).replace(/\\/g, "/");
    const { lineCount, rawLineCount, sizeKb } = getLineCount(file);

    const isLineOver = lineCount > DEFAULT_MAX_LINES;
    const isSizeOver = sizeKb > DEFAULT_MAX_SIZE_KB;

    if (isLineOver || isSizeOver) {
      oversizedFiles.push({ relPath, lineCount, rawLineCount, sizeKb });
      const record = baseline[relPath];

      if (isUpdateMode) {
        newBaseline[relPath] = {
          lineCount,
          rawLineCount,
          sizeKb,
          updatedAt: new Date().toISOString(),
        };
      } else if (!record) {
        violations.push({
          relPath,
          reason: `新超限文件 (非 Baseline 豁免): ${lineCount} 行 (上限 ${DEFAULT_MAX_LINES}), ${sizeKb} KB (上限 ${DEFAULT_MAX_SIZE_KB} KB)`,
        });
      } else if (lineCount > record.lineCount) {
        violations.push({
          relPath,
          reason: `违背棘轮递减原则: 行数从 Baseline ${record.lineCount} 行逆向增加到了 ${lineCount} 行 (+${lineCount - record.lineCount} 行)`,
        });
      }
    }
  }

  if (isUpdateMode) {
    saveBaseline(newBaseline);
    console.log(`[Gate] Baseline 已更新至 ${BASELINE_PATH}，当前包含 ${Object.keys(newBaseline).length} 个存量文件。`);
    return;
  }

  // 排序前 10 大文件用于健康看板输出
  oversizedFiles.sort((a, b) => b.lineCount - a.lineCount);
  console.log("\n========================================================");
  console.log("       巡影 架构质量门禁 · 文件体积与行数健康看板        ");
  console.log("========================================================");
  console.log(`扫描文件总数: ${allFiles.length}`);
  console.log(`超标文件数量: ${oversizedFiles.length} (单文件有效行 > ${DEFAULT_MAX_LINES} 或 > ${DEFAULT_MAX_SIZE_KB} KB)\n`);

  console.log("Top 10 最大源文件排行 (有效行 / 物理行 / 体积):");
  oversizedFiles.slice(0, 10).forEach((f, idx) => {
    const isBase = baseline[f.relPath] ? "[Baseline存量]" : "[新增违规]";
    console.log(`  ${idx + 1}. ${f.relPath}`);
    console.log(`     ${f.lineCount} 有效行 (共 ${f.rawLineCount} 物理行) · ${f.sizeKb} KB  ${isBase}`);
  });
  console.log("--------------------------------------------------------");

  if (violations.length > 0) {
    console.error("\n❌ [GATE FAILURE] 发现文件行数/体积门禁违规 (硬阻断):");
    for (const v of violations) {
      console.error(`  - ${v.relPath}: ${v.reason}`);
    }
    console.error("\n💡 重构建议：");
    console.error("  1. 单一职责原则：将上帝类拆分为子模块 (如 sqlite.ts 拆分为 sqlite/*.ts)；");
    console.error("  2. React 视图：将大型页面拆解为独立的子组件与自定义 Hook；");
    console.error("  3. 业务决策：使用适配器/策略模式消除超长 if-else 分支；");
    console.error("  4. 存量合法变更若确已重构变小，可运行 node scripts/gate-code-limits.mjs --update-baseline 固化最新指标。\n");
    process.exit(1);
  }

  console.log("\n✅ [GATE PASS] 所有文件符合代码行数/体积门禁与棘轮约束！\n");
}

main();

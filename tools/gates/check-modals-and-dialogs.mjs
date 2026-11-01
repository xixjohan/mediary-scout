#!/usr/bin/env node
/**
 * 模态弹窗与应用内对话框架构门禁 (tools/gates/check-modals-and-dialogs.mjs)
 *
 * 守护契约（Design System & Stacking Context 规范）：
 *   1. [No Native Blocking Dialog] 严禁在前端 UI 组件中使用阻塞型原生 window.confirm() / alert()；
 *      （必须使用基于 Portal 的 AppConfirmDialog 或受控内联反馈，保证暗黑模式统一、不阻塞 JS 线程、无障碍支持）
 *   2. [Modal Portal Required] 全屏浮层与模态弹窗（position: fixed + inset: 0）必须使用 createPortal 挂载至 document.body；
 *      （彻底切断来自父级容器、侧边栏或网格布局的 overflow/transform/stacking context 污染）
 *   3. [Top-Layer Stacking Safe] 模态弹窗的 z-index 必须 >= 9000（规范推荐 9999）；
 *      （避免被页面主内容区域拥有 position: relative 的海报卡片、导航栏或吸顶元素物理遮挡）
 *
 * 退出码: 0 = 全部通过, 1 = 发现违规 (逐条打印文件及行号与重构指引)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const targetDirs = [
  join(root, "apps/web/features"),
  join(root, "apps/web/components"),
  join(root, "apps/web/app"),
];

/**
 * 递归收集指定目录下的所有 .tsx 与 .jsx 文件（排除测试与快照文件）
 * @param {string} dir
 * @returns {string[]}
 */
export function collectComponentFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".next" && entry.name !== "api") {
        results.push(...collectComponentFiles(fullPath));
      }
    } else if (
      (entry.name.endsWith(".tsx") || entry.name.endsWith(".jsx")) &&
      !entry.name.endsWith(".test.tsx") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.tsx")
    ) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

/**
 * 清除代码中的单行与多行注释，同时精确保留行号与换行结构
 * @param {string} source
 * @returns {string}
 */
export function stripCommentsPreservingLines(source) {
  // 将多行注释 /* ... */ 替换为等量换行符与空格
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    return match.replace(/[^\n]/g, " ");
  });
  // 将单行注释 // ... 替换为等长空格
  return noBlock.replace(/\/\/[^\n]*/g, (match) => {
    return " ".repeat(match.length);
  });
}

/**
 * 检查单个文件的弹窗与对话框实现是否合规
 * @param {string} filePath
 * @param {string} content
 * @returns {Array<{ file: string, line: number, rule: string, message: string }>}
 */
export function checkFileModalCompliance(filePath, content) {
  const violations = [];
  const codeOnly = stripCommentsPreservingLines(content);
  const lines = codeOnly.split("\n");
  const relPath = relative(root, filePath).replace(/\\/g, "/");

  // 1. 扫描原生阻塞对话框: window.confirm, confirm(, window.alert, alert(
  // 排除形如 `confirm:` 属性, `async confirm(`, `confirmLabel`, `isConfirm` 等
  const nativeConfirmRegex = /(?:window\.)?confirm\s*\(/;
  const nativeAlertRegex = /(?:window\.)?alert\s*\(/;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineText = lines[idx];
    const lineNum = idx + 1;

    // 检查 confirm()
    if (nativeConfirmRegex.test(lineText)) {
      // 排除非 window.confirm 调用的合法场景（如 qr-connect 的内部同名异步函数调用）
      if (!lineText.includes("await confirm(") && !lineText.includes("function confirm(") && !lineText.includes("async confirm(")) {
        violations.push({
          file: relPath,
          line: lineNum,
          rule: "no-native-confirm",
          message: `发现原生阻塞调用 confirm(...)，请替换为应用内统一组件 <AppConfirmDialog>`,
        });
      }
    }

    // 检查 alert()
    if (nativeAlertRegex.test(lineText)) {
      violations.push({
        file: relPath,
        line: lineNum,
        rule: "no-native-alert",
        message: `发现原生阻塞调用 alert(...)，请替换为非阻塞内联错误提示或状态反馈`,
      });
    }
  }

  // 2. 扫描全屏浮层/弹窗（position: fixed 且包含 inset: 0）
  const hasFixedInset = /position:\s*["']fixed["'][\s\S]*?inset:\s*0/.test(content) ||
                        /inset:\s*0[\s\S]*?position:\s*["']fixed["']/.test(content);

  if (hasFixedInset) {
    const hasPortal = content.includes("createPortal(") ||
                      content.includes("AppConfirmDialog") ||
                      content.includes("UserActionConfirmDialog");

    if (!hasPortal) {
      violations.push({
        file: relPath,
        line: 1,
        rule: "modal-portal-required",
        message: `包含全屏固定遮罩（position: fixed; inset: 0），但未通过 createPortal 挂载至 document.body，存在层叠上下文遮挡风险`,
      });
    }

    // 检查 zIndex 是否过低 (< 9000)
    // 匹配类似 zIndex: 1000, zIndex: 1050 等低层级
    const lowZIndexMatches = content.match(/zIndex:\s*(\d+)/g);
    if (lowZIndexMatches) {
      for (const m of lowZIndexMatches) {
        const val = parseInt(m.replace("zIndex:", "").trim(), 10);
        if (val < 9000) {
          violations.push({
            file: relPath,
            line: 1,
            rule: "modal-low-zindex",
            message: `弹窗层级 zIndex 设置为 ${val}，低于规范安全阈值 (>= 9000)，容易被内容区带 position: relative 的卡片遮挡`,
          });
          break;
        }
      }
    }
  }

  return violations;
}

// CLI 执行流程
export function runGate() {
  const allFiles = targetDirs.flatMap((d) => collectComponentFiles(d));
  let totalViolations = [];

  for (const f of allFiles) {
    const content = readFileSync(f, "utf8");
    const issues = checkFileModalCompliance(f, content);
    totalViolations.push(...issues);
  }

  console.log("=== 巡影 · Mediary Scout 模态弹窗与应用内对话框架构门禁扫描 ===");
  console.log(`已审计前端组件总数: ${allFiles.length}`);

  if (totalViolations.length === 0) {
    console.log("✔ [Modals Gate] 门禁质检通过：所有弹窗均通过 createPortal 顶层挂载，层叠层级符合规范，0 原生阻塞调用！\n");
    return { passed: true, violations: [] };
  } else {
    console.error(`❌ [Modals Gate] 发现 ${totalViolations.length} 处弹窗/对话框架构违规项：\n`);
    for (const v of totalViolations) {
      console.error(`  - [${v.rule}] ${v.file}:${v.line} -> ${v.message}`);
    }
    console.error("\n请根据重构规范修复以上问题后重试。\n");
    return { passed: false, violations: totalViolations };
  }
}

// 若作为命令行直接执行
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { passed } = runGate();
  process.exit(passed ? 0 : 1);
}

#!/usr/bin/env node
/**
 * 门面导出与核心契约物理一致性门禁（tools/gates/check-facades.mjs）
 *
 * 守护契约：
 *   1. 核心共享基础层 (@media-track/shared / @media-track/workflow) 必须导出关键网络与领域实体（如 formatNetworkError）；
 *   2. apps/web/lib/workflow-runtime.ts 门面层必须持续暴露核心工作区与巡检契约方法，防架构重构时退化缺失；
 *   3. 静态扫描 apps/web 内部所有对 workflow-runtime 的具名 import，
 *      验证导入的每个符号在目标模块真实存在（防虚假引用导致的运行时 500 / Turbopack 编译报错）。
 *
 * 退出码: 0 = 通过, 1 = 违规 (逐条打印文件及缺失符号)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = join(root, "apps/web");
const workflowRuntimePath = join(root, "apps/web/lib/workflow-runtime.ts");
const workflowIndexPath = join(root, "packages/workflow/src/index.ts");

const violations = [];

// 1. 关键契约必检清单
const WORKFLOW_RUNTIME_REQUIRED_EXPORTS = [
  "getActiveWorkspaceScope",
  "getRegisteredDriveCount",
  "resolveGlobalWorkspace",
  "notificationWindowSince",
  "untrackTrackedTitle",
  "getForeignWorkReview",
  "getCurrentAccountId",
  "getWorkflowRepository",
  "ensureDemoSeeded",
  "runStartupMigrations",
];

const WORKFLOW_REQUIRED_EXPORTS = [
  "formatNetworkError",
  "isTransientPan115NetworkError",
  "resolveWorkspaceFromParam",
  "pickWorkspaceStorageId",
  "showHref",
  "globalNavHref",
];

function extractExportedSymbols(filePath, visited = new Set()) {
  if (!existsSync(filePath) || visited.has(filePath)) return new Set();
  visited.add(filePath);

  const content = readFileSync(filePath, "utf8");
  const exports = new Set();
  const dir = dirname(filePath);

  // export function foo / export const foo / export async function foo / export class foo
  const declRegex = /export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface)\s+([a-zA-Z0-9_$]+)/g;
  let match;
  while ((match = declRegex.exec(content)) !== null) {
    if (match[1]) exports.add(match[1]);
  }

  // export { foo, bar as baz } [from "./rel"]
  const namedRegex = /export\s*\{([^}]+)\}(?:\s*from\s*["']([^"']+)["'])?/g;
  while ((match = namedRegex.exec(content)) !== null) {
    const items = match[1].split(",");
    for (const item of items) {
      const parts = item.trim().split(/\s+as\s+/);
      const exportedName = (parts[1] || parts[0]).replace(/^type\s+/, "").trim();
      if (exportedName) exports.add(exportedName);
    }
  }

  // export * from "./sub-barrel.js"
  const starRegex = /export\s*\*\s*from\s*["']([^"']+)["']/g;
  while ((match = starRegex.exec(content)) !== null) {
    const relTarget = match[1];
    if (relTarget.startsWith(".")) {
      const tsTarget = relTarget.replace(/\.js$/, ".ts");
      const fullTarget = join(dir, tsTarget);
      const subExports = extractExportedSymbols(fullTarget, visited);
      for (const s of subExports) exports.add(s);
    }
  }

  return exports;
}

const runtimeExports = extractExportedSymbols(workflowRuntimePath);
const workflowExports = extractExportedSymbols(workflowIndexPath);

// 校验关键方法是否存在
for (const symbol of WORKFLOW_RUNTIME_REQUIRED_EXPORTS) {
  if (!runtimeExports.has(symbol)) {
    violations.push(
      `apps/web/lib/workflow-runtime.ts: 缺失必备核心契约导出 '${symbol}'（下游页面强依赖）`,
    );
  }
}

for (const symbol of WORKFLOW_REQUIRED_EXPORTS) {
  if (!workflowExports.has(symbol)) {
    violations.push(
      `packages/workflow/src/index.ts: 缺失必备核心契约导出 '${symbol}'（跨包调用强依赖）`,
    );
  }
}

// 2. 扫描 apps/web 内的 import 悬空引用
function scanImports(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanImports(fullPath);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      checkImportsInFile(fullPath);
    }
  }
}

function checkImportsInFile(filePath) {
  // 跳过自身声明
  if (filePath === workflowRuntimePath) return;
  const rawContent = readFileSync(filePath, "utf8");
  // 移除单行与多行注释，防止注释被误解析为导入符号
  const content = rawContent.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const relPath = relative(root, filePath).replace(/\\/g, "/");

  // 检测对 workflow-runtime 的具名引用
  const runtimeImportRegex = /import\s*\{([^}]+)\}\s*from\s*["'].*workflow-runtime["']/g;
  let m;
  while ((m = runtimeImportRegex.exec(content)) !== null) {
    const rawItems = m[1].split(",");
    for (const raw of rawItems) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("type ")) continue;
      const importedName = trimmed.split(/\s+as\s+/)[0].trim();
      if (!runtimeExports.has(importedName)) {
        violations.push(
          `${relPath}: 从 workflow-runtime 导入了未导出的符号 '${importedName}'`,
        );
      }
    }
  }
}

scanImports(webRoot);

if (violations.length > 0) {
  console.error(`\n❌ [Facades Gate] 发现 ${violations.length} 处契约与门面不一致:`);
  violations.forEach((v) => console.error(`  - ${v}`));
  process.exit(1);
} else {
  console.log("✔ [Facades Gate] 门面与核心契约检验通过（所有核心契约导出完整，0 处悬空引用）");
  process.exit(0);
}

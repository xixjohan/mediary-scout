#!/usr/bin/env node
/**
 * 门面导出与核心契约物理一致性门禁（tools/gates/check-facades.mjs）
 *
 * 守护契约：
 *   1. 核心共享基础层 (@media-track/shared / @media-track/contracts / @media-track/workflow) 与门面层
 *      必须导出关键网络与领域实体（如 formatNetworkError、isMultiUserEnabled 等）；
 *   2. apps/web/lib/workflow-runtime.ts 门面层必须持续暴露核心工作区与巡检契约方法，防架构重构时退化缺失；
 *   3. 静态扫描 apps/web 内部所有相对路径引用，验证引用的物理文件在磁盘真实存在（防 Module not found: Can't resolve）；
 *   4. 静态扫描 apps/web 内部所有对内部跨包及门面模块的具名 import，
 *      验证导入的每个符号在目标模块真实存在（防虚假引用导致的运行时 500 / Turbopack 编译报错）。
 *
 * 退出码: 0 = 通过, 1 = 违规 (逐条打印文件及缺失符号)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = join(root, "apps/web");
const workflowRuntimePath = join(root, "apps/web/lib/workflow-runtime.ts");
const authChainPath = join(root, "apps/web/lib/auth-chain.ts");
const workflowIndexPath = join(root, "packages/workflow/src/index.ts");
const contractsIndexPath = join(root, "packages/contracts/src/index.ts");
const sharedIndexPath = join(root, "packages/shared/src/index.ts");

const violations = [];

// 1. 关键契约必检硬核清单
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

const AUTH_CHAIN_REQUIRED_EXPORTS = [
  "isMultiUserEnabled",
  "resolveApiAccount",
  "requireApiAccount",
];

export function extractExportedSymbols(filePath, visited = new Set()) {
  if (!existsSync(filePath) || visited.has(filePath)) return new Set();
  visited.add(filePath);

  const content = readFileSync(filePath, "utf8");
  const exports = new Set();
  const dir = dirname(filePath);

  // export function foo / export const foo / export async function foo / export class foo
  const declRegex = /export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([a-zA-Z0-9_$]+)/g;
  let match;
  while ((match = declRegex.exec(content)) !== null) {
    if (match[1]) exports.add(match[1]);
  }

  // export { foo, bar as baz } [from "./rel"]
  // export type { foo, bar as baz } [from "./rel"]
  const namedRegex = /export\s+(?:type\s+)?\{([^}]+)\}(?:\s*from\s*["']([^"']+)["'])?/g;
  while ((match = namedRegex.exec(content)) !== null) {
    const items = match[1].split(",");
    const relSource = match[2];
    for (const item of items) {
      const parts = item.trim().split(/\s+as\s+/);
      const exportedName = (parts[1] || parts[0]).replace(/^type\s+/, "").trim();
      if (exportedName) exports.add(exportedName);
    }
    // 若带 from 且指向相对路径，递归追踪
    if (relSource && relSource.startsWith(".")) {
      const resolved = resolveTargetFile(dir, relSource);
      if (resolved) {
        const sub = extractExportedSymbols(resolved, visited);
        for (const s of sub) exports.add(s);
      }
    }
  }

  // export * from "./sub-barrel.js"
  const starRegex = /export\s*\*\s*from\s*["']([^"']+)["']/g;
  while ((match = starRegex.exec(content)) !== null) {
    const relTarget = match[1];
    if (relTarget.startsWith(".")) {
      const resolved = resolveTargetFile(dir, relTarget);
      if (resolved) {
        const subExports = extractExportedSymbols(resolved, visited);
        for (const s of subExports) exports.add(s);
      }
    }
  }

  return exports;
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", "/index.ts", "/index.tsx", "/index.js"];

function resolveTargetFile(baseDir, specifier) {
  const direct = resolve(baseDir, specifier);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;
  const noJs = direct.replace(/\.js$/, "");
  for (const ext of EXTENSIONS) {
    if (existsSync(noJs + ext) && statSync(noJs + ext).isFile()) {
      return noJs + ext;
    }
  }
  return null;
}

const packageSymbolRegistry = {
  "@media-track/shared": extractExportedSymbols(sharedIndexPath),
  "@media-track/contracts": extractExportedSymbols(contractsIndexPath),
  "@media-track/workflow": extractExportedSymbols(workflowIndexPath),
};

const runtimeExports = extractExportedSymbols(workflowRuntimePath);
const authChainExports = extractExportedSymbols(authChainPath);

// 校验关键方法硬契约是否存在
for (const symbol of WORKFLOW_RUNTIME_REQUIRED_EXPORTS) {
  if (!runtimeExports.has(symbol)) {
    violations.push(
      `apps/web/lib/workflow-runtime.ts: 缺失必备核心契约导出 '${symbol}'（下游页面强依赖）`,
    );
  }
}

for (const symbol of WORKFLOW_REQUIRED_EXPORTS) {
  if (!packageSymbolRegistry["@media-track/workflow"].has(symbol)) {
    violations.push(
      `packages/workflow/src/index.ts: 缺失必备核心契约导出 '${symbol}'（跨包调用强依赖）`,
    );
  }
}

for (const symbol of AUTH_CHAIN_REQUIRED_EXPORTS) {
  if (!authChainExports.has(symbol)) {
    violations.push(
      `apps/web/lib/auth-chain.ts: 缺失必备核心契约导出 '${symbol}'（认证鉴权与状态机强依赖）`,
    );
  }
}

let checkedFilesCount = 0;
let checkedRelativeImportsCount = 0;
let checkedPackageImportsCount = 0;

// 2. 深度扫描 apps/web 内部所有相对 import 和跨模块 import
function scanDirectory(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      checkFileImports(fullPath);
    }
  }
}

function checkFileImports(filePath) {
  checkedFilesCount++;
  const rawContent = readFileSync(filePath, "utf8");
  const relPath = relative(root, filePath).replace(/\\/g, "/");
  const dir = dirname(filePath);

  // 剔除注释，防止注释中的代码引发误报
  const content = rawContent.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  // A. 校验所有相对模块引用的物理存在性 (防 Module not found: Can't resolve)
  const relativeImportRegex = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?from\s+)?["'](\.[^"']+)["']/g;
  let relMatch;
  while ((relMatch = relativeImportRegex.exec(content)) !== null) {
    const specifier = relMatch[1];
    if (specifier.endsWith(".css")) continue;
    checkedRelativeImportsCount++;
    const resolved = resolveTargetFile(dir, specifier);
    if (!resolved) {
      violations.push(`${relPath}: 引用了磁盘物理不存在的相对模块 '${specifier}'`);
    }
  }

  // B. 校验对内部 Workspace Packages 导出的具名一致性 (防 Export xxx doesn't exist)
  for (const [pkgName, symbols] of Object.entries(packageSymbolRegistry)) {
    const pkgRegex = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*["']${pkgName}["']`, "g");
    let pm;
    while ((pm = pkgRegex.exec(content)) !== null) {
      const items = pm[1].split(",");
      for (const item of items) {
        checkedPackageImportsCount++;
        const trimmed = item.trim();
        if (!trimmed) continue;
        const importedName = trimmed.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (!symbols.has(importedName)) {
          violations.push(`${relPath}: 从包 ${pkgName} 导入了未导出的符号 '${importedName}'`);
        }
      }
    }
  }

  // C. 校验对 workflow-runtime 门面具名引用的正确性
  if (filePath !== workflowRuntimePath) {
    const runtimeImportRegex = /import\s*\{([^}]+)\}\s*from\s*["'].*workflow-runtime["']/g;
    let rm;
    while ((rm = runtimeImportRegex.exec(content)) !== null) {
      const items = rm[1].split(",");
      for (const item of items) {
        checkedPackageImportsCount++;
        const trimmed = item.trim();
        if (!trimmed) continue;
        const importedName = trimmed.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (!runtimeExports.has(importedName)) {
          violations.push(`${relPath}: 从 workflow-runtime 导入了未导出的符号 '${importedName}'`);
        }
      }
    }
  }

  // D. 校验对 auth-chain 具名引用的正确性
  if (filePath !== authChainPath) {
    const authImportRegex = /import\s*\{([^}]+)\}\s*from\s*["'].*auth-chain["']/g;
    let am;
    while ((am = authImportRegex.exec(content)) !== null) {
      const items = am[1].split(",");
      for (const item of items) {
        checkedPackageImportsCount++;
        const trimmed = item.trim();
        if (!trimmed) continue;
        const importedName = trimmed.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (!authChainExports.has(importedName)) {
          violations.push(`${relPath}: 从 auth-chain 导入了未导出的符号 '${importedName}'`);
        }
      }
    }
  }
}

scanDirectory(webRoot);

if (violations.length > 0) {
  console.error(`\n❌ [Facades Gate] 发现 ${violations.length} 处契约与模块引用违规:`);
  violations.forEach((v) => console.error(`  - ${v}`));
  process.exit(1);
} else {
  console.log(
    `✔ [Facades Gate] 门面与契约物理一致性检验通过 (已校验 ${checkedFilesCount} 个模块, ${checkedRelativeImportsCount} 处相对引用, ${checkedPackageImportsCount} 处包导入, 0 处悬空引用)`,
  );
  process.exit(0);
}

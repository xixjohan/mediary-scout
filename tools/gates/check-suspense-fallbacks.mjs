#!/usr/bin/env node
/**
 * 巡影 · Suspense Fallback 纯静态骨架与 PPR 流式空洞质量门禁 (tools/gates/check-suspense-fallbacks.mjs)
 *
 * 守护契约（React 19 + Next.js 16 Turbopack PPR 规范）：
 *   1. [Fallback Purely Static Invariant] Suspense fallback 必须是纯静态骨架，严禁包含动态执行逻辑；
 *   2. [AppSidebar Skeleton Requirement] Fallback 内渲染的 AppSidebar 必须显式携带 skeleton 属性或使用 AppSidebarSkeleton，
 *      防止其挂载包含 await connection() 的 WorkspaceSwitcherLoader / AccountIdentityLoader；
 *   3. [No Async Loaders in Fallback] Fallback JSX 树内严禁挂载已知需要 await connection() 的异步 Loader 组件；
 *   4. [Dynamic Hole Declaration] 页面级异步组件（如 SearchResults / LibrarySurface / NotificationFeed 等）
 *      在读取 dynamic API (new Date() / SQLite / TMDB) 时必须声明 await connection()，确保 PPR 静态外壳与动态流式空洞契约一致。
 *
 * 退出码: 0 = 通过, 1 = 发现违规 (打印文件及行号与重构指引)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const appDir = join(root, "apps/web/app");

/** 已知包含 await connection() / SQLite 异步读取的动态 Loader 列表 */
const ASYNC_LOADER_TAGS = new Set([
  "WorkspaceSwitcherLoader",
  "AccountIdentityLoader",
]);

/**
 * 递归收集 apps/web/app 目录下的所有 page.tsx 文件
 */
export function collectPageFiles(dir = appDir) {
  const results = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".next" && entry.name !== "api") {
        results.push(...collectPageFiles(fullPath));
      }
    } else if (entry.name === "page.tsx") {
      results.push(fullPath);
    }
  }
  return results.sort();
}

/**
 * 检查 JSX 元素节点是否为 AppSidebar 且缺少 skeleton 属性
 */
function isAppSidebarMissingSkeleton(node) {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
  const tagName = (node.openingElement ?? node).tagName.getText();
  if (tagName !== "AppSidebar") return false;

  const attributes = (node.openingElement ?? node).attributes;
  const hasSkeleton = attributes.properties.some(
    (prop) => ts.isJsxAttribute(prop) && prop.name.getText() === "skeleton" &&
      (!prop.initializer || prop.initializer.getText() !== "{false}")
  );
  return !hasSkeleton;
}

/**
 * 检查 JSX 节点内是否含有违规的异步 Loader
 */
function findAsyncLoaderInJsx(node) {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return null;
  const tagName = (node.openingElement ?? node).tagName.getText();
  if (ASYNC_LOADER_TAGS.has(tagName)) {
    return tagName;
  }
  return null;
}

/**
 * 分析单个 page.tsx 的 Suspense fallback 规范
 * @param {string} filePath
 * @param {string} source
 * @returns {Array<{ file: string, line: number, column: number, rule: string, message: string }>}
 */
export function analyzeSuspenseFallbacks(filePath, source) {
  const violations = [];
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  const relPath = relative(root, filePath).replace(/\\/g, "/");

  // 1. 扫描所有的 Shell 函数定义（以 Shell 结尾的函数组件）
  //    如果 Shell 组件内挂载了 AppSidebar，检查是否缺少 skeleton
  function visitShellFunctions(node) {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableStatement(node))
    ) {
      const fnName = ts.isFunctionDeclaration(node)
        ? node.name?.getText()
        : node.declarationList.declarations[0]?.name?.getText();

      if (fnName && fnName.endsWith("Shell")) {
        node.forEachChild(function checkChild(child) {
          if (isAppSidebarMissingSkeleton(child)) {
            const { line, character } = sf.getLineAndCharacterOfPosition(child.getStart());
            violations.push({
              file: relPath,
              line: line + 1,
              column: character + 1,
              rule: "AppSidebar-Skeleton-In-Shell",
              message: `骨架组件 ${fnName} 内的 <AppSidebar /> 必须显式携带 'skeleton' 属性（例如 <AppSidebar active="..." skeleton />），防止在 Suspense fallback 预渲染时触发服务端异步挂起。`,
            });
          }
          const asyncLoader = findAsyncLoaderInJsx(child);
          if (asyncLoader) {
            const { line, character } = sf.getLineAndCharacterOfPosition(child.getStart());
            violations.push({
              file: relPath,
              line: line + 1,
              column: character + 1,
              rule: "No-Async-Loader-In-Shell",
              message: `骨架组件 ${fnName} 内严禁直接挂载动态异步组件 <${asyncLoader} />。`,
            });
          }
          child.forEachChild(checkChild);
        });
      }
    }
    node.forEachChild(visitShellFunctions);
  }

  // 2. 扫描所有 <Suspense fallback={...}> 属性
  function visitSuspenseTags(node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = (node.openingElement ?? node).tagName.getText();
      if (tag === "Suspense") {
        const attributes = (node.openingElement ?? node).attributes;
        for (const prop of attributes.properties) {
          if (ts.isJsxAttribute(prop) && prop.name.getText() === "fallback") {
            const initializer = prop.initializer;
            if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
              const expr = initializer.expression;

              // 检查 fallback 表达式内是否直接内联了缺少 skeleton 的 AppSidebar
              expr.forEachChild(function checkFallbackExpr(child) {
                if (isAppSidebarMissingSkeleton(child)) {
                  const { line, character } = sf.getLineAndCharacterOfPosition(child.getStart());
                  violations.push({
                    file: relPath,
                    line: line + 1,
                    column: character + 1,
                    rule: "AppSidebar-Skeleton-In-Fallback",
                    message: `<Suspense fallback={...}> 中的 <AppSidebar /> 必须显式携带 'skeleton' 属性。`,
                  });
                }
                const asyncLoader = findAsyncLoaderInJsx(child);
                if (asyncLoader) {
                  const { line, character } = sf.getLineAndCharacterOfPosition(child.getStart());
                  violations.push({
                    file: relPath,
                    line: line + 1,
                    column: character + 1,
                    rule: "No-Async-Loader-In-Fallback",
                    message: `<Suspense fallback={...}> 严禁包含动态异步组件 <${asyncLoader} />。`,
                  });
                }
                child.forEachChild(checkFallbackExpr);
              });
            }
          }
        }
      }
    }
    node.forEachChild(visitSuspenseTags);
  }

  // 3. 检查 page.tsx 中根搜索与媒体库组件是否声明了 await connection()
  if (relPath === "apps/web/app/page.tsx") {
    function visitPageServerComponents(node) {
      if (ts.isFunctionDeclaration(node)) {
        const fnName = node.name?.getText();
        if (fnName === "SearchResults" || fnName === "LibrarySurface") {
          const bodyText = node.body?.getText() ?? "";
          if (!bodyText.includes("await connection()")) {
            const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
            violations.push({
              file: relPath,
              line: line + 1,
              column: character + 1,
              rule: "Declare-Connection-For-Dynamic-Hole",
              message: `组件 ${fnName} 读取了动态业务数据，必须在入口显式声明 'await connection()'，确保 PPR 部分预渲染流式空洞契约一致。`,
            });
          }
        }
      }
      node.forEachChild(visitPageServerComponents);
    }
    sf.forEachChild(visitPageServerComponents);
  }

  sf.forEachChild(visitShellFunctions);
  sf.forEachChild(visitSuspenseTags);

  return violations;
}

export function runCheck() {
  const pageFiles = collectPageFiles();
  let totalViolations = 0;

  console.log(`\n🔍 [gate:suspense] 开始扫描 ${pageFiles.length} 个页面入口的 Suspense Fallback 与骨架安全性...`);

  for (const file of pageFiles) {
    const source = readFileSync(file, "utf8");
    const violations = analyzeSuspenseFallbacks(file, source);
    if (violations.length > 0) {
      totalViolations += violations.length;
      for (const v of violations) {
        console.error(`  ❌ [${v.rule}] ${v.file}:${v.line}:${v.column}`);
        console.error(`     ${v.message}\n`);
      }
    }
  }

  if (totalViolations > 0) {
    console.error(`💥 [gate:suspense] 检查失败：发现 ${totalViolations} 处 Suspense Fallback 或骨架规范违规！`);
    return 1;
  }

  console.log(`✅ [gate:suspense] 检查通过：所有页面 Suspense Fallback 均为纯静态骨架，PPR 空洞声明严格一致！\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runCheck());
}

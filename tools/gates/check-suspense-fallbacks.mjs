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

  // 2. 扫描本文件定义的所有 async 函数（函数声明或变量声明）
  const asyncFunctionsInFile = new Map();
  function collectAsyncFunctions(node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      if (isAsync) {
        asyncFunctionsInFile.set(node.name.getText(), node);
      }
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.name && ts.isIdentifier(decl.name) && decl.initializer) {
          const init = decl.initializer;
          if (
            (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
            init.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
          ) {
            asyncFunctionsInFile.set(decl.name.getText(), init);
          }
        }
      }
    }
    node.forEachChild(collectAsyncFunctions);
  }
  sf.forEachChild(collectAsyncFunctions);

  // 辅助函数：判断 AST 节点及其后代中是否包含 await connection() 调用
  function hasAwaitConnectionCall(fnNode) {
    let found = false;
    function checkNode(n) {
      if (found) return;
      if (ts.isAwaitExpression(n)) {
        const expr = n.expression;
        if (ts.isCallExpression(expr)) {
          const calleeText = expr.expression.getText();
          if (calleeText === "connection") {
            found = true;
            return;
          }
        }
      }
      n.forEachChild(checkNode);
    }
    const body = fnNode.body;
    if (body) {
      body.forEachChild(checkNode);
    }
    return found;
  }

  // 3. 扫描所有 <Suspense fallback={...}> 属性与子组件动态声明
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

        // 检查 Suspense 子节点中的本文件异步组件，断言必须包含 await connection()
        if (ts.isJsxElement(node)) {
          function checkSuspenseChildren(childNode) {
            if (ts.isJsxElement(childNode) || ts.isJsxSelfClosingElement(childNode)) {
              const childTag = (childNode.openingElement ?? childNode).tagName.getText();
              if (childTag === "PageLoginGuard") return;
              const asyncFnNode = asyncFunctionsInFile.get(childTag);
              if (asyncFnNode && !hasAwaitConnectionCall(asyncFnNode)) {
                const { line, character } = sf.getLineAndCharacterOfPosition(childNode.getStart());
                violations.push({
                  file: relPath,
                  line: line + 1,
                  column: character + 1,
                  rule: "Dynamic-Hole-Connection-Required",
                  message: `异步页面动态空洞组件 <${childTag} /> 由 <Suspense> 挂载，必须在函数体内显式声明 'await connection()'，切断预渲染静态阶段以防止 new Date() / 会话鉴权触发 Blocking Route 异常。`,
                });
              }
            }
            if (ts.isJsxElement(childNode) || ts.isJsxFragment(childNode)) {
              childNode.children.forEach(checkSuspenseChildren);
            }
          }
          node.children.forEach(checkSuspenseChildren);
        }
      }
    }
    node.forEachChild(visitSuspenseTags);
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

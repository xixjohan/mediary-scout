#!/usr/bin/env node
/**
 * Next.js 阻塞性路由与流式渲染架构门禁 (tools/gates/check-blocking-routes.mjs)
 *
 * 守护契约（Next.js 16+ PPR / Streaming SSR 规范）：
 *   1. [Anti-Blocking Route] 页面根导出（export default）严禁声明为 async 函数；
 *      （Next.js 16 PPR/cacheComponents 下，根组件 async 并在顶层 await 会阻塞首屏外壳流式推送，
 *        触发 Blocking Route 性能报警：https://nextjs.org/docs/messages/blocking-route）
 *   2. [Suspense Boundary] 消费 searchParams、params 或动态请求数据的组件必须包裹在 <Suspense> 边界内；
 *   3. [Fallback Requirement] 页面内的 <Suspense> 边界必须显式指定 fallback 属性（如 Shell 骨架屏）；
 *   4. [Auth Guard Integrity] 所有受保护页面必须在 <Suspense> 边界内挂载 <PageLoginGuard />。
 *
 * 退出码: 0 = 通过, 1 = 发现违规 (逐条打印文件及行号与重构指引)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const appDir = join(root, "apps/web/app");

/** 豁免无需 PageLoginGuard 的公共路由白名单 */
const PUBLIC_GUARD_ALLOWLIST = new Set([
  "login/page.tsx",
]);

/**
 * 递归收集指定目录下所有 page.tsx 与 not-found.tsx
 * @param {string} dir
 * @returns {string[]}
 */
export function collectRouteFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".next" && entry.name !== "api") {
        results.push(...collectRouteFiles(fullPath));
      }
    } else if (entry.name === "page.tsx" || entry.name === "not-found.tsx") {
      results.push(fullPath);
    }
  }
  return results.sort();
}

/**
 * 分析单个路由文件代码是否符合 Next.js 流式渲染与 Suspense 规范
 * @param {string} filePath
 * @param {string} source
 * @returns {Array<{ file: string, line: number, column: number, rule: string, message: string }>}
 */
export function analyzeRouteSource(filePath, source) {
  const violations = [];
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const relPath = relative(root, filePath).replace(/\\/g, "/");
  const normalizedRel = relPath.replace(/^apps\/web\/app\//, "");
  const isPublicPage = PUBLIC_GUARD_ALLOWLIST.has(normalizedRel);

  let defaultExportNode = null;
  let defaultExportIsAsync = false;
  let hasDynamicProps = false;
  let suspenseCount = 0;
  let guardCount = 0;
  let guardInsideSuspense = 0;
  const suspensesWithoutFallback = [];
  const directDynamicAwaits = [];

  // 1. 遍历顶层节点识别 default export
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const isExport = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const isDefault = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (isExport && isDefault) {
        defaultExportNode = statement;
        defaultExportIsAsync = Boolean(statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
        const paramsText = statement.parameters.map((p) => p.name.getText(sf)).join(" ");
        if (/searchParams|params/.test(paramsText)) {
          hasDynamicProps = true;
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      defaultExportNode = statement.expression;
      if (
        (ts.isArrowFunction(statement.expression) || ts.isFunctionExpression(statement.expression)) &&
        statement.expression.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        defaultExportIsAsync = true;
      }
    }
  }

  // 2. 深度遍历检查规则
  function visit(node) {
    // 检查是否有在根 export default 中直接 await 动态数据的行为
    if (defaultExportNode && (node.parent === defaultExportNode || isDescendantOf(node, defaultExportNode))) {
      if (ts.isAwaitExpression(node)) {
        const exprText = node.expression.getText(sf);
        if (/searchParams|params|cookies\(\)|headers\(\)|connection\(\)/.test(exprText)) {
          directDynamicAwaits.push(node);
        }
      }
    }

    // 检查 JSX 中的 Suspense 与 fallback
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText(sf);
      if (tagName === "Suspense") {
        suspenseCount += 1;
        const hasFallback = node.attributes.properties.some((attr) => {
          return ts.isJsxAttribute(attr) && attr.name.getText(sf) === "fallback";
        });
        if (!hasFallback) {
          suspensesWithoutFallback.push(node);
        }
      }

      // 检查 PageLoginGuard
      if (tagName === "PageLoginGuard") {
        guardCount += 1;
        if (isInsideSuspense(node, sf)) {
          guardInsideSuspense += 1;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);

  // 规则 1: export default 严禁声明为 async 函数（防 Blocking Route 根源）
  if (defaultExportIsAsync) {
    const { line, character } = sf.getLineAndCharacterOfPosition(defaultExportNode.getStart(sf));
    violations.push({
      file: relPath,
      line: line + 1,
      column: character + 1,
      rule: "anti-blocking-route-async-export",
      message:
        "页面根导出（export default）不可声明为 async 函数。在 Next.js PPR 模式下，根页面异步会导致整页首屏阻塞。应重构为同步 Page 组件，将异步数据查询下沉到 <Suspense fallback={<*Shell />}> 内的 *Surface 组件中。",
    });
  }

  // 规则 1.1: 根 default export 严禁直接 await searchParams / params / cookies
  for (const awaitNode of directDynamicAwaits) {
    const { line, character } = sf.getLineAndCharacterOfPosition(awaitNode.getStart(sf));
    violations.push({
      file: relPath,
      line: line + 1,
      column: character + 1,
      rule: "anti-blocking-route-direct-await",
      message: `直接在根导出中执行 '${awaitNode.getText(sf)}' 会破坏 Next.js 流式渲染并触发 Blocking Route 报警。必须将其放入被 <Suspense> 包裹的子组件中。`,
    });
  }

  // 规则 2: 具有 searchParams 或 params 动态参数的页面必须包含 <Suspense>
  if (hasDynamicProps && suspenseCount === 0) {
    const pos = defaultExportNode ? defaultExportNode.getStart(sf) : 0;
    const { line, character } = sf.getLineAndCharacterOfPosition(pos);
    violations.push({
      file: relPath,
      line: line + 1,
      column: character + 1,
      rule: "suspense-boundary-required",
      message:
        "页面接收动态参数（searchParams/params），但未返回任何 <Suspense> 边界。请使用 <Suspense fallback={<*Shell />}> 包裹消费动态参数的 Surface 组件。",
    });
  }

  // 规则 3: 所有 <Suspense> 必须具有 fallback
  for (const suspenseNode of suspensesWithoutFallback) {
    const { line, character } = sf.getLineAndCharacterOfPosition(suspenseNode.getStart(sf));
    violations.push({
      file: relPath,
      line: line + 1,
      column: character + 1,
      rule: "suspense-fallback-missing",
      message: "<Suspense> 边界缺少 fallback 属性。必须提供骨架屏或 Shell（例如 fallback={<PageShell />}），避免首屏布局偏移。",
    });
  }

  // 规则 4: 受保护页面必须挂载 PageLoginGuard 并置于 <Suspense> 内
  if (!isPublicPage && (guardCount !== 1 || guardInsideSuspense !== 1)) {
    const pos = defaultExportNode ? defaultExportNode.getStart(sf) : 0;
    const { line, character } = sf.getLineAndCharacterOfPosition(pos);
    violations.push({
      file: relPath,
      line: line + 1,
      column: character + 1,
      rule: "page-login-guard-missing-or-unsuspended",
      message: `受保护页面必须包含正好一次 <Suspense fallback={null}><PageLoginGuard /></Suspense>（当前: 挂载 ${guardCount} 次, 位于 Suspense 内 ${guardInsideSuspense} 次）。`,
    });
  }

  return violations;
}

function isDescendantOf(child, parent) {
  let curr = child.parent;
  while (curr) {
    if (curr === parent) return true;
    curr = curr.parent;
  }
  return false;
}

function isInsideSuspense(node, sf) {
  let cur = node.parent;
  while (cur) {
    if (ts.isJsxElement(cur)) {
      if (cur.openingElement.tagName.getText(sf) === "Suspense") return true;
    }
    cur = cur.parent;
  }
  return false;
}

/** CLI 主运行逻辑 */
export function runGate() {
  const files = collectRouteFiles(appDir);
  const allViolations = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const violations = analyzeRouteSource(file, content);
    allViolations.push(...violations);
  }

  if (allViolations.length > 0) {
    console.error(`\x1b[31m[Blocking Routes Gate] 发现 ${allViolations.length} 项 Next.js 路由规范违规：\x1b[0m\n`);
    for (const v of allViolations) {
      console.error(`  \x1b[33m${v.file}:${v.line}:${v.column}\x1b[0m [\x1b[36m${v.rule}\x1b[0m]`);
      console.error(`    ${v.message}\n`);
    }
    return { passed: false, violations: allViolations };
  }

  console.log(
    `\x1b[32m[Blocking Routes Gate] 质检通过：已检查 ${files.length} 个路由文件，0 个阻塞性路由 (0 violations)\x1b[0m`,
  );
  return { passed: true, violations: [] };
}

// 若作为命令行直接执行
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { passed } = runGate();
  process.exit(passed ? 0 : 1);
}

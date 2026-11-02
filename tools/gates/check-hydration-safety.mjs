#!/usr/bin/env node
/**
 * 巡影 · 水合一致性与流式外壳安全架构门禁 (tools/gates/check-hydration-safety.mjs)
 *
 * 守护契约（React 19 + Next.js 16 Turbopack PPR 规范）：
 *   1. [Shell Navigation Safety] 静态外壳组件（apps/web/components/layout/ 及侧边栏组件）严禁直接调用 useSearchParams()；
 *   2. [Canonical Auth Formatter Invariant] 认证与用户展示组件（apps/web/features/auth/components/）必须统一调用
 *      formatAccountDisplayName 与 formatAccountInitial，严禁服务端与客户端各自内联三元判定；
 *   3. [Render-Time Browser Globals Prohibition] 客户端组件（"use client"）渲染主体内严禁同步访问 window.* / localStorage.* / document.*
 *      （必须置于 useEffect/useCallback/事件处理函数内，防 SSR 崩溃与水合撕裂）；
 *   4. [Async Loader Suspense Enclosure] 侧边栏与静态外壳中挂载的异步 *Loader 组件必须置于 <Suspense fallback={...}> 内；
 *   5. [Suppress Hydration Warning Governance] suppressHydrationWarning 严禁随意滥用掩盖水合逻辑缺陷，仅限白名单组件与根标签。
 *
 * 退出码: 0 = 通过, 1 = 发现违规 (逐条打印文件及行号与重构指引)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const webDir = join(root, "apps/web");

/** 允许使用 suppressHydrationWarning 的特定文件白名单 */
const SUPPRESS_HYDRATION_ALLOWLIST = new Set([
  "apps/web/app/layout.tsx", // 根 HTML/Body，防止浏览器翻译插件属性注入
  "apps/web/components/layout/back-link.tsx", // 翻译扩展修改 "返回" 文本
  "apps/web/features/catalog/components/movie-synopsis.tsx", // 扩展文本翻译注入
  "apps/web/features/assistant/components/chat-cards.tsx", // 相对时间戳容错
]);

/**
 * 递归收集指定目录下所有 .ts 与 .tsx 文件（排除测试文件与 build 产物）
 */
export function collectSourceFiles(dir, filter) {
  const results = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".next" && entry.name !== "dist") {
        results.push(...collectSourceFiles(fullPath, filter));
      }
    } else if (
      (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx") &&
      !entry.name.endsWith(".d.ts")
    ) {
      if (!filter || filter(fullPath)) {
        results.push(fullPath);
      }
    }
  }
  return results.sort();
}

/**
 * 分析单个源码文件的水合安全性
 * @param {string} filePath
 * @param {string} source
 * @returns {Array<{ file: string, line: number, column: number, rule: string, message: string }>}
 */
export function analyzeHydrationSafety(filePath, source) {
  const violations = [];
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const relPath = relative(root, filePath).replace(/\\/g, "/");
  const isLayoutComponent = relPath.includes("apps/web/components/layout/");
  const isAuthComponent = relPath.includes("apps/web/features/auth/components/");
  const isClientComponent = /["']use client["']/.test(source.slice(0, 100));

  function getLoc(node) {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: line + 1, column: character + 1 };
  }

  // 辅助判定：节点是否处于嵌套函数、Hook 或事件回调中（非组件同步渲染执行路径）
  function isInsideNestedFunctionOrHook(node) {
    let cur = node.parent;
    let componentFound = false;

    // 检查是否作为 createPortal 的第二个参数
    if (cur && ts.isCallExpression(cur) && cur.expression.getText(sf) === "createPortal") {
      return true;
    }

    while (cur) {
      // 检查是否受 typeof window !== 'undefined' 守卫（if 语句或三元表达式）
      if (ts.isIfStatement(cur)) {
        const condText = cur.expression.getText(sf);
        if (/typeof\s+(window|document)\s*!==?\s*['"]undefined['"]/.test(condText)) {
          return true;
        }
      }
      if (ts.isConditionalExpression(cur)) {
        const condText = cur.condition.getText(sf);
        if (/typeof\s+(window|document)\s*!==?\s*['"]undefined['"]/.test(condText)) {
          return true;
        }
      }

      // 检查 Hook 调用 (useEffect / useLayoutEffect / useCallback / useMemo)
      if (ts.isCallExpression(cur)) {
        const callName = cur.expression.getText(sf);
        if (/^(useEffect|useLayoutEffect|useCallback|useMemo)$/.test(callName)) {
          return true;
        }
      }

      // 检查函数作用域
      if (
        ts.isArrowFunction(cur) ||
        ts.isFunctionExpression(cur) ||
        ts.isFunctionDeclaration(cur)
      ) {
        // 如果是顶层 React 组件（大写字母开头），先记下
        const funcName = cur.name?.getText(sf) || (cur.parent && ts.isVariableDeclaration(cur.parent) ? cur.parent.name.getText(sf) : "");
        const isComponent = /^[A-Z]/.test(funcName) || (cur.parent && ts.isExportAssignment(cur.parent));

        if (!isComponent) {
          // 位于非组件的普通子函数内部（例如 handleSubmit / onClick 回调），不属于渲染期执行
          return true;
        }

        componentFound = true;
      }

      cur = cur.parent;
    }

    // 若直接处于组件顶层渲染体中且无任何中间普通函数隔离，则属于渲染期同步执行
    return !componentFound;
  }

  function visit(node) {
    // 规则 1: 静态外壳组件严禁直接调用 useSearchParams
    if (isLayoutComponent && ts.isCallExpression(node)) {
      const callText = node.expression.getText(sf);
      if (callText === "useSearchParams") {
        const { line, column } = getLoc(node);
        violations.push({
          file: relPath,
          line,
          column,
          rule: "shell-no-direct-search-params",
          message:
            "静态外壳/侧边栏组件严禁直接调用 useSearchParams()。在 Next.js PPR 模式下会破坏外壳缓存并引发客户端刷新重载，应通过 Props 透传参数。",
        });
      }
    }

    // 规则 2: 认证组件展示名称与头像徽章格式化一致性门禁
    if (isAuthComponent && (relPath.endsWith("account-identity.tsx") || relPath.endsWith("user-profile-modal.tsx"))) {
      // 检查是否有硬编码内联判定 `username === "default"`
      if (ts.isBinaryExpression(node)) {
        const text = node.getText(sf);
        if (/=== ["']default["']|=== ["']acct_default["']/.test(text)) {
          // 如果不在 formatAccountDisplayName 纯函数内部定义中，则属于违规内联
          let inFormatFunc = false;
          let cur = node.parent;
          while (cur) {
            if (ts.isFunctionDeclaration(cur) && cur.name?.getText(sf) === "formatAccountDisplayName") {
              inFormatFunc = true;
              break;
            }
            cur = cur.parent;
          }
          if (!inFormatFunc) {
            const { line, column } = getLoc(node);
            violations.push({
              file: relPath,
              line,
              column,
              rule: "canonical-auth-display-formatter",
              message:
                "严禁在组件渲染中内联判定默认账号别名。必须统一调用 formatAccountDisplayName / formatAccountInitial 纯函数以确保 SSR 与客户端水合一致。",
            });
          }
        }
      }
    }

    // 规则 3: 客户端组件渲染主体内严禁直接同步访问 window.* / localStorage.* / document.*
    if (isClientComponent && ts.isPropertyAccessExpression(node)) {
      const exprText = node.expression.getText(sf);
      if (["window", "localStorage", "sessionStorage", "document"].includes(exprText)) {
        if (!isInsideNestedFunctionOrHook(node)) {
          // 排除纯类型断言或 typeof window 守卫
          const isTypeGuard = node.parent && ts.isTypeOfExpression(node.parent);
          if (!isTypeGuard) {
            const { line, column } = getLoc(node);
            violations.push({
              file: relPath,
              line,
              column,
              rule: "no-render-time-browser-globals",
              message: `客户端组件渲染期严禁直接同步访问 '${node.getText(sf)}'。此行为在 SSR 时会抛出 ReferenceError 或产生两端 HTML 差异。必须放入 useEffect 或事件回调中。`,
            });
          }
        }
      }
    }

    // 规则 4: 检查布局组件中引用的 *Loader 是否包裹在 Suspense 内
    if (isLayoutComponent && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
      const tagName = node.tagName.getText(sf);
      if (/^[A-Z][a-zA-Z0-9]*Loader$/.test(tagName)) {
        let insideSuspense = false;
        let cur = node.parent;
        while (cur) {
          if (ts.isJsxElement(cur)) {
            if (cur.openingElement.tagName.getText(sf) === "Suspense") {
              insideSuspense = true;
              break;
            }
          }
          cur = cur.parent;
        }
        if (!insideSuspense) {
          const { line, column } = getLoc(node);
          violations.push({
            file: relPath,
            line,
            column,
            rule: "async-loader-suspense-enclosed",
            message: `异步数据组件 '<${tagName} />' 在静态外壳中必须包裹在 <Suspense fallback={...}> 内，避免阻塞静态首屏并消除水合撕裂。`,
          });
        }
      }
    }

    // 规则 5: suppressHydrationWarning 白名单管控
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === "suppressHydrationWarning") {
      if (!SUPPRESS_HYDRATION_ALLOWLIST.has(relPath)) {
        const { line, column } = getLoc(node);
        violations.push({
          file: relPath,
          line,
          column,
          rule: "suppress-hydration-warning-allowlist",
          message:
            "suppressHydrationWarning 仅允许在经过架构评审的白名单文件（如根 html/body 或防翻译插件特定标签）中使用，严禁用于随意掩盖业务水合 Bug。",
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return violations;
}

/** CLI 主运行逻辑 */
export function runGate() {
  const files = collectSourceFiles(webDir);
  const allViolations = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const violations = analyzeHydrationSafety(file, content);
    allViolations.push(...violations);
  }

  if (allViolations.length > 0) {
    console.error(`\x1b[31m[Hydration Safety Gate] 发现 ${allViolations.length} 项水合安全与外壳规范违规：\x1b[0m\n`);
    for (const v of allViolations) {
      console.error(`  \x1b[33m${v.file}:${v.line}:${v.column}\x1b[0m [\x1b[36m${v.rule}\x1b[0m]`);
      console.error(`    ${v.message}\n`);
    }
    return { passed: false, violations: allViolations };
  }

  console.log(
    `\x1b[32m[Hydration Safety Gate] 质检通过：已扫描 ${files.length} 个前端组件与外壳源码，0 项水合安全违规 (0 violations)\x1b[0m`,
  );
  return { passed: true, violations: [] };
}

// 若作为命令行直接执行
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { passed } = runGate();
  process.exit(passed ? 0 : 1);
}

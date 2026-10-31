#!/usr/bin/env node
/**
 * Next.js Server Actions 与 Runtime 边界门禁（tools/gates/check-server-actions.mjs）
 *
 * 守护契约：
 *   1. 任何带有 "use server" 指令的文件，严禁使用 `export { ... } from "..."` 重导出语法；
 *      （Next.js SWC 编译期无法跨文件展开，报 "Only async functions are allowed to be exported in a 'use server' file"）
 *   2. 任何带有 "use server" 指令的文件，严禁包含 `export type` 或 `export { type ... }` 类型导出；
 *      （Next.js Server Actions 边界只允许导出 RPC 异步函数）
 *   3. apps/web/instrumentation.ts 严禁对 node:* 进行无保护的静态 import()，防止 Edge Runtime 报错。
 *
 * 退出码: 0 = 通过, 1 = 违规 (逐条打印文件及行号)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = join(root, "apps/web");

const violations = [];

function scanDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      checkFile(fullPath);
    }
  }
}

function checkFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  const relPath = relative(root, filePath).replace(/\\/g, "/");

  // 1) 扫描 "use server" 文件约束
  const hasUseServer = /^["']use server["'];?/m.test(content);
  if (hasUseServer) {
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const lineNum = index + 1;
      const trimmed = line.trim();

      // 禁止在 "use server" 文件中直接 re-export
      if (/^export\s*\{[^}]*\}\s*from\s*["'].+["'];?/.test(trimmed) || /^export\s*\*\s*from\s*["'].+["'];?/.test(trimmed)) {
        violations.push(
          `${relPath}:${lineNum}: "use server" 文件严禁使用 export ... from 跨文件重导出（Next.js SWC 无法跨文件识别 RPC 签名）`,
        );
      }

      // 禁止在 "use server" 文件中导出类型
      if (/^export\s+type\s+/.test(trimmed) || /^export\s*\{\s*type\s+/.test(trimmed)) {
        violations.push(
          `${relPath}:${lineNum}: "use server" 文件严禁导出 TypeScript 类型（SWC Server Actions 插件强制要求仅导出异步函数）`,
        );
      }
    });
  }

  // 2) instrumentation.ts 运行时保护
  if (relPath === "apps/web/instrumentation.ts") {
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const lineNum = index + 1;
      if (/import\s*\(\s*["']node:/.test(line) && !line.includes("process.getBuiltinModule") && !line.includes("webpackIgnore")) {
        violations.push(
          `${relPath}:${lineNum}: instrumentation.ts 中的 Node 原生模块导入必须使用 process.getBuiltinModule 或 webpackIgnore 保护，防止 Edge Runtime 静态解析失败`,
        );
      }
    });
  }
}

scanDir(webRoot);

if (violations.length > 0) {
  console.error(`\n❌ [Server Actions Gate] 发现 ${violations.length} 处规范违规:`);
  violations.forEach((v) => console.error(`  - ${v}`));
  process.exit(1);
} else {
  console.log("✔ [Server Actions Gate] 质检通过（无非法 'use server' 导出或 Edge 运行时泄漏）");
  process.exit(0);
}

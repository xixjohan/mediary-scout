#!/usr/bin/env node
/**
 * 剪贴板安全与非安全上下文（HTTP/局域网）降级门禁（Clipboard Safety Gate）
 *
 * 守护的不变量：
 * 任何业务 UI 组件不得直接裸调 `navigator.clipboard`。
 * 
 * 背景（2026-11-21 线上问题）：
 * 巡影（Mediary Scout）多运行于 NAS / 私有家庭网络（如 http://192.168.1.100:3000）。
 * 根据 W3C 规范，非 localhost 的 HTTP 协议下属于 Insecure Context，
 * `window.isSecureContext === false` 且 `navigator.clipboard === undefined`。
 * 若业务组件裸写 `navigator.clipboard.writeText(...)`，会同步抛出未捕获 TypeError：
 * `Cannot read properties of undefined (reading 'writeText')`，导致复制按钮毫无反应。
 *
 * 必须统一使用具备三级降级（Clipboard API -> 隐藏 Textarea + execCommand -> manual）的单源适配器：
 * `import { copyText } from "@/lib/copy-text"` (或相对路径导入 `lib/copy-text`)。
 *
 * 退出码：0 = 全部合规通过；1 = 发现违规。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const targetDir = join(root, "apps/web");

// 白名单允许实现剪贴板底层降级适配的文件（相对 root 路径）
const ALLOWED_FILES = new Set([
  join("apps/web/lib/copy-text.ts"),
  join("apps/web/features/player/clipboard.ts"),
]);

function stripComments(code) {
  // 移除单行与多行注释，避免注释或文档中的引用触发误报
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat(m.split("\n").length - 1))
    .replace(/\/\/.*$/gm, "");
}

function walk(dir) {
  const files = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry === "coverage") continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      if (entry.includes(".test.") || entry.includes(".spec.")) continue;
      files.push(fullPath);
    }
  }
  return files;
}

function run() {
  const files = walk(targetDir);
  const violations = [];
  let checkedCount = 0;

  const CLIPBOARD_REGEX = /\bnavigator(?:\s*\??\s*\.\s*clipboard)/g;

  for (const file of files) {
    const rel = relative(root, file);
    if (ALLOWED_FILES.has(rel)) continue;

    checkedCount++;
    const content = readFileSync(file, "utf8");
    const cleanContent = stripComments(content);

    const lines = cleanContent.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (CLIPBOARD_REGEX.test(line)) {
        violations.push({
          file: rel,
          line: i + 1,
          code: content.split("\n")[i].trim(),
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error("\n❌ [Clipboard Safety Gate] 发现非安全直接访问 `navigator.clipboard` 的违规调用！");
    console.error("  巡影在私有局域网 HTTP 部署下 `navigator.clipboard` 为 undefined，裸调将直接抛出 TypeError 导致按钮失灵。");
    console.error("  修复指引：请统一导入并使用具备 execCommand 降级的单源适配器：\n    import { copyText } from '@/lib/copy-text';\n");
    console.error("违规列表：");
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line} -> ${v.code}`);
    }
    console.error("");
    process.exit(1);
  }

  console.log(
    `✔ [Clipboard Safety Gate] 剪贴板安全与非安全上下文降级门禁通过：0 项违规 (已校验 ${checkedCount} 个前端模块)`
  );
  process.exit(0);
}

run();

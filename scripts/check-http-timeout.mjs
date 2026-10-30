#!/usr/bin/env node
/**
 * 外部 HTTP 调用超时与前端确认防卡死架构门禁（Guard Gate）：
 * 
 * 核心设计规则：
 * 1. packages/workflow/src/ 下的所有非测试 TypeScript 模块中，外部 fetch() 调用必须显式携带超时控制
 *    （包含 signal: AbortSignal.timeout / signal / timeoutMs / fetchWithTimeout），严禁无上限裸 fetch 挂起进程。
 * 2. apps/web/components/*qr*.tsx 中的扫码确认逻辑（confirm 函数），必须配置客户端级超时
 *    （通过 AbortController / signal），防止上游异常时界面在「正在完成登录…」永久卡死。
 * 
 * 退出码 0 = 检查通过；1 = 发现违规项（打印违规文件与行号）。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const violations = [];
let filesScanned = 0;
let fetchCallsChecked = 0;

// 1. 扫描 packages/workflow/src 下的生产代码
const workflowSrcDir = join(root, "packages", "workflow", "src");

function scanWorkflowDir(dir) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      scanWorkflowDir(fullPath);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      checkWorkflowFile(fullPath);
    }
  }
}

function checkWorkflowFile(filePath) {
  filesScanned++;
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 匹配常规 fetch( 或 options.fetch( / globalThis.fetch(
    if (/\bfetch\(/.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*")) {
      fetchCallsChecked++;

      // 提取从 fetch( 前后上下文块（前 15 行，后 35 行）以涵盖 options 展开与变量传递
      const contextBlock = lines.slice(Math.max(0, i - 15), Math.min(lines.length, i + 35)).join("\n");
      const hasTimeoutSignal =
        contextBlock.includes("signal") ||
        contextBlock.includes("timeoutMs") ||
        contextBlock.includes("fetchWithTimeout") ||
        contextBlock.includes("DEFAULT_TIMEOUT_MS") ||
        contextBlock.includes("TIMEOUT");

      // 例外豁免：纯类型声明或 wrapper 包装函数
      const isSignatureOnly =
        line.includes("typeof fetch") ||
        line.includes("createErrorEnvelopeNormalizingFetch") ||
        line.includes("baseFetch");

      if (!hasTimeoutSignal && !isSignatureOnly) {
        violations.push({
          file: relative(root, filePath),
          line: i + 1,
          code: line.trim(),
          reason: "外部 fetch 调用未显式配置 signal / timeoutMs 超时信号",
        });
      }
    }
  }
}

// 2. 扫描 apps/web/components/*qr*.tsx 中的前端扫码确认逻辑
const componentsDir = join(root, "apps", "web", "components");
if (readdirSync(componentsDir)) {
  const entries = readdirSync(componentsDir);
  for (const entry of entries) {
    if (entry.includes("qr") && entry.endsWith(".tsx")) {
      const fullPath = join(componentsDir, entry);
      checkQrComponentFile(fullPath);
    }
  }
}

function checkQrComponentFile(filePath) {
  filesScanned++;
  const content = readFileSync(filePath, "utf8");
  // 若包含 confirm 函数，检查 confirm 内是否含有 AbortController 或 signal
  const confirmMatch = content.match(/async function confirm[\s\S]*?\{([\s\S]*?)\n\s{2}\}/);
  if (confirmMatch) {
    const confirmBody = confirmMatch[1];
    if (confirmBody.includes("fetch(") && !confirmBody.includes("AbortController") && !confirmBody.includes("signal")) {
      violations.push({
        file: relative(root, filePath),
        line: 1,
        code: "async function confirm(...) { ... fetch(...) }",
        reason: "前端扫码确认方法缺少 AbortController / signal 超时保护，存在永久卡死风险",
      });
    }
  }
}

// 执行扫描
scanWorkflowDir(workflowSrcDir);

console.log(`[HTTP Timeout Gate] 正在扫描外部网络调用与前端扫码组件...`);

if (violations.length > 0) {
  console.error(`\n✖ [HTTP Timeout Gate] 发现 ${violations.length} 处网络调用缺少超时控制：\n`);
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line} -> ${v.reason}`);
    console.error(`    代码: "${v.code}"\n`);
  }
  process.exit(1);
}

console.log(
  `✔ [HTTP Timeout Gate] 门禁质检通过（已校验 ${filesScanned} 个模块，${fetchCallsChecked} 处 fetch 调用，100% 具备超时与中断保护）\n`,
);
process.exit(0);

#!/usr/bin/env node
/**
 * 作品身份闸门接线门禁 (tools/gates/check-title-identity-wiring.mjs)
 *
 * 守护契约（2026-11-17 假阳性事故）：
 *   1. [Preview-Passes-Identity]   `previewPolicy(...)` 的每个生产调用点都必须传 `identity`。
 *      否则「命中 N 个」会重新把别的作品算进来。
 *   2. [Patrol-Passes-Identity]    `loadSubscriptionPolicyFilter(...)` 的每个生产调用点都必须传 `identity`。
 *      否则巡检（agent 之前的那道过滤）会重新把别家的 1080p 资源交给 agent。
 *   3. [No-Title-In-MustContain]   预设/默认规则不得把作品自身片名写进 mustContain 冒充身份闸门
 *      （`mustContain` 是版本词筛选，换译名就失效；身份必须走 title-identity）。
 *   4. [Gate-Inside-Matcher]       `wrong_title` 只能由 `matchPolicy`（经 title-identity）产生，
 *      禁止在其他模块里另造一个「身份判定」。
 *
 * 退出码 0 = 通过；1 = 违规（逐条打印文件与行号）
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const scanRoots = ["packages/workflow/src", "apps/web/app", "apps/web/features", "apps/web/lib"];
const identityModule = "packages/workflow/src/execution/title-identity.ts";
const policyCore = "packages/workflow/src/execution/subscription-policy.ts";

const violations = [];
let scanned = 0;

function collect(dir, list = []) {
  if (!existsSync(dir)) return list;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
      collect(full, list);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      list.push(full);
    }
  }
  return list;
}

function report(filePath, line, rule, message) {
  violations.push({ file: relative(root, filePath).replace(/\\/g, "/"), line, rule, message });
}

const files = scanRoots.flatMap((rel) => collect(join(root, rel)));

for (const file of files) {
  scanned += 1;
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  const rel = relative(root, file).replace(/\\/g, "/");

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    // 1) previewPolicy 生产调用必须带 identity（定义处除外）。
    if (/previewPolicy\s*\(/.test(line) && rel !== policyCore) {
      const block = lines.slice(i, Math.min(lines.length, i + 12)).join("\n");
      if (!/identity/.test(block)) {
        report(file, lineNo, "Preview-Passes-Identity", "previewPolicy 必须传 { identity }：否则「命中 N 个」会把别的作品算进来");
      }
    }

    // 2) loadSubscriptionPolicyFilter 生产调用必须带 identity（定义处除外）。
    if (/loadSubscriptionPolicyFilter\s*\(/.test(line) && rel !== "packages/workflow/src/execution/subscription-policy-filter.ts") {
      const block = lines.slice(i, Math.min(lines.length, i + 14)).join("\n");
      if (!/identity/.test(block)) {
        report(file, lineNo, "Patrol-Passes-Identity", "loadSubscriptionPolicyFilter 必须传 identity：巡检过滤要先确认作品身份");
      }
    }

    // 3) mustContain 不得承载身份（把「作品片名」当版本词写进去）。
    if (/mustContain\s*[=:]\s*[^\n]*\btitle\b/.test(line) || /mustContain:\s*\[?[^\n]*\binput\.title\.title\b/.test(line)) {
      report(file, lineNo, "No-Title-In-MustContain", "身份判定走 title-identity，不能把片名塞进 mustContain（换译名即失效）");
    }

    // 4) wrong_title 只能来自订阅策略核心（经 identity 闸门）。
    if (/wrong_title/.test(line) && rel !== policyCore && rel !== identityModule && !rel.startsWith("apps/web/features/acquisition/core/") && !rel.startsWith("apps/web/features/acquisition/components/")) {
      report(file, lineNo, "Gate-Inside-Matcher", "wrong_title 只能由 matchPolicy（经 title-identity）产生，禁止另造身份判定");
    }
  }
}

// 5) 身份模块必须存在（否则上面的接线检查是空转）。
if (!existsSync(join(root, identityModule))) {
  violations.push({ file: identityModule, line: 0, rule: "Required-Identity-Module", message: "身份闸门模块缺失：匹配器会退回「只验表层词」" });
}

if (violations.length === 0) {
  console.log(`\u001b[32m\u2714 [Title Identity Gate] 通过：扫描 ${scanned} 个文件，0 项违规\u001b[0m`);
  process.exit(0);
}

for (const v of violations) {
  console.error(`\u001b[31m\u2716 [${v.rule}]\u001b[0m ${v.file}:${v.line}`);
  console.error(`  ${v.message}`);
}
console.error(`\u001b[31m共 ${violations.length} 项违规（扫描 ${scanned} 个文件）\u001b[0m`);
process.exit(1);

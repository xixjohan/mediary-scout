#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 「远端删了本地要跟着删」门禁 (STRM Orphan Cleanup Gate)
 *
 * 缺陷原型（2026-11-19 生产实测）：孤儿清理只挂在 `full_sync` 上，而所有创建入口
 * 的默认模式是 `incremental_missing`——于是「远端删了、本地该跟着删」这条常规同步
 * 语义在默认配置下永不发生（远端 38 个 / 本地 955 个，最近 12 次扫描 removed=0）。
 *
 * 反过来，直接放开删除就是另一个极端：`fetchRemoteFiles` 曾把失败吞成空数组，
 * 一次令牌过期或目录改名就能清空整库。
 *
 * 本门禁静态堵住四条：清理不得被模式门独占、遍历失败不得伪装成空、空盘保护必须
 * 覆盖所有模式、删除必须通知媒体服务器。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

let violations = 0;

function reportViolation(file, message) {
  console.error(`${c.red}✖ [STRM Orphan Gate Violation]${c.reset} ${path.relative(repoRoot, file)}`);
  console.error(`  ${c.yellow}原因:${c.reset} ${message}`);
  violations++;
}

/** 去掉注释：文档里提到这些名字是允许的，代码里出现才是接线。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const SCANNER = "packages/workflow/src/strm/strm-scanner.ts";
const RUNNER = "apps/web/features/strm/application/strm-runner-service.ts";

function readScanner() {
  const full = path.join(repoRoot, SCANNER);
  if (!fs.existsSync(full)) {
    reportViolation(full, "strm-scanner.ts 不存在：孤儿清理的落点缺失。");
    return null;
  }
  return stripComments(fs.readFileSync(full, "utf8"));
}

// ============================================================================
// 1. 清理不得被模式门独占
//
// 判据：`cleanOrphanFiles(` 的**调用点**（不是定义）不能被 `scanMode === "full_sync"`
// 的条件块包住。做法是取 runScan 函数体，找到调用点，回溯到最近的 `if (` 看条件里
// 是否只出现 full_sync 而没有 incremental 分支。
// ============================================================================
function checkCleanupNotModeGated() {
  const code = readScanner();
  if (code === null) return;

  const callIndex = code.lastIndexOf("await this.cleanOrphanFiles(");
  if (callIndex < 0) {
    reportViolation(SCANNER, "找不到 cleanOrphanFiles 的调用点：孤儿清理已从扫描流程里摘掉。");
    return;
  }

  // 回溯 600 字符，检查最近的控制条件。
  const window = code.slice(Math.max(0, callIndex - 600), callIndex);
  const lastIf = window.lastIndexOf("if (");
  if (lastIf >= 0) {
    const conditionEnd = window.indexOf("{", lastIf);
    const condition = window.slice(lastIf, conditionEnd < 0 ? window.length : conditionEnd);
    const mentionsFullSync = condition.includes('"full_sync"');
    const mentionsIncremental = condition.includes("incremental");
    if (mentionsFullSync && !mentionsIncremental) {
      reportViolation(
        SCANNER,
        'cleanOrphanFiles 仍被 `scanMode === "full_sync"` 独占：默认的 incremental_missing 永远不清理孤儿（这正是本缺陷）。',
      );
    }
  }

  if (!code.includes("largeDeletionNotice")) {
    reportViolation(
      SCANNER,
      "缺少 largeDeletionNotice()：大额删除没有任何审计痕迹，无法事后复核「这次为什么删了这么多」。",
    );
  }
}

// ============================================================================
// 2. 遍历失败不得伪装成空列表
//
// `catch { return [] }` 让「目录真的空了」与「这次没看到」不可区分——这是删除路径
// 最危险的输入。要求 fetchRemoteFiles 返回带 ok 标记的结果，且 catch 块里不得
// 直接返回空数组。
// ============================================================================
function checkTraversalReportsFailure() {
  const code = readScanner();
  if (code === null) return;

  if (!code.includes("RemoteTraversal")) {
    reportViolation(
      SCANNER,
      "fetchRemoteFiles 未返回 RemoteTraversal：遍历失败会被当成空列表，清理时等同于「远端全删了」。",
    );
    return;
  }
  if (!/ok:\s*false/.test(code)) {
    reportViolation(SCANNER, "不存在 `ok: false` 分支：遍历失败没有被显式表达。");
  }

  // 检查 catch 块内直接 return [] 的写法（曾经的缺陷形态）。
  const catchBlocks = code.match(/catch[^{]*\{[\s\S]{0,200}?\}/g) ?? [];
  for (const block of catchBlocks) {
    if (/return\s*\[\s*\]\s*;/.test(block)) {
      reportViolation(
        SCANNER,
        "catch 块里直接 `return []`：把「失败」伪装成「没有文件」，删除路径会据此清空本地库。",
      );
      break;
    }
  }
}

// ============================================================================
// 3. 空盘保护必须覆盖所有模式
//
// 清理解绑到所有模式后，若空盘保护仍只判 full_sync，增量模式就变成「一次故障
// 清空整库」的入口。
// ============================================================================
function checkEmptyProtectCoversAllModes() {
  const code = readScanner();
  if (code === null) return;

  const marker = "private checkEmptyProtect(";
  const start = code.indexOf(marker);
  if (start < 0) {
    reportViolation(SCANNER, "找不到 checkEmptyProtect：空盘保护被删。");
    return;
  }
  const bodyStart = code.indexOf("{", code.indexOf(")", start));
  let depth = 0;
  let bodyEnd = bodyStart;
  for (let index = bodyStart; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        bodyEnd = index;
        break;
      }
    }
  }
  const body = code.slice(bodyStart, bodyEnd + 1);
  if (body.includes('"full_sync"')) {
    reportViolation(
      SCANNER,
      "checkEmptyProtect 仍只看 full_sync：增量模式放开删除后，一次令牌过期就会清空整库。",
    );
  }
  if (!body.includes("forceAllowEmptyCleanup")) {
    reportViolation(SCANNER, "checkEmptyProtect 丢失了强制放行开关：真空盘无法被确认清理。");
  }
}

// ============================================================================
// 4. 删除必须通知媒体服务器
//
// 只通知生成时，被删掉的条目要等下一次全库扫描才消失——期间用户点开是 404。
// ============================================================================
function checkRemovedPathsNotified() {
  const scannerCode = readScanner();
  if (scannerCode !== null && !scannerCode.includes("removedPaths")) {
    reportViolation(
      SCANNER,
      "StrmScanResult 未收集 removedPaths：删除后无法通知媒体服务器，条目会一直留着（点开 404）。",
    );
  }

  const full = path.join(repoRoot, RUNNER);
  if (!fs.existsSync(full)) {
    reportViolation(full, "strm-runner-service.ts 不存在：通知落点缺失。");
    return;
  }
  const runnerCode = stripComments(fs.readFileSync(full, "utf8"));
  if (!runnerCode.includes("removedPaths")) {
    reportViolation(
      RUNNER,
      "notifyFilesChanged 未消费 removedPaths：删了 .strm 却不通知 Emby/Jellyfin，条目要等下次全库扫描才消失。",
    );
  }
}

// ============================================================================
// 5. 「0 个」必须可解释
// ============================================================================
function checkSkipReasonPersisted() {
  const code = readScanner();
  if (code === null) return;
  if (!code.includes("cleanupSkippedReason")) {
    reportViolation(
      SCANNER,
      "缺少 cleanupSkippedReason：removedCount=0 时无法区分「没有孤儿」与「没跑清理」。",
    );
  }
}

export function runStrmOrphanGate() {
  violations = 0;
  console.log(`${c.cyan}${c.bold}▶ 正在执行「远端删了本地要跟着删」门禁...${c.reset}`);

  checkCleanupNotModeGated();
  checkTraversalReportsFailure();
  checkEmptyProtectCoversAllModes();
  checkRemovedPathsNotified();
  checkSkipReasonPersisted();

  if (violations > 0) {
    console.error(`\n${c.red}${c.bold}✖ 门禁未通过，发现 ${violations} 处孤儿清理风险！${c.reset}\n`);
    return false;
  }
  console.log(
    `${c.green}${c.bold}✔ 门禁通过（清理解除模式门禁、遍历失败显式表达、空盘保护全覆盖、删除已接通知、0 可解释）${c.reset}\n`,
  );
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runStrmOrphanGate() ? 0 : 1);
}

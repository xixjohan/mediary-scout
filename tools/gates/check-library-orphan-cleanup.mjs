#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 「影视库已删除影片清理与生命周期同步」架构门禁 (Library Orphan Cleanup Gate)
 *
 * 缺陷原型（2026-11-20 架构排查）：
 * 影视库全流程只有 upsert，没有任何差集比对和删除逻辑。网盘删除或重命名视频后，
 * SQLite 数据库中永久滞留失效分集与空剧卡片，海报墙点击播放报 404，重命名出现多版本重复。
 *
 * 本门禁静态堵住六条核心安全规则：
 * 1. 扫描器必须集成差集比对引擎 (reconcileBindingEpisodes)；
 * 2. 根目录遍历失败不得伪装成空文件（必须抛错并终止，禁止清空全库）；
 * 3. 遍历局部异常时必须保全退出（traversalErrors 熔断）；
 * 4. 零文件空盘保护必须强制阻断 (EMPTY_DISCOVERY_BLOCKED)；
 * 5. 删除比例超高水位线熔断 (HIGH_PRUNE_RATE_BLOCKED)；
 * 6. 分集物理清理后必须调用级联修剪 (purgeOrphanedLibraryItems) 扫除空壳季度与主条目。
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
  console.error(`${c.red}✖ [Library Orphan Gate Violation]${c.reset} ${path.relative(repoRoot, file)}`);
  console.error(`  ${c.yellow}原因:${c.reset} ${message}`);
  violations++;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const SCANNER = "packages/workflow/src/library/library-scanner.ts";
const REPO = "packages/workflow/src/persistence/sqlite/sqlite-media-library-reconcile.ts";

function readFileSafe(relPath) {
  const full = path.join(repoRoot, relPath);
  if (!fs.existsSync(full)) {
    reportViolation(full, `${relPath} 不存在！`);
    return null;
  }
  return stripComments(fs.readFileSync(full, "utf8"));
}

// 1. 扫描器必须调用比对引擎
function checkReconciliationConnected() {
  const code = readFileSafe(SCANNER);
  if (!code) return;

  if (!code.includes("reconcileBindingEpisodes")) {
    reportViolation(SCANNER, "MediaLibraryScanner 缺少 reconcileBindingEpisodes 调用：未接入孤儿清理引擎。");
  }

  if (!code.includes("DIFFING")) {
    reportViolation(SCANNER, "MediaLibraryScanner 缺少 DIFFING 进度阶段：进度未向用户透传差异比对。");
  }
}

// 2. 根目录遍历失败不得伪装成空
function checkRootFailureThrows() {
  const code = readFileSafe(SCANNER);
  if (!code) return;

  if (!code.includes("STORAGE_ROOT_LIST_FAILED")) {
    reportViolation(
      SCANNER,
      "根目录读取失败未抛出 STORAGE_ROOT_LIST_FAILED：若根目录无法访问直接跳过，将导致空盘误判并清空整库！",
    );
  }

  if (!code.includes("traversalErrors")) {
    reportViolation(
      SCANNER,
      "缺少 traversalErrors 计数器：局部子目录读取失败未被记录，可能导致跳过目录下的文件被误当做孤儿误删。",
    );
  }
}

// 3. 空盘防清空熔断
function checkEmptyProtect() {
  const code = readFileSafe(REPO);
  if (!code) return;

  if (!code.includes("EMPTY_DISCOVERY_BLOCKED")) {
    reportViolation(REPO, "缺少 EMPTY_DISCOVERY_BLOCKED：当远端发现 0 个文件时未触发空盘保护熔断！");
  }

  if (!code.includes("HIGH_PRUNE_RATE_BLOCKED")) {
    reportViolation(REPO, "缺少 HIGH_PRUNE_RATE_BLOCKED：大比例删除未触发高水位保护熔断！");
  }
}

// 4. 级联清理空季与空剧
function checkCascadingPurge() {
  const code = readFileSafe(REPO);
  if (!code) return;

  if (!code.includes("purgeOrphanedLibraryItems")) {
    reportViolation(REPO, "缺少 purgeOrphanedLibraryItems 级联清理方法：分集删除后空壳季度与影片海报无法自动消除。");
  }
}

// 5. 0 个必须可解释
function checkCleanupReason() {
  const code = readFileSafe(SCANNER);
  if (!code) return;

  if (!code.includes("cleanupSkippedReason")) {
    reportViolation(SCANNER, "缺少 cleanupSkippedReason：未清理孤儿时无法向用户与审计说明原因。");
  }
}

export function runLibraryOrphanGate() {
  violations = 0;
  console.log(`${c.cyan}${c.bold}▶ 正在执行「影视库已删除影片清理与生命周期同步」门禁...${c.reset}`);

  checkReconciliationConnected();
  checkRootFailureThrows();
  checkEmptyProtect();
  checkCascadingPurge();
  checkCleanupReason();

  if (violations > 0) {
    console.error(`\n${c.red}${c.bold}✖ 门禁未通过，发现 ${violations} 处影视库孤儿清理安全隐患！${c.reset}\n`);
    return false;
  }
  console.log(
    `${c.green}${c.bold}✔ 门禁通过（比对引擎接线、根异常严密防御、空盘/高水位双熔断、级联幽灵修剪、0 可解释）${c.reset}\n`,
  );
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runLibraryOrphanGate() ? 0 : 1);
}

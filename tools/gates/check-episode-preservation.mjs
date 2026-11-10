#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 剧集状态防抹除与持久化质量门禁 (Episode State Preservation Gate)
 *
 * 核心检查项：
 *  1. 【仓储层纵深保护 (Repository Fail-Safe)】：确保 SqliteWorkflowRepository 与 InMemoryWorkflowRepository
 *     导入并严格使用 isEpisodePreservingWorkflowKind 保护剧集状态不被辅助记录工作流抹除。
 *  2. 【搜索快照保留保护 (Resource Search Run)】：确保 buildResourceSearchRun 与所有 POST /api/titles/resources
 *     调用方均携带 keepCurrentEpisodes: true。
 *  3. 【整理工作流保留保护 (Organize Run)】：确保 buildOrganizeRun 与所有 POST /api/titles/organize
 *     调用方均携带 keepCurrentEpisodes: true。
 *  4. 【手动入库预约保留保护 (Manual Import Reservation)】：确保 buildManualImportReservation
 *     携带 keepCurrentEpisodes: true。
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

function reportViolation(file, line, message) {
  console.error(`${c.red}✖ [Episode Preservation Gate Violation]${c.reset} ${path.relative(repoRoot, file)}:${line}`);
  console.error(`  ${c.yellow}原因:${c.reset} ${message}`);
  violations++;
}

// 1. 检查领域符号导出
function checkDomainExport() {
  const domainPath = path.join(repoRoot, "packages/workflow/src/domain/domain.ts");
  if (!fs.existsSync(domainPath)) return;
  const content = fs.readFileSync(domainPath, "utf8");
  if (!content.includes("isEpisodePreservingWorkflowKind")) {
    reportViolation(domainPath, 1, "domain.ts 缺少核心防御函数 isEpisodePreservingWorkflowKind 导出！");
  }
}

// 2. 检查仓储层纵深防御绑定
function checkRepositoryGuard() {
  const sqliteRepoPath = path.join(repoRoot, "packages/workflow/src/persistence/sqlite.ts");
  if (fs.existsSync(sqliteRepoPath)) {
    const content = fs.readFileSync(sqliteRepoPath, "utf8");
    if (!content.includes("isEpisodePreservingWorkflowKind")) {
      reportViolation(
        sqliteRepoPath,
        1,
        "SqliteWorkflowRepository 未接入 isEpisodePreservingWorkflowKind，非采集工作流可能误抹除 episode_states！"
      );
    }
  }

  const inMemRepoPath = path.join(repoRoot, "packages/workflow/src/persistence/repository.ts");
  if (fs.existsSync(inMemRepoPath)) {
    const content = fs.readFileSync(inMemRepoPath, "utf8");
    if (!content.includes("isEpisodePreservingWorkflowKind")) {
      reportViolation(
        inMemRepoPath,
        1,
        "InMemoryWorkflowRepository 未接入 isEpisodePreservingWorkflowKind，双模实现未对齐！"
      );
    }
  }
}

// 3. 检查快照与预约生成器
function checkRunBuilders() {
  const searchRunPath = path.join(repoRoot, "packages/workflow/src/providers/resource-search-run.ts");
  if (fs.existsSync(searchRunPath)) {
    const content = fs.readFileSync(searchRunPath, "utf8");
    if (!content.includes("keepCurrentEpisodes: true")) {
      reportViolation(
        searchRunPath,
        1,
        "buildResourceSearchRun 缺少 keepCurrentEpisodes: true 标记！"
      );
    }
  }

  const organizeRunPath = path.join(repoRoot, "packages/workflow/src/execution/organize-run.ts");
  if (fs.existsSync(organizeRunPath)) {
    const content = fs.readFileSync(organizeRunPath, "utf8");
    if (!content.includes("keepCurrentEpisodes: true")) {
      reportViolation(
        organizeRunPath,
        1,
        "buildOrganizeRun 缺少 keepCurrentEpisodes: true 标记！"
      );
    }
  }

  const manualImportPath = path.join(repoRoot, "packages/workflow/src/execution/manual-import-command.ts");
  if (fs.existsSync(manualImportPath)) {
    const content = fs.readFileSync(manualImportPath, "utf8");
    if (!content.includes("keepCurrentEpisodes: true")) {
      reportViolation(
        manualImportPath,
        1,
        "buildManualImportReservation 缺少 keepCurrentEpisodes: true 标记！"
      );
    }
  }
}

// 4. 检查路由消费端显式声明
function checkRouteCallers() {
  const resourceRoutePath = path.join(repoRoot, "apps/web/app/api/titles/resources/route.ts");
  if (fs.existsSync(resourceRoutePath)) {
    const content = fs.readFileSync(resourceRoutePath, "utf8");
    if (!content.includes("keepCurrentEpisodes: true")) {
      reportViolation(
        resourceRoutePath,
        1,
        "POST /api/titles/resources 在调用 saveWorkflowRunSnapshot 时缺少 keepCurrentEpisodes: true！"
      );
    }
  }

  const organizeRoutePath = path.join(repoRoot, "apps/web/app/api/titles/organize/route.ts");
  const organizeHandlersPath = path.join(repoRoot, "apps/web/app/api/titles/organize/organize-handlers.ts");
  if (fs.existsSync(organizeRoutePath)) {
    const content = fs.readFileSync(organizeRoutePath, "utf8");
    const handlersContent = fs.existsSync(organizeHandlersPath)
      ? fs.readFileSync(organizeHandlersPath, "utf8")
      : "";
    if (!content.includes("keepCurrentEpisodes: true") && !handlersContent.includes("keepCurrentEpisodes: true")) {
      reportViolation(
        organizeRoutePath,
        1,
        "POST /api/titles/organize 在调用 saveWorkflowRunSnapshot 时缺少 keepCurrentEpisodes: true！"
      );
    }
  }
}

console.log(`${c.cyan}正在执行【剧集状态防抹除与持久化质量门禁】(check-episode-preservation)...${c.reset}`);

checkDomainExport();
checkRepositoryGuard();
checkRunBuilders();
checkRouteCallers();

if (violations > 0) {
  console.error(`\n${c.red}${c.bold}✖ [Episode Preservation Gate] 质检失败：发现 ${violations} 处高危剧集抹除风险代码，必须立刻修复！${c.reset}\n`);
  process.exit(1);
} else {
  console.log(`${c.green}✔ [Episode Preservation Gate] 门禁质检通过（全链路剧集状态保护就绪、双模仓储对齐、路由显式标记就绪）${c.reset}`);
}

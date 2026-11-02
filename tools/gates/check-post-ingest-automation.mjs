#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 自动化入库到 STRM 生成与影视库刷新质量门禁
 * (Post-Ingest Automation & MediaServer Auto-Refresh Gate)
 *
 * 核心检查项：
 *  1. 【入库全工作流闭环门禁 (All Ingest Workflows Closed Loop)】：
 *     确保所有入库落地执行器（runQueuedType2Workflow, runQueuedSeriesInitialization,
 *     runQueuedManualImport, runQueuedReplaceRequest）均接入 triggerPostIngestSyncIfSucceeded，
 *     严禁任何入库分支成为“孤岛”导致 STRM 生成或影视库刷新脱节。
 *  2. 【影视库协调器注入门禁 (MediaServer Coordinator Injection)】：
 *     确保 worker-runner-service.ts 在 buildAccountContextResolver 中必须将
 *     getMediaServerCoordinator() 注入 executionContext，严禁 Coordinator 为空导致静默跳过刷新。
 *  3. 【媒体库规范目录命名门禁 (Canonical Folder Naming Guard)】：
 *     确保 pinpoint-ingest-sync.ts 中使用 mediaLibraryFolderName 生成影视规范路径（{tmdb-id}），
 *     杜绝平铺裸文件导致全量扫描时被误判为孤儿文件清理。
 *  4. 【STRM 周期调度器接入门禁 (Periodic STRM Task Scheduling)】：
 *     确保 background-worker.ts 的队列抽干循环中集成 runDueStrmTasks 调度，
 *     保障 scanIntervalMinutes 周期策略真实常驻生效。
 *  5. 【异常故障隔离门禁 (Fault Isolation Guard)】：
 *     确保 triggerPostIngestSync 始终具备顶层 try/catch 隔离机制，
 *     外部 Emby/Jellyfin/Plex 超时或 STRM 异常绝不影响主入库工作流状态。
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
  console.error(`${c.red}✖ [Post-Ingest Automation Gate Violation]${c.reset} ${path.relative(repoRoot, file)}:${line}`);
  console.error(`  ${c.yellow}原因:${c.reset} ${message}`);
  violations++;
}

// 1. 检查入库全工作流闭环
function checkAllIngestWorkflowsWired() {
  const targets = [
    {
      filePath: path.join(repoRoot, "packages/workflow/src/execution/worker.ts"),
      expectedCalls: ["triggerPostIngestSyncIfSucceeded"],
      description: "worker.ts (runQueuedType2Workflow / runQueuedSeriesInitialization)",
    },
    {
      filePath: path.join(repoRoot, "packages/workflow/src/execution/manual-import-worker.ts"),
      expectedCalls: ["triggerPostIngestSyncIfSucceeded"],
      description: "manual-import-worker.ts (runQueuedManualImport)",
    },
    {
      filePath: path.join(repoRoot, "packages/workflow/src/execution/replace-request.ts"),
      expectedCalls: ["triggerPostIngestSyncIfSucceeded"],
      description: "replace-request.ts (runQueuedReplaceRequest)",
    },
  ];

  for (const target of targets) {
    if (!fs.existsSync(target.filePath)) {
      reportViolation(target.filePath, 1, `文件不存在: ${target.description}`);
      continue;
    }
    const content = fs.readFileSync(target.filePath, "utf8");
    for (const expected of target.expectedCalls) {
      if (!content.includes(expected)) {
        reportViolation(
          target.filePath,
          1,
          `${target.description} 漏接自动化触发器: 必须调用 ${expected}()`,
        );
      }
    }
  }
}

// 2. 检查 Coordinator 注入
function checkCoordinatorInjection() {
  const runnerPath = path.join(
    repoRoot,
    "apps/web/features/acquisition/application/worker-runner-service.ts",
  );
  if (!fs.existsSync(runnerPath)) {
    reportViolation(runnerPath, 1, "worker-runner-service.ts 不存在！");
    return;
  }
  const content = fs.readFileSync(runnerPath, "utf8");
  if (!content.includes("mediaServerCoordinator: getMediaServerCoordinator()")) {
    reportViolation(
      runnerPath,
      1,
      "worker-runner-service.ts 必须向 resolveAccountContext 注入 mediaServerCoordinator: getMediaServerCoordinator()",
    );
  }
}

// 3. 检查规范目录命名
function checkCanonicalFolderNaming() {
  const syncPath = path.join(repoRoot, "packages/workflow/src/strm/pinpoint-ingest-sync.ts");
  if (!fs.existsSync(syncPath)) {
    reportViolation(syncPath, 1, "pinpoint-ingest-sync.ts 不存在！");
    return;
  }
  const content = fs.readFileSync(syncPath, "utf8");
  if (!content.includes("mediaLibraryFolderName(")) {
    reportViolation(
      syncPath,
      1,
      "pinpoint-ingest-sync.ts 必须使用 mediaLibraryFolderName 生成规范目录，防止平铺裸文件导致误清理",
    );
  }
}

// 4. 检查后台周期性调度
function checkPeriodicStrmScheduler() {
  const bgWorkerPath = path.join(repoRoot, "apps/web/lib/background-worker.ts");
  if (!fs.existsSync(bgWorkerPath)) {
    reportViolation(bgWorkerPath, 1, "background-worker.ts 不存在！");
    return;
  }
  const content = fs.readFileSync(bgWorkerPath, "utf8");
  if (!content.includes("runDueStrmTasks")) {
    reportViolation(
      bgWorkerPath,
      1,
      "background-worker.ts 必须在 drainQueueOnce 中调用 runDueStrmTasks() 维持 scanIntervalMinutes 周期执行",
    );
  }
}

// 5. 检查故障隔离
function checkFaultIsolation() {
  const syncPath = path.join(repoRoot, "packages/workflow/src/strm/pinpoint-ingest-sync.ts");
  if (!fs.existsSync(syncPath)) return;
  const content = fs.readFileSync(syncPath, "utf8");
  if (!content.includes("triggerPostIngestSync(input: PostIngestSyncTriggerInput): Promise<void>") &&
      !content.includes("async function triggerPostIngestSync")) {
    reportViolation(syncPath, 1, "缺少 triggerPostIngestSync 函数声明");
    return;
  }
  if (!content.includes("try {") || !content.includes("[triggerPostIngestSync] Failed to sync pinpoint ingested files")) {
    reportViolation(
      syncPath,
      1,
      "triggerPostIngestSync 必须具备顶层 try/catch 隔离机制，杜绝异常向外溢出",
    );
  }
}

// 6. 检查入库网盘高精度任务匹配
function checkStrmTaskMatching() {
  const syncPath = path.join(repoRoot, "packages/workflow/src/strm/pinpoint-ingest-sync.ts");
  if (!fs.existsSync(syncPath)) return;
  const content = fs.readFileSync(syncPath, "utf8");
  if (!content.includes("matchStrmTasksForIngest") || !content.includes("categoryParentId")) {
    reportViolation(
      syncPath,
      1,
      "pinpoint-ingest-sync.ts 必须实现 matchStrmTasksForIngest 并校验 categoryParentId / 影视类型，严禁全量粗暴触发",
    );
  }
}

// 7. 检查媒体服务器路径自适应推导
function checkMediaServerPathAutoMatch() {
  const coordPath = path.join(repoRoot, "packages/workflow/src/mediaserver/coordinator.ts");
  if (!fs.existsSync(coordPath)) return;
  const content = fs.readFileSync(coordPath, "utf8");
  if (!content.includes("autoResolveMediaServerTarget") || !content.includes("detectedLibraries")) {
    reportViolation(
      coordPath,
      1,
      "coordinator.ts 必须实现 autoResolveMediaServerTarget 并结合 detectedLibraries 自适应推导容器路径与 Section ID",
    );
  }
}

console.log(`${c.bold}${c.cyan}=== 启动 Post-Ingest Automation 自动化质量门禁检查 ===${c.reset}`);
checkAllIngestWorkflowsWired();
checkCoordinatorInjection();
checkCanonicalFolderNaming();
checkPeriodicStrmScheduler();
checkFaultIsolation();
checkStrmTaskMatching();
checkMediaServerPathAutoMatch();

if (violations > 0) {
  console.error(`\n${c.red}${c.bold}❌ Post-Ingest Automation 质量门禁失败，发现 ${violations} 处违规！${c.reset}\n`);
  process.exit(1);
} else {
  console.log(`\n${c.green}${c.bold}✔ Post-Ingest Automation 质量门禁全项通过！全自动闭环架构合规。${c.reset}\n`);
  process.exit(0);
}

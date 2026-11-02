#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout STRM 递归扫描与层级保持质量门禁 (STRM Generation Gate)
 *
 * 核心检查项：
 *  1. 【远端递归扫描门禁 (Recursive Traversal Guard)】：
 *     确保 StrmScanner.ts 中针对 DriveFileManager 具备递归遍历（walk / depth / maxDepth）能力，
 *     严禁单次 listDirectory 后直接无条件丢弃 isFolder 子目录导致深层影视扫描为空。
 *  2. 【媒体库层级镜像门禁 (Hierarchical Output Guard)】：
 *     确保 StrmScanner.ts 保留 relativePath，并在 syncSingleFile 中使用 safeDirSegments 构造层级目录，
 *     严禁将所有视频扁平化输出到本地根目录破坏媒体库剧集/季组织结构。
 *  3. 【任务活动/暂停状态与传输模式持久化门禁 (Status & DeliveryMode Persistence Guard)】：
 *     确保 sqlite-strm.ts 在读取任务时显式映射 isActive 且与 status === "paused" 严格对齐；
 *     确保 sqlite-schema.ts 与 sqlite-strm.ts 对 delivery_mode 列进行完整 Schema 定义、CRUD 写入与动态升级；
 *     严禁直接硬编码 deliveryMode 绕过数据库持久化。
 *  4. 【双模播放中继器门禁 (Playback Proxy & Redirect Guard)】：
 *     确保 /api/strm/play 具备 302 重定向与 HTTP 206 Partial Content / Range 流式代理双模中继能力。
 *  5. 【孤儿文件与父目录清理门禁 (Orphan Cleanup Guard)】：
 *     确保 full_sync 模式下的孤儿清理调用 removeStrmFile，具备删除残留空目录的能力。
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
  console.error(`${c.red}✖ [STRM Generation Gate Violation]${c.reset} ${path.relative(repoRoot, file)}:${line}`);
  console.error(`  ${c.yellow}原因:${c.reset} ${message}`);
  violations++;
}

// 1. 检查 StrmScanner 的递归遍历能力与 relativePath 支持
function checkScannerRecursion() {
  const scannerPath = path.join(repoRoot, "packages/workflow/src/strm/strm-scanner.ts");
  if (!fs.existsSync(scannerPath)) {
    reportViolation(scannerPath, 1, "strm-scanner.ts 不存在！");
    return;
  }

  const content = fs.readFileSync(scannerPath, "utf8");

  // 必须递归调用 walk 处理 it.isFolder
  if (!content.includes("walk(it.id") && !content.includes("walk(")) {
    reportViolation(scannerPath, 1, "fetchRemoteFiles 缺少对 DriveFileManager 的递归 walk 逻辑，子目录视频将被漏检！");
  }

  // 必须支持 relativePath
  if (!content.includes("relativePath:")) {
    reportViolation(scannerPath, 1, "fetchRemoteFiles 未记录文件的 relativePath，无法构建媒体库多级目录！");
  }

  // 必须导入并使用 safeDirSegments
  if (!content.includes("safeDirSegments")) {
    reportViolation(scannerPath, 1, "strm-scanner.ts 未使用 safeDirSegments，无法安全化相对目录结构！");
  }

  // syncSingleFile 必须基于 safeSegments 创建相对目录
  if (!content.includes("...safeSegments")) {
    reportViolation(scannerPath, 1, "syncSingleFile 未使用 safeSegments 保持层级目录，会导致文件全部扁平化堆积在根目录！");
  }

  // syncSingleFile 必须向 buildPlayUrl 传入 task.id 作为一级路由路径（由任务字典中心决定交付模式，严禁向 URL 拼接 mode 参数）
  if (!content.includes("buildPlayUrl(baseUrl, task.id")) {
    reportViolation(scannerPath, 1, "syncSingleFile 未向 buildPlayUrl 传入 task.id 作为第一级路由路径，无法实现以任务字典配置为准！");
  }

  // 孤儿清理必须使用 removeStrmFile
  if (!content.includes("removeStrmFile")) {
    reportViolation(scannerPath, 1, "cleanOrphanFiles 未使用 removeStrmFile，远端整部删剧后本地残留多层空目录！");
  }
}

// 2. 检查 SQLite 仓储层对 deliveryMode、isActive 与 status 的持久化闭环
function checkSqliteStrmMapping() {
  const schemaPath = path.join(repoRoot, "packages/workflow/src/persistence/sqlite/sqlite-schema.ts");
  if (fs.existsSync(schemaPath)) {
    const schemaContent = fs.readFileSync(schemaPath, "utf8");
    if (!schemaContent.includes("delivery_mode text DEFAULT 'redirect'")) {
      reportViolation(schemaPath, 1, "sqlite-schema.ts 中 strm_tasks 建表语句缺少 delivery_mode 列定义！");
    }
    if (!schemaContent.includes("upgradeStrmTasksShape")) {
      reportViolation(schemaPath, 1, "sqlite-schema.ts 缺少 upgradeStrmTasksShape 动态列迁移补丁函数！");
    }
  }

  const sqlitePath = path.join(repoRoot, "packages/workflow/src/persistence/sqlite.ts");
  if (fs.existsSync(sqlitePath)) {
    const sqliteContent = fs.readFileSync(sqlitePath, "utf8");
    if (!sqliteContent.includes("upgradeStrmTasksShape")) {
      reportViolation(sqlitePath, 1, "sqlite.ts 实例化阶段未调用 upgradeStrmTasksShape()，旧数据库将缺失 delivery_mode 列！");
    }
  }

  const sqliteStrmPath = path.join(repoRoot, "packages/workflow/src/persistence/sqlite/sqlite-strm.ts");
  if (!fs.existsSync(sqliteStrmPath)) {
    reportViolation(sqliteStrmPath, 1, "sqlite-strm.ts 不存在！");
    return;
  }

  const content = fs.readFileSync(sqliteStrmPath, "utf8");

  if (!content.includes('isActive: status !== "paused"') && !content.includes("row.status !== \"paused\"")) {
    reportViolation(
      sqliteStrmPath,
      1,
      "strmTaskFromRow 未将 isActive 映射为 row.status !== 'paused'，导致前端读取 isActive 始终为 undefined！"
    );
  }

  // 必须从 row.delivery_mode 动态读取，严禁直接硬编码 deliveryMode: "redirect" 丢弃数据库值
  if (!content.includes("row.delivery_mode") || !content.includes('"redirect"')) {
    reportViolation(sqliteStrmPath, 1, "strmTaskFromRow 缺少 row.delivery_mode 映射与 'redirect' 兜底对齐！");
  }

  // INSERT INTO strm_tasks 必须包含 delivery_mode
  if (!content.includes("delivery_mode,") && !content.includes("delivery_mode)")) {
    reportViolation(sqliteStrmPath, 1, "createStrmTask 的 INSERT 语句缺少 delivery_mode 列，新增任务将丢失串流访问方式！");
  }

  // UPDATE strm_tasks 必须包含 delivery_mode
  if (!content.includes("delivery_mode = ?")) {
    reportViolation(sqliteStrmPath, 1, "updateStrmTask 的 UPDATE 语句缺少 delivery_mode = ?，修改串流访问方式将无法落盘！");
  }
}

// 3. 检查播放中继路由的双模支持（302 重定向 + HTTP 206 流式代理）
function checkStrmPlaybackRouting() {
  const routePath = path.join(repoRoot, "apps/web/app/api/strm/play/[taskId]/[fileId]/route.ts");
  if (!fs.existsSync(routePath)) {
    reportViolation(routePath, 1, "STRM 播放路由 [taskId]/[fileId]/route.ts 不存在！");
    return;
  }

  const content = fs.readFileSync(routePath, "utf8");

  // 必须同时支持 proxy 与 redirect
  if (!content.includes("handleStreamProxy") || !content.includes("handleRedirect")) {
    reportViolation(routePath, 1, "STRM 播放路由未实现 handleStreamProxy 或 handleRedirect 双模中继器！");
  }

  // 代理流必须支持 Range 请求头透传与 Accept-Ranges
  if (!content.includes("Range") || !content.includes("Accept-Ranges")) {
    reportViolation(routePath, 1, "handleStreamProxy 缺少对 Range 头部的解析与 Accept-Ranges 的上报，播放器将无法分片定位！");
  }

  // 必须支持 HEAD 请求（播放器探查时长与大小关键协议）
  if (!content.includes("export async function HEAD")) {
    reportViolation(routePath, 1, "STRM 播放路由缺少 HEAD 请求导出，Infuse/Plex 探测将报错！");
  }
}

// 4. 检查 STRM 文件写入器对 deliveryMode 的 URL 参数透传
function checkStrmWriterDeliveryMode() {
  const writerPath = path.join(repoRoot, "packages/workflow/src/strm/strm-writer.ts");
  if (!fs.existsSync(writerPath)) {
    reportViolation(writerPath, 1, "strm-writer.ts 不存在！");
    return;
  }

  const content = fs.readFileSync(writerPath, "utf8");

  if (!content.includes("mode=proxy")) {
    reportViolation(writerPath, 1, "buildPlayPath 未在 deliveryMode === 'proxy' 时追加 mode=proxy 参数！");
  }
}

// 5. 检查前端 UI 卡片的状态防误判逻辑
function checkUiStatusParity() {
  const cardPath = path.join(repoRoot, "apps/web/features/strm/components/strm-task-card.tsx");
  if (!fs.existsSync(cardPath)) {
    reportViolation(cardPath, 1, "strm-task-card.tsx 不存在！");
    return;
  }

  const content = fs.readFileSync(cardPath, "utf8");

  // 严禁使用 !task.isActive || task.status === "paused"
  if (content.includes("!task.isActive || task.status === \"paused\"")) {
    reportViolation(
      cardPath,
      1,
      "strm-task-card.tsx 存在未判空布尔短路 (!task.isActive || task.status === 'paused')，当 isActive 为 undefined 时将常驻误报「已暂停」！"
    );
  }

  // 必须使用 task.status === "paused" || task.isActive === false
  if (!content.includes("task.status === \"paused\" || task.isActive === false")) {
    reportViolation(
      cardPath,
      1,
      "strm-task-card.tsx 必须使用 `task.status === 'paused' || task.isActive === false` 作为 isPaused 判定标准！"
    );
  }
}

// 6. 检查 VerifiedFile 接口定义
function checkDomainVerifiedFile() {
  const domainPath = path.join(repoRoot, "packages/workflow/src/domain/domain.ts");
  if (!fs.existsSync(domainPath)) return;

  const content = fs.readFileSync(domainPath, "utf8");
  if (!content.includes("relativePath?: string")) {
    reportViolation(domainPath, 1, "domain.ts 的 VerifiedFile 接口必须包含 relativePath 可选字段！");
  }
}

// 7. 检查极速批量修改播放基址自动支持全部任务路径
function checkReplaceBaseUrlAutoPaths() {
  const replacerPath = path.join(repoRoot, "packages/workflow/src/strm/base-url-replacer.ts");
  if (fs.existsSync(replacerPath)) {
    const content = fs.readFileSync(replacerPath, "utf8");
    if (!content.includes("replaceBaseUrlInDirectories")) {
      reportViolation(replacerPath, 1, "base-url-replacer.ts 必须导出 replaceBaseUrlInDirectories 多目录聚合函数！");
    }
  }

  const routePath = path.join(repoRoot, "apps/web/app/api/strm/replace-base-url/route.ts");
  if (fs.existsSync(routePath)) {
    const content = fs.readFileSync(routePath, "utf8");
    if (!content.includes("listStrmTasks") || !content.includes("localOutputDir")) {
      reportViolation(routePath, 1, "replace-base-url 路由必须支持在未指定路径时自动提取 listStrmTasks 的 localOutputDir！");
    }
    if (content.includes("!body.directoryPath")) {
      reportViolation(routePath, 1, "replace-base-url 路由不得将 directoryPath 作为强制必填校验项！");
    }
  }

  const modalPath = path.join(repoRoot, "apps/web/features/strm/components/strm-schedule-view.tsx");
  if (fs.existsSync(modalPath)) {
    const content = fs.readFileSync(modalPath, "utf8");
    if (!content.includes("taskDirs") || !content.includes("StrmReplaceBaseUrlModal")) {
      reportViolation(modalPath, 1, "strm-schedule-view.tsx 模态框未实现自动关联全部任务目录！");
    }
  }
}

export function runStrmGenerationGate() {
  console.log(`正在执行【STRM 递归扫描与层级保持质量门禁】(check-strm-generation)...`);

  checkDomainVerifiedFile();
  checkScannerRecursion();
  checkSqliteStrmMapping();
  checkStrmPlaybackRouting();
  checkStrmWriterDeliveryMode();
  checkUiStatusParity();
  checkReplaceBaseUrlAutoPaths();

  if (violations > 0) {
    console.error(`\n${c.red}${c.bold}✖ [STRM Gate Failed] 发现 ${violations} 处架构违规，请根据上述提示修复！${c.reset}\n`);
    process.exit(1);
  } else {
    console.log(
      `${c.green}✔ [STRM Generation Gate] 门禁质检通过（全层级递归扫描、多级目录镜像、传输模式全链路持久化、双模代理中继、基址自动汇聚、状态防误判就绪）${c.reset}`
    );
  }
}

// 当通过 node CLI 直接运行该脚本时执行
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runStrmGenerationGate();
}

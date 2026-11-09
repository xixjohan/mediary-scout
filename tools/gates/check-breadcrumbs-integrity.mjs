#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 网盘深层路径与多级面包屑完整性质量门禁
 * (Drive Deep Path & Breadcrumbs Integrity Gate)
 *
 * 核心检查项：
 *  1. 【后端祖先链路构建保障 (DriveDirectoryCache & Hierarchy)】：
 *     确保 drive-directory-cache.ts 存在并实现 DriveDirectoryCache、buildBreadcrumbs 与 buildListing；
 *     严禁在 drive-file-manager.ts 或 drive-directory-cache.ts 中写死两级面包屑数组；
 *     严禁使用类似 `目录 (${dirId.slice(0, 8)}…)` 的哈希截断占位符。
 *  2. 【115 原生路径透传保障 (Pan115 Native Breadcrumbs Guard)】：
 *     确保 pan115-cookie-client.ts 实现 listItemsWithBreadcrumbs 并提取 response.path。
 *  3. 【前端双向状态机保障 (Client Breadcrumb State Stack Guard)】：
 *     确保 storage-manager-view.tsx 维护 breadcrumbs 状态栈，在切换/深入/跳转时正确流转；
 *     确保 storage-nav-bar.tsx 接收 breadcrumbs 属性并完整渲染各级路径；
 *     确保 storage-file-table.tsx onNavigateFolder 传递名称以便立即上报路径节点。
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
  console.error(`${c.red}✖ [Breadcrumbs Gate Violation]${c.reset} ${path.relative(repoRoot, file)}:${line}`);
  console.error(`  ${c.yellow}原因:${c.reset} ${message}`);
  violations++;
}

console.log(`${c.bold}${c.cyan}=== 巡影 网盘深层路径与面包屑完整性门禁检查 ===${c.reset}`);

// 1. 检查后端 DriveDirectoryCache 与 drive-directory-cache.ts
const cachePath = path.join(repoRoot, "packages/workflow/src/storage/drive-directory-cache.ts");
if (!fs.existsSync(cachePath)) {
  reportViolation(cachePath, 1, "缺少 packages/workflow/src/storage/drive-directory-cache.ts 模块");
} else {
  const content = fs.readFileSync(cachePath, "utf8");
  if (!content.includes("class DriveDirectoryCache")) {
    reportViolation(cachePath, 1, "缺少 DriveDirectoryCache 类实现");
  }
  if (!content.includes("buildBreadcrumbs")) {
    reportViolation(cachePath, 1, "DriveDirectoryCache 未实现 buildBreadcrumbs 递归向上构建祖先链");
  }
  if (content.includes("slice(0, 8)") || content.includes("${dirId.slice(0, 8)}")) {
    reportViolation(cachePath, 1, "严禁使用截断哈希作为目录名称占位符 (如 slice(0, 8))");
  }
}

// 2. 检查 115 原生路径提取能力
const pan115ClientPath = path.join(repoRoot, "packages/workflow/src/storage/pan115-cookie-client.ts");
if (fs.existsSync(pan115ClientPath)) {
  const pan115Content = fs.readFileSync(pan115ClientPath, "utf8");
  if (!pan115Content.includes("listItemsWithBreadcrumbs")) {
    reportViolation(pan115ClientPath, 1, "Pan115CookieClient 未实现 listItemsWithBreadcrumbs 方法");
  }
  if (!pan115Content.includes('recordValue(response, "path")') && !pan115Content.includes("breadcrumbFromFilesResponse")) {
    reportViolation(pan115ClientPath, 1, "Pan115 未从官方响应中提取 path 祖先路径数组");
  }
}

// 3. 检查前端组件的状态与属性
const navBarPath = path.join(repoRoot, "apps/web/features/storage-drives/components/storage/storage-nav-bar.tsx");
if (fs.existsSync(navBarPath)) {
  const navBarContent = fs.readFileSync(navBarPath, "utf8");
  if (!navBarContent.includes("breadcrumbs?: DriveBreadcrumb[]")) {
    reportViolation(navBarPath, 1, "StorageNavBar 未声明可选的 breadcrumbs 属性");
  }
}

const fileTablePath = path.join(repoRoot, "apps/web/features/storage-drives/components/storage/storage-file-table.tsx");
if (fs.existsSync(fileTablePath)) {
  const fileTableContent = fs.readFileSync(fileTablePath, "utf8");
  if (!fileTableContent.includes("onNavigateFolder: (id: string, name?: string) => void")) {
    reportViolation(fileTablePath, 1, "StorageFileTable 的 onNavigateFolder 必须支持传入 (id: string, name?: string)");
  }
  if (!fileTableContent.includes("onNavigateFolder(item.id, item.name)")) {
    reportViolation(fileTablePath, 1, "StorageFileTable 点击文件夹时必须将 (item.id, item.name) 一同回传");
  }
}

const managerViewPath = path.join(repoRoot, "apps/web/features/storage-drives/components/storage-manager-view.tsx");
if (fs.existsSync(managerViewPath)) {
  const managerViewContent = fs.readFileSync(managerViewPath, "utf8");
  if (!managerViewContent.includes("const [breadcrumbs, setBreadcrumbs] = useState<DriveBreadcrumb[]>")) {
    reportViolation(managerViewPath, 1, "StorageManagerView 未使用 useState 维护 breadcrumbs 路径状态栈");
  }
  if (!managerViewContent.includes("breadcrumbs={breadcrumbs}")) {
    reportViolation(managerViewPath, 1, "StorageManagerView 未将 breadcrumbs 状态注入 StorageNavBar");
  }
}

if (violations > 0) {
  console.error(`\n${c.red}${c.bold}✖ 网盘面包屑与深层路径门禁检查失败，发现 ${violations} 处违规。${c.reset}`);
  process.exit(1);
}

console.log(`${c.green}${c.bold}✔ 网盘深层路径与多级面包屑门禁检查全部通过！${c.reset}\n`);
process.exit(0);

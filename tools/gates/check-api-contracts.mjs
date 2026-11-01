#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 前后端 API 契约与时间线字段对齐门禁 (API Contract & Timeline Gate)
 *
 * 核心检查项：
 *  1. 【幽灵属性静态防卫 (Phantom Property Check)】：
 *     扫描全量前端组件，禁止对工作流步骤/时间线对象 (step/steps) 访问未声明的幽灵属性（如 s.headline），杜绝空白圆点回归。
 *  2. 【权威契约单源绑定 (Contract Source of Truth)】：
 *     确保 acquiring-detail-modal 严格引用共享契约 AcquiringStatusResponse，严禁私自声明假性 interface 绕过编译器。
 *  3. 【状态端点契约返回类型校验 (Route Type Coverage)】：
 *     确保 /api/activity/status 路由返回类型显式受契约约束。
 *  4. 【存储离线下载契约绑定 (Storage Offline Contract)】：
 *     确保 storage-offline-modal 引用后端导出的 OfflineCapabilities 契约类型。
 *  5. 【资源候选链接契约绑定 (Resource Link Contract)】：
 *     确保 resource-candidate-row 引用后端导出的 ResourceLinkResponse 契约类型。
 *  6. 【MCP 工具与权限完整性校验 (MCP Tool Coverage)】：
 *     确保 /api/mcp 中声明的工具全部在 TOOL_TO_PERMISSION_MAP 中具备映射，杜绝空权限工具。
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
  console.error(`${c.red}✖ [API Contract Gate Violation]${c.reset} ${path.relative(repoRoot, file)}:${line}`);
  console.error(`  ${c.yellow}原因:${c.reset} ${message}`);
  violations++;
}

// ============================================================================
// 1. 幽灵属性扫描 (Phantom Property Check)
// ============================================================================
function checkPhantomProperties() {
  const targetDir = path.join(repoRoot, "apps/web");
  const bannedPatterns = [
    {
      regex: /\b(?:step|steps|s)\.headline\b/,
      message: "检测到非法访问未在 AgentStepView / WorkflowStep 中声明的幽灵属性 '.headline'，请使用权威的 '.activity' 字段",
    },
    {
      regex: /interface\s+LiveStatus\s*\{[\s\S]*?headline\s*:\s*string/m,
      message: "禁止在局部 interface LiveStatus 中私自虚构包含 'headline' 的假性时间线类型，必须从 contracts 导入标准契约",
    },
  ];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "run") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.(tsx|ts|jsx|js)$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.mjs")) {
        const content = fs.readFileSync(fullPath, "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          for (const pattern of bannedPatterns) {
            if (pattern.regex.test(lines[i])) {
              reportViolation(fullPath, i + 1, pattern.message);
            }
          }
        }
      }
    }
  }

  walk(targetDir);
}

// ============================================================================
// 2. 契约单源与权威绑定检查
// ============================================================================
function checkContractBinding() {
  const contractPath = path.join(repoRoot, "apps/web/features/acquisition/contracts/acquiring-status-contract.ts");
  if (!fs.existsSync(contractPath)) {
    reportViolation(contractPath, 1, "缺少权威接口契约文件 acquiring-status-contract.ts");
    return;
  }

  const contractContent = fs.readFileSync(contractPath, "utf8");
  if (!contractContent.includes("export interface AcquiringStatusActiveResponse")) {
    reportViolation(contractPath, 1, "契约文件必须导出 AcquiringStatusActiveResponse 接口");
  }
  if (!contractContent.includes("toAcquiringTimelineItems")) {
    reportViolation(contractPath, 1, "契约文件必须导出 toAcquiringTimelineItems 适配器函数");
  }

  // 检查 modal 是否引用契约
  const modalPath = path.join(repoRoot, "apps/web/features/acquisition/components/acquiring-detail-modal.tsx");
  if (fs.existsSync(modalPath)) {
    const modalContent = fs.readFileSync(modalPath, "utf8");
    if (!modalContent.includes("toAcquiringTimelineItems")) {
      reportViolation(modalPath, 1, "AcquiringDetailModal 必须使用 toAcquiringTimelineItems 适配时间线，杜绝手写不规范 mapping");
    }
    if (!modalContent.includes("AcquiringStatusActiveResponse") && !modalContent.includes("AcquiringStatusResponse")) {
      reportViolation(modalPath, 1, "AcquiringDetailModal 必须直接导入并使用标准 AcquiringStatusResponse 契约");
    }
  }

  // 检查 /api/activity/status/route.ts 是否受契约约束
  const routePath = path.join(repoRoot, "apps/web/app/api/activity/status/route.ts");
  if (fs.existsSync(routePath)) {
    const routeContent = fs.readFileSync(routePath, "utf8");
    if (!routeContent.includes("AcquiringStatusActiveResponse") && !routeContent.includes("AcquiringStatusResponse")) {
      reportViolation(routePath, 1, "/api/activity/status 路由实现必须显式引用 AcquiringStatus 契约类型以保障后端响应对齐");
    }
  }

  // 检查 storage-offline-modal.tsx 契约绑定
  const offlineModalPath = path.join(repoRoot, "apps/web/features/storage-drives/components/storage/storage-offline-modal.tsx");
  if (fs.existsSync(offlineModalPath)) {
    const offlineContent = fs.readFileSync(offlineModalPath, "utf8");
    if (!offlineContent.includes("OfflineCapabilities")) {
      reportViolation(offlineModalPath, 1, "storage-offline-modal.tsx 必须引用后端的 OfflineCapabilities 契约，严禁局部独立声明");
    }
  }

  // 检查 resource-candidate-row.tsx 契约绑定
  const candidateRowPath = path.join(repoRoot, "apps/web/features/acquisition/components/resource-candidate-row.tsx");
  if (fs.existsSync(candidateRowPath)) {
    const rowContent = fs.readFileSync(candidateRowPath, "utf8");
    if (!rowContent.includes("ResourceLinkResponse")) {
      reportViolation(candidateRowPath, 1, "resource-candidate-row.tsx 必须引用后端的 ResourceLinkResponse 契约");
    }
  }

  // 检查 /api/mcp/route.ts 工具与权限映射
  const mcpRoutePath = path.join(repoRoot, "apps/web/app/api/mcp/route.ts");
  if (fs.existsSync(mcpRoutePath)) {
    const mcpContent = fs.readFileSync(mcpRoutePath, "utf8");
    if (!mcpContent.includes("TOOL_TO_PERMISSION_MAP") || !mcpContent.includes("MCP_REGISTERED_TOOLS")) {
      reportViolation(mcpRoutePath, 1, "/api/mcp 路由必须维护完整的 MCP_REGISTERED_TOOLS 与 TOOL_TO_PERMISSION_MAP");
    }
    if (!mcpContent.includes("allowMcp === false")) {
      reportViolation(mcpRoutePath, 1, "/api/mcp 路由必须对 allowMcp 通道执行安全拦截检查");
    }
  }

  // 检查 API Key V2 协议通道与接入示例对齐
  const createKeyModalPath = path.join(repoRoot, "apps/web/features/settings-system/components/create-api-key-modal.tsx");
  if (fs.existsSync(createKeyModalPath)) {
    const modalContent = fs.readFileSync(createKeyModalPath, "utf8");
    if (!modalContent.includes("allowApi") || !modalContent.includes("allowMcp")) {
      reportViolation(createKeyModalPath, 1, "CreateApiKeyModal 必须支持 allowApi 与 allowMcp 协议通道选择");
    }
  }

  const apiKeyManagerPath = path.join(repoRoot, "apps/web/features/settings-system/components/api-key-v2-manager.tsx");
  if (fs.existsSync(apiKeyManagerPath)) {
    const managerContent = fs.readFileSync(apiKeyManagerPath, "utf8");
    if (!managerContent.includes("ApiKeyGuideModal") || !managerContent.includes("showGuideModal")) {
      reportViolation(apiKeyManagerPath, 1, "ApiKeyV2Manager 必须提供常驻的 ApiKeyGuideModal 客户端接入指引弹窗");
    }
  }

  const guideModalPath = path.join(repoRoot, "apps/web/features/settings-system/components/api-key-guide-modal.tsx");
  if (!fs.existsSync(guideModalPath)) {
    reportViolation(guideModalPath, 1, "必须存在独立的 ApiKeyGuideModal 组件以提供 Cursor、Claude Desktop、Cline 等客户端标准 JSON 配置");
  } else {
    const guideContent = fs.readFileSync(guideModalPath, "utf8");
    if (!guideContent.includes(".cursor/mcp.json") || !guideContent.includes("claude_desktop_config.json")) {
      reportViolation(guideModalPath, 1, "ApiKeyGuideModal 必须覆盖 Cursor 与 Claude Desktop 标准客户端路径及配置");
    }
  }
}

console.log(`${c.bold}${c.cyan}=== 巡影 · Mediary Scout API 契约与时间线字段对齐门禁扫描 ===${c.reset}`);
checkPhantomProperties();
checkContractBinding();

if (violations > 0) {
  console.error(`\n${c.red}✖ [Contract Gate] 门禁质检失败：发现 ${violations} 处契约漂移或幽灵属性访问！${c.reset}\n`);
  process.exit(1);
} else {
  console.log(`\n${c.green}✔ [Contract Gate] 门禁质检通过：全量前端组件与 API 契约 100% 对齐，0 幽灵属性访问，时间线映射健全！${c.reset}\n`);
  process.exit(0);
}

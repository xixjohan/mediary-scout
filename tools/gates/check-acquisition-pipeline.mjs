#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 全链路获取与编排质量门禁 (Acquisition Pipeline Quality Gate)
 *
 * 核心检查项：
 *  1. 【反瀑布流静态防护 (Anti-Waterfall)】：扫描搜索与元数据提供商，严禁在循环体中串行 await 单体详情（防止搜索卡死超时回归）。
 *  2. 【搜索延迟与网络死信缓存 (DeadAccesses Memo)】：确保 search-page 注入共享 deadAccesses，防止国内网络在 direct 节点反复经历 1.5s 超时重试。
 *  3. 【核心获取服务符号完整性】：全量静态校验 acquisition-service.ts，确保 prepareTrackingTarget / parse*CandidateId 基础符号 100% 绑定。
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
  console.error(`${c.red}✖ [Acquisition Gate Violation]${c.reset} ${path.relative(repoRoot, file)}:${line}`);
  console.error(`  ${c.yellow}原因:${c.reset} ${message}`);
  violations++;
}

// ============================================================================
// 1. 反瀑布流网络检查 (Anti-Waterfall)
// ============================================================================
function checkAntiWaterfall() {
  const providerDir = path.join(repoRoot, "packages/workflow/src/providers");
  if (!fs.existsSync(providerDir)) return;

  const files = fs.readdirSync(providerDir).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const fullPath = path.join(providerDir, file);
    const content = fs.readFileSync(fullPath, "utf8");
    const lines = content.split("\n");

    let inLoop = false;
    let loopStartLine = 0;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\b(for|while)\s*\(/.test(line)) {
        inLoop = true;
        loopStartLine = i + 1;
        braceDepth = 0;
      }

      if (inLoop) {
        braceDepth += (line.match(/\{/g) || []).length;
        braceDepth -= (line.match(/\}/g) || []).length;

        if (/await\s+(this\.)?get(Tv|Movie)Details\s*\(/.test(line)) {
          reportViolation(
            fullPath,
            i + 1,
            `在第 ${loopStartLine} 行开始的循环体内检测到串行 await getDetails 单体详情拉取。必须在循环外使用 Promise.all 批量并发拉取，严防全链路搜索超时！`
          );
        }

        if (braceDepth <= 0 && (line.includes("}") || !line.includes("{"))) {
          inLoop = false;
        }
      }
    }
  }
}

// ============================================================================
// 2. 搜索死信记忆防护检查 (Dead-Access Memoization)
// ============================================================================
function checkDeadAccessMemo() {
  const searchPage = path.join(repoRoot, "apps/web/lib/search-page.ts");
  if (!fs.existsSync(searchPage)) return;

  const content = fs.readFileSync(searchPage, "utf8");
  if (!content.includes("deadAccesses")) {
    reportViolation(
      searchPage,
      1,
      "search-page.ts 未向 createTmdbSearchProvider 注入共享 deadAccesses 集合。国内直连超时（1.5s）无法在搜索间共享记忆，会导致后续请求重复超时卡顿！"
    );
  }
}

// ============================================================================
// 3. 核心获取服务 (acquisition-service.ts) 符号绑定防退化
// ============================================================================
function checkAcquisitionServiceBinding() {
  const acqService = path.join(repoRoot, "apps/web/features/acquisition/application/acquisition-service.ts");
  if (!fs.existsSync(acqService)) return;

  const content = fs.readFileSync(acqService, "utf8");
  const criticalSymbols = [
    "prepareTrackingTarget",
    "prepareMovieTarget",
    "prepareSeriesTarget",
    "parseTvCandidateId",
    "parseMovieCandidateId",
  ];

  for (const sym of criticalSymbols) {
    const importRegex = new RegExp(`\\bimport\\b[\\s\\S]*?\\b${sym}\\b[\\s\\S]*?\\bfrom\\b`);
    if (!importRegex.test(content)) {
      reportViolation(acqService, 1, `核心服务缺失基础符号静态绑定: ${sym}`);
    }
  }
}

console.log(`${c.bold}正在执行【全链路获取与编排质量门禁】(check-acquisition-pipeline)...${c.reset}`);
checkAntiWaterfall();
checkDeadAccessMemo();
checkAcquisitionServiceBinding();

if (violations > 0) {
  console.error(`\n${c.red}✖ 门禁质检失败：发现 ${violations} 处不符合全链路架构契约的违规项。${c.reset}\n`);
  process.exit(1);
} else {
  console.log(`${c.green}✔ [Acquisition Gate] 门禁质检通过（反瀑布流检测通过、死信节点记忆就绪、核心域符号 100% 绑定）${c.reset}`);
  process.exit(0);
}

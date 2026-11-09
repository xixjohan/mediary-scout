#!/usr/bin/env node
/**
 * STRM 播放基址安全与防覆写架构门禁（Guard Gate）：
 * 
 * 核心设计规则：
 * 1. 在 STRM 生成、扫描与入库调度链路中（apps/web/features/strm/application/ 与 apps/web/features/acquisition/application/），
 *    严禁在未经过 resolveEffectiveStrmBaseUrl(SSOT) 解析的情况下直接使用裸 `http://127.0.0.1` 作为静默 fallback。
 * 2. packages/workflow/src/strm/pinpoint-ingest-sync.ts 中精准入库同步必须使用 resolveEffectiveStrmBaseUrl，
 *    彻底防止离线 Worker 或定时任务将 .strm 文件反向覆写回 127.0.0.1。
 * 
 * 退出码 0 = 检查通过；1 = 发现违规项（打印违规文件与行号）。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const filesToCheck = [
  join(root, "apps", "web", "features", "strm", "application", "strm-runner-service.ts"),
  join(root, "apps", "web", "features", "acquisition", "application", "worker-runner-service.ts"),
  join(root, "packages", "workflow", "src", "strm", "pinpoint-ingest-sync.ts"),
];

const violations = [];

for (const filePath of filesToCheck) {
  if (!existsSync(filePath)) continue;
  const rel = relative(root, filePath).replace(/\\/g, "/");
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  // 必须引入并使用 resolveEffectiveStrmBaseUrl
  if (!content.includes("resolveEffectiveStrmBaseUrl")) {
    violations.push({
      file: rel,
      line: 1,
      rule: "MISSING_SSOT_RESOLVER",
      message: "该文件涉及 STRM 播放基址计算，但未导入或使用 resolveEffectiveStrmBaseUrl",
    });
  }

  // 严禁未经由 resolveEffectiveStrmBaseUrl 包装的裸回环字面量赋值给 baseUrl
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;

    if (
      /baseUrl\s*[:=].*127\.0\.0\.1/i.test(line) &&
      !line.includes("resolveEffectiveStrmBaseUrl")
    ) {
      violations.push({
        file: rel,
        line: i + 1,
        rule: "RAW_LOOPBACK_BASE_URL",
        message: `检测到裸回环地址直写: "${line.trim()}"，必须使用 resolveEffectiveStrmBaseUrl(repo) 解析`,
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`\n✖ [STRM Base URL Gate Violation] 检测到 ${violations.length} 处违规：`);
  for (const v of violations) {
    console.error(`  → ${v.file}:${v.line} [${v.rule}] ${v.message}`);
  }
  process.exit(1);
} else {
  console.log(`✔ [STRM Base URL Gate] STRM 播放基址 SSOT 解析合规检查通过 (已扫描 ${filesToCheck.length} 个核心文件)`);
  process.exit(0);
}

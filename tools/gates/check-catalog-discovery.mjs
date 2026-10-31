#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 影视资源库与全量发现质量门禁 (Catalog Discovery Quality Gate)
 *
 * 核心检查项：
 *  1. 【双路动漫全量召回 (Dual-Channel Anime Ingestion)】：确保 trending-service 在 type === 'anime' 时
 *     必须同时拉取 movie 与 tv 并通过 interleaveFeeds 进行双路汇聚（严防剧场版电影被物理剥离）。
 *  2. 【跨媒介动画题材注入 (Cross-Media Genre 16 Mapping)】：确保 resolveGenreQuery 在 type === 'anime' 时
 *     对 movie 和 tv 均注入 TMDB 题材 ID 16（严禁只针对 tv 注入）。
 *  3. 【反排他性单语种硬编码 (Anti-Exclusionary Single-Language Lock)】：确保动漫探索查询绝不写死单语种 ja，
 *     必须包含 ja|zh|ko，全面覆盖华语国漫（Donghua）与日漫韩漫。
 *  4. 【反静态流假死截断 (Anti-Static Chokehold Pagination)】：确保 shouldServeTrendingOnly 严禁拦截
 *     带有深度分页（page > 1 或 pageSize > 20）的动态发现流，防止全库被 31 条静态池锁死。
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
  console.error(`${c.red}✖ [Catalog Discovery Gate Violation]${c.reset} ${path.relative(repoRoot, file)}:${line}`);
  console.error(`  ${c.yellow}原因:${c.reset} ${message}`);
  violations++;
}

function checkTrendingService() {
  const file = path.join(repoRoot, "apps/web/features/catalog/application/trending-service.ts");
  if (!fs.existsSync(file)) {
    reportViolation(file, 1, "未找到 trending-service.ts 核心发现服务文件！");
    return;
  }

  const content = fs.readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);

  // 1. 检查动漫双路召回
  const hasAnimeDualChannel =
    content.includes('type === "documentary" || type === "anime"') ||
    (content.includes('type === "anime"') && content.includes('"movie"') && content.includes('"tv"') && content.includes("interleaveFeeds"));
  if (!hasAnimeDualChannel) {
    reportViolation(
      file,
      1,
      "fetchTypedFeedCards 中未发现针对 anime 的并发双路 (movie + tv) 拉取与 interleaveFeeds 混排，将导致所有动画剧场版电影不可见！"
    );
  }

  // 2. 检查跨媒介题材 ID 16 注入（严禁限定 && mediaType === 'tv'）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('params?.type === "anime"') && line.includes('mediaType === "tv"')) {
      reportViolation(
        file,
        i + 1,
        "resolveGenreQuery 或 buildDiscoverQuery 中检测到将 anime 限制为 mediaType === 'tv'，破坏了动画电影题材注入或语种支持！"
      );
    }
  }

  // 3. 检查反排他性单语种硬编码（严禁 query["with_original_language"] = "ja"）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('query["with_original_language"] = "ja"') || line.includes("with_original_language: 'ja'")) {
      reportViolation(
        file,
        i + 1,
        "检测到将 with_original_language 写死为 'ja'。必须使用包含国漫与日漫的 'ja|zh|ko' 多语种策略，严禁物理抹杀华语国漫！"
      );
    }
  }

  // 4. 检查 shouldServeTrendingOnly 分页放行
  if (content.includes("function shouldServeTrendingOnly")) {
    const hasPaginationBypass = content.includes("page > 1") || content.includes("pageSize > 20");
    if (!hasPaginationBypass) {
      reportViolation(
        file,
        1,
        "shouldServeTrendingOnly 未对 page > 1 或 pageSize > 20 进行放行，将导致深层分页被 31 条冷启动预热池假死截断！"
      );
    }
  }
}

console.log(`${c.bold}${c.cyan}=== 巡影 · Mediary Scout 影视资源库与全量发现门禁扫描 ===${c.reset}`);
checkTrendingService();

if (violations > 0) {
  console.error(`\n${c.red}${c.bold}门禁检查失败：发现 ${violations} 处架构违规，严禁缩水回归！${c.reset}\n`);
  process.exit(1);
} else {
  console.log(`\n${c.green}${c.bold}✔ 影视资源库全量发现门禁通过：双路召回、国漫兼容与动态分页缓冲区完整。${c.reset}\n`);
  process.exit(0);
}

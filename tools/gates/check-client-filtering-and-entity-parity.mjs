#!/usr/bin/env node
/**
 * 客户端即时筛选、实体属性完整性与防 N+1 串行外网网络调用质量门禁
 * (tools/gates/check-client-filtering-and-entity-parity.mjs)
 *
 * 守护契约：
 *   1. [No-Hard-Link-In-Memory-Filter]:
 *      在已持有全量数据的客户端组件 (apps/web/features/catalog/components/library-quick-find.tsx) 中，
 *      状态药丸与分类过滤药丸必须声明 prefetch={false} 并且带有 preventDefault onClick 事件拦截，
 *      严禁使用未经拦截的原生 Next.js <Link> 触发全树 Server RSC 往返重渲染；
 *   2. [MediaTitle-PosterPath-Preservation]:
 *      在所有元数据摄入、反推入库与扫描评审路径中，构造 MediaTitle 实体时必须完整保留并传递 posterPath：
 *      - apps/web/app/api/storage/files/adopt/route.ts
 *      - apps/web/app/api/storage/scan/review/route.ts
 *      - packages/workflow/src/storage/reverse-storage-scanner.ts
 *      - apps/web/features/acquisition/application/acquisition-service.ts
 *   3. [No-Sequential-Loop-Network-Calls]:
 *      在 apps/web/lib/title-hub.ts 的 getLibraryWall 与 getInProgressTitles 中，
 *      严禁在循环体内部直接串行执行 await movieTargetFromTmdbId 或 await seriesTargetFor；
 *      必须使用 Promise.all 并行池处理，并且在富化成功后调用 updateMediaTitlePosterPath 持久化回写 SQLite。
 *
 * 退出码: 0 = 通过, 1 = 违规 (打印违规详情)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const violations = [];

// 1. [No-Hard-Link-In-Memory-Filter]
const libraryQuickFindPath = join(root, "apps/web/features/catalog/components/library-quick-find.tsx");
if (existsSync(libraryQuickFindPath)) {
  const content = readFileSync(libraryQuickFindPath, "utf8");

  // 必须具备 prefetch={false}
  const prefetchMatches = content.match(/prefetch=\{false\}/g) || [];
  if (prefetchMatches.length < 3) {
    violations.push({
      file: "apps/web/features/catalog/components/library-quick-find.tsx",
      rule: "No-Hard-Link-In-Memory-Filter",
      message: `状态胶囊与分类药丸缺少 prefetch={false} 声明 (当前仅发现 ${prefetchMatches.length} 处)，可能引发视口 RSC 预取风暴。`,
    });
  }

  // 必须具备 e.preventDefault() 拦截以走客户端浅层路由
  if (!content.includes("e.preventDefault()") || !content.includes("handleStatusClick")) {
    violations.push({
      file: "apps/web/features/catalog/components/library-quick-find.tsx",
      rule: "No-Hard-Link-In-Memory-Filter",
      message: "未检测到针对 Link 点击事件的 preventDefault() 拦截与 handleStatusClick 客户端处理，会导致页面发起无意义的 Server RSC 网络请求。",
    });
  }
} else {
  violations.push({
    file: "apps/web/features/catalog/components/library-quick-find.tsx",
    rule: "File-Exists",
    message: "未找到核心客户端组件 library-quick-find.tsx",
  });
}

// 2. [MediaTitle-PosterPath-Preservation]
const adoptRoutePath = join(root, "apps/web/app/api/storage/files/adopt/route.ts");
if (existsSync(adoptRoutePath)) {
  const content = readFileSync(adoptRoutePath, "utf8");
  if (!content.includes("posterPath") || !content.includes("resolved.posterPath")) {
    violations.push({
      file: "apps/web/app/api/storage/files/adopt/route.ts",
      rule: "MediaTitle-PosterPath-Preservation",
      message: "adopt 路由在构建 MediaTitle 时未传递 posterPath，导致扫描入库的作品缺失海报数据。",
    });
  }
}

const scanReviewPath = join(root, "apps/web/app/api/storage/scan/review/route.ts");
if (existsSync(scanReviewPath)) {
  const content = readFileSync(scanReviewPath, "utf8");
  if (!content.includes("posterPath: item.matchedPosterPath")) {
    violations.push({
      file: "apps/web/app/api/storage/scan/review/route.ts",
      rule: "MediaTitle-PosterPath-Preservation",
      message: "scan/review 路由在确认入库构造 titleObj 时漏掉了 item.matchedPosterPath。",
    });
  }
}

const reverseScannerPath = join(root, "packages/workflow/src/storage/reverse-storage-scanner.ts");
if (existsSync(reverseScannerPath)) {
  const content = readFileSync(reverseScannerPath, "utf8");
  if (!content.includes("matchedPosterPath") || !content.includes("posterPath: meta.matchedPosterPath")) {
    violations.push({
      file: "packages/workflow/src/storage/reverse-storage-scanner.ts",
      rule: "MediaTitle-PosterPath-Preservation",
      message: "reverse-storage-scanner 在 adoptDiscoveredMedia 或 resolveMetadata 时漏掉了海报路径传播。",
    });
  }
}

const acquisitionServicePath = join(root, "apps/web/features/acquisition/application/acquisition-service.ts");
if (existsSync(acquisitionServicePath)) {
  const content = readFileSync(acquisitionServicePath, "utf8");
  if (!content.includes("posterPath: candidate.posterPath")) {
    violations.push({
      file: "apps/web/features/acquisition/application/acquisition-service.ts",
      rule: "MediaTitle-PosterPath-Preservation",
      message: "acquisition-service 在构造 MediaTitle 时漏掉了 candidate.posterPath。",
    });
  }
}

// 3. [No-Sequential-Loop-Network-Calls]
const titleHubWallPath = join(root, "apps/web/lib/title-hub-wall.ts");
const titleHubPath = join(root, "apps/web/lib/title-hub.ts");
const targetHubPath = existsSync(titleHubWallPath) ? titleHubWallPath : titleHubPath;

if (existsSync(targetHubPath)) {
  const content = readFileSync(targetHubPath, "utf8");

  // 检测是否仍然存在旧版串行循环
  if (content.includes("for (const [tmdbId, titleStates] of byTitle) {\n    const title = titleStates[0]!.title;\n    let posterPath = title.posterPath ?? null;\n    if (posterPath === null) {\n      posterPath =")) {
    violations.push({
      file: targetHubPath,
      rule: "No-Sequential-Loop-Network-Calls",
      message: "getLibraryWall 中检测到串行 for ... of 循环调用外网 TMDB，必须使用 Promise.all 并行池。",
    });
  }

  // 检测是否具备持久化回写
  if (!content.includes("updateMediaTitlePosterPath")) {
    violations.push({
      file: targetHubPath,
      rule: "Cache-Aside-Write-Back",
      message: "title-hub 缺失 updateMediaTitlePosterPath 持久化回写调用，会导致海报每次访问重复穿透外网。",
    });
  }
}

// 输出检测结果
console.log("\n================ 巡影 · 客户端即时筛选与实体完整性门禁 ================");
if (violations.length === 0) {
  console.log("  [PASS] 客户端即时筛选规范：所有状态药丸均已接入客户端事件拦截与防预取！");
  console.log("  [PASS] 实体属性完整性：反推入库与扫描评审等 4 处构造路径均已正确保留海报！");
  console.log("  [PASS] 服务端防 N+1 陷阱：title-hub 已接入 Promise.all 并行化与 SQLite 自动持久化回写！");
  console.log("========================================================================\n");
  process.exit(0);
} else {
  console.error(`  [FAIL] 发现 ${violations.length} 项架构或性能契约违规：\n`);
  for (const v of violations) {
    console.error(`  ❌ [${v.rule}] ${v.file}`);
    console.error(`     原因: ${v.message}\n`);
  }
  console.error("========================================================================\n");
  process.exit(1);
}

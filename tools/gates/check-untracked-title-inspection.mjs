#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 未追踪影视作品搜索快照与探活质量门禁 (Untracked Title Inspection Gate)
 *
 * 核心检查项：
 *  1. 【搜索快照无条件落盘门禁 (Resource Search Snapshot Save Guard)】：
 *     确保 SqliteWorkflowRepository 与 InMemoryWorkflowRepository 在保存 resource_search
 *     类型快照时，彻底豁免 requireTrackedSeason，严禁因作品尚未追踪而静默丢弃快照。
 *  2. 【未追踪作品水合元数据自愈门禁 (Unseeded Season Metadata Self-Healing Guard)】：
 *     确保 replaceWorkflowRunSnapshot 在季尚未在 tracked_seasons 时，安全写入基础
 *     media_titles 与 tracked_seasons 实体，确保 loadSnapshot 能完整水合，
 *     彻底消灭 inspect / link / import 接口的 404 "snapshot not found"。
 *  3. 【订阅墙防污染强隔离门禁 (Subscription Wall Contamination Guard)】：
 *     确保 scopedRunRows 与 isVisibleTrackedSnapshot 显式物理过滤 row.kind !== "resource_search"，
 *     严禁仅搜索过的作品被错误标记为“已追踪/追更中”或出现在订阅墙上。
 *  4. 【双仓储行为一致性动态自检 (Repository Parity Dynamic Test)】：
 *     动态实例化 SqliteWorkflowRepository 与 InMemoryWorkflowRepository，执行端到端
 *     未追踪作品保存、反查与订阅隔离断言。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

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
  console.error(`${c.red}✖ [Untracked Title Gate Violation]${c.reset} ${path.relative(repoRoot, file)}:${line}`);
  console.error(`  ${c.yellow}原因:${c.reset} ${message}`);
  violations++;
}

// 1. 静态检查 Sqlite 仓储实现
function checkSqliteRepository() {
  const file = path.join(repoRoot, "packages/workflow/src/persistence/sqlite.ts");
  if (!fs.existsSync(file)) {
    reportViolation(file, 1, "sqlite.ts 文件不存在");
    return;
  }
  const content = fs.readFileSync(file, "utf8");

  if (!content.includes('snapshot.workflowRun.kind === "resource_search"') || !content.includes("!isSearchRecord &&")) {
    reportViolation(
      file,
      330,
      "saveWorkflowRunSnapshot 未能豁免 resource_search 的 requireTrackedSeason 校验，未追踪作品快照会被静默丢弃！",
    );
  }

  if (!content.includes("!existingSeason || writeSeasonState")) {
    reportViolation(
      file,
      540,
      "replaceWorkflowRunSnapshot 未能在季不存在时补充写入基础元数据，会导致 loadSnapshot 无法水合！",
    );
  }

  if (!content.includes('row.kind !== "resource_search"')) {
    reportViolation(
      file,
      1300,
      "scopedRunRows 未能显式排除 resource_search，会导致仅搜索过的作品被错误视作已追踪！",
    );
  }
}

// 2. 静态检查内存仓储实现
function checkInMemoryRepository() {
  const file = path.join(repoRoot, "packages/workflow/src/persistence/repository.ts");
  if (!fs.existsSync(file)) {
    reportViolation(file, 1, "repository.ts 文件不存在");
    return;
  }
  const content = fs.readFileSync(file, "utf8");

  if (!content.includes('cloned.workflowRun.kind === "resource_search"') || !content.includes("!isSearchRecord &&")) {
    reportViolation(
      file,
      1220,
      "InMemoryWorkflowRepository.saveWorkflowRunSnapshot 未能豁免 resource_search 的 requireTrackedSeason 校验！",
    );
  }

  if (!content.includes('snapshot.workflowRun.kind !== "resource_search"')) {
    reportViolation(
      file,
      2435,
      "isVisibleTrackedSnapshot 未能显式排除 resource_search，会污染内存仓储的追踪状态！",
    );
  }
}

// 3. 动态验证端到端保存与隔离
async function verifyDynamicBehavior() {
  const {
    SqliteWorkflowRepository,
    InMemoryWorkflowRepository,
    buildResourceSearchRun,
    resourceSearchRunId,
  } = await import("../../packages/workflow/dist/index.js");

  const repos = [
    { name: "SqliteWorkflowRepository", repo: new SqliteWorkflowRepository(new Database(":memory:")) },
    { name: "InMemoryWorkflowRepository", repo: new InMemoryWorkflowRepository() },
  ];

  const now = "2026-11-02T10:00:00.000Z";
  const fakeSnapshot = {
    id: "search_acct_default_1319_gate_test",
    provider: "merged",
    keyword: "葫芦娃",
    candidates: [
      {
        id: "search_acct_default_1319_gate_test_c1",
        snapshotId: "search_acct_default_1319_gate_test",
        index: 0,
        title: "葫芦兄弟 4K",
        type: "115",
        source: "pansou",
        providerPayload: { url: "https://115.com/s/gate_test" },
      },
    ],
    createdAt: now,
  };

  const syntheticTitle = {
    id: "tmdb_tv_1319",
    tmdbId: 1319,
    type: "tv",
    title: "葫芦兄弟",
    originalTitle: "葫芦兄弟",
    year: 1986,
    aliases: ["葫芦娃"],
    posterPath: null,
    backdropPath: null,
  };

  const syntheticSeason = {
    id: "tmdb_tv_1319_s1",
    mediaTitleId: syntheticTitle.id,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "",
    totalEpisodes: 13,
    latestAiredEpisode: 13,
    latestAiredSource: "metadata",
  };

  for (const { name, repo } of repos) {
    const runInput = buildResourceSearchRun({
      snapshot: fakeSnapshot,
      title: syntheticTitle,
      season: syntheticSeason,
      accountId: "acct_default",
      connectedStorageId: "cs_gate_drive",
      now,
    });

    await repo.saveWorkflowRunSnapshot({
      ...runInput,
      keepCurrentEpisodes: true,
    });

    const recovered = await repo.getWorkflowRunSnapshot(
      resourceSearchRunId(fakeSnapshot.id),
      "acct_default",
    );

    if (!recovered) {
      console.error(`${c.red}✖ [动态测试失败] ${name} 无法按 snapshotId 找回未追踪快照！${c.reset}`);
      violations++;
    } else if (recovered.resourceSnapshots[0]?.candidates?.length !== 1) {
      console.error(`${c.red}✖ [动态测试失败] ${name} 水合快照中候选资源丢失！${c.reset}`);
      violations++;
    }

    const tracked = await repo.listTrackedSeasonStates({
      accountId: "acct_default",
      connectedStorageId: "cs_gate_drive",
    });

    if (tracked.some((s) => s.title.tmdbId === 1319)) {
      console.error(`${c.red}✖ [动态测试失败] ${name} 未追踪作品被错误加入订阅追踪列表！${c.reset}`);
      violations++;
    }
  }
}

async function main() {
  console.log(`\n${c.bold}▶ 正在执行巡影 · Mediary Scout 未追踪影视作品搜索快照与探活质量门禁...${c.reset}\n`);

  checkSqliteRepository();
  checkInMemoryRepository();
  await verifyDynamicBehavior();

  if (violations > 0) {
    console.error(`\n${c.red}✖ 质量门禁拦截：发现 ${violations} 处架构规范或行为违规，请立即修正！${c.reset}\n`);
    process.exit(1);
  }

  console.log(`${c.green}✔ 未追踪影视作品搜索快照与探活质量门禁全部通过！${c.reset}\n`);
}

main().catch((err) => {
  console.error(`${c.red}门禁脚本发生未捕获异常:${c.reset}`, err);
  process.exit(1);
});

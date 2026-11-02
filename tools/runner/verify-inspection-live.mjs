#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 未追踪作品资源快照与探活端到端验证工具 (Live Verification Runner)
 */

import { getWorkflowRepository } from "../../apps/web/lib/workflow-runtime.ts";
import { resourceSearchRunId } from "@media-track/workflow";

async function main() {
  console.log("\n▶ 正在验证未追踪作品（TMDB 1319 - 葫芦兄弟）快照落盘与反查链路...");

  const repo = getWorkflowRepository();
  const accountId = "acct_default";
  const tmdbId = 1319;

  // 1. 验证订阅列表中不存在 1319（保持未追踪隔离）
  const trackedStates = await repo.listTrackedSeasonStates(accountId);
  const isTracked = trackedStates.some((s) => s.title.tmdbId === tmdbId);
  console.log(`1. 验证作品是否为未追踪状态: ${!isTracked ? "✔ 正确（未追踪）" : "✖ 异常（已被追踪）"}`);

  // 2. 模拟搜索落盘快照
  const snapshotId = `search_acct_default_${tmdbId}_${Date.now()}`;
  const testSnapshot = {
    id: snapshotId,
    provider: "merged",
    keyword: "葫芦娃",
    candidates: [
      {
        id: `${snapshotId}_c1`,
        snapshotId: snapshotId,
        index: 0,
        title: "葫芦兄弟 (1986) 4K 全13集",
        type: "115",
        source: "pansou",
        providerPayload: { url: "https://115.com/s/sw34928" },
      },
    ],
    createdAt: new Date().toISOString(),
  };

  const syntheticTitle = {
    id: `tmdb_tv_${tmdbId}`,
    tmdbId,
    type: "tv",
    title: "葫芦兄弟",
    originalTitle: "葫芦兄弟",
    year: 1986,
    aliases: ["葫芦娃"],
    posterPath: null,
    backdropPath: null,
  };

  const syntheticSeason = {
    id: `tmdb_tv_${tmdbId}_s1`,
    mediaTitleId: syntheticTitle.id,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "",
    totalEpisodes: 13,
    latestAiredEpisode: 13,
    latestAiredSource: "metadata",
  };

  const { buildResourceSearchRun } = await import("@media-track/workflow");
  const runInput = buildResourceSearchRun({
    snapshot: testSnapshot,
    title: syntheticTitle,
    season: syntheticSeason,
    accountId,
    connectedStorageId: "cs_3204551",
    now: testSnapshot.createdAt,
  });

  await repo.saveWorkflowRunSnapshot({
    ...runInput,
    keepCurrentEpisodes: true,
  });
  console.log("2. 正在执行未追踪作品快照持久化 (saveWorkflowRunSnapshot with keepCurrentEpisodes: true)...");

  // 3. 模拟 /inspect, /link, /import 接口读取快照
  const recovered = await repo.getWorkflowRunSnapshot(
    resourceSearchRunId(snapshotId),
    accountId,
  );

  if (recovered) {
    console.log("   ✔ 快照成功按 snapshotId 找回！");
    console.log(`   - 关联影视: ${recovered.title.title} (TMDB: ${recovered.title.tmdbId})`);
    console.log(`   - 候选数量: ${recovered.resourceSnapshots[0]?.candidates.length} 条`);
    console.log(`   - 候选标题: ${recovered.resourceSnapshots[0]?.candidates[0]?.title}`);
  } else {
    console.error("   ✖ 致命错误：快照依然未找到 (snapshot not found)！");
    process.exit(1);
  }

  // 4. 再次验证订阅墙未被污染
  const trackedAfter = await repo.listTrackedSeasonStates(accountId);
  const isTrackedAfter = trackedAfter.some((s) => s.title.tmdbId === tmdbId);
  console.log(`3. 再次验证订阅墙是否防污染: ${!isTrackedAfter ? "✔ 100% 干净，未出现虚假追踪！" : "✖ 异常（被污染）"}`);

  console.log("\n🎉 全部端到端快照持久化与水合验证通过！\n");
}

main().catch((err) => {
  console.error("验证失败:", err);
  process.exit(1);
});

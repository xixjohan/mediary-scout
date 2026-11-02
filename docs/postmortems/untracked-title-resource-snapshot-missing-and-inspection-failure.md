# 故障复盘：未追踪影视作品搜索快照丢失导致文件树探活与手动入库失败 (Snapshot Not Found)

## 1. 事故摘要
- **故障现象**：在浏览未追踪作品（例如从搜索页进入的《葫芦兄弟 (1986)》，TMDB 1319）时，能够正常查出网盘候选，但候选卡片上的探活状态显示为「未知」，点击「文件树」和「手动入库」时全部报错 `snapshot not found`。
- **故障定级**：P1（核心资源获取链路受阻）。用户无法对搜索出的新片进行任何入库或探活操作。
- **根因**：历史修复“龙珠超入库后集状态被搜索抹除”问题时，引入了 `keepCurrentEpisodes: true` 保护，但底层仓储将 `keepCurrentEpisodes` 误判为“必须是已追踪季（requireTrackedSeason）”，导致未追踪作品的搜索快照在写库时被静默跳过（return），后续的探活和入库接口查库时命中 404。
- **修复方案**：
  1. 仓储层将 `resource_search` 工作流从 `requireTrackedSeason` 校验中彻底豁免，保证搜索快照 100% 可落盘；
  2. 针对未追踪作品，在保存搜索快照时补充写入基础的 `media_titles` 与 `tracked_seasons` 实体，供快照水合；
  3. `scopedRunRows` 彻底排除 `resource_search`，保证未追踪作品绝不误出现在订阅墙上；
  4. 保持 `runOnly` 集状态保护机制，保证已入库剧集绝不被抹除。

---

## 2. 关键代码变更点

### 2.1 仓储层解除 `resource_search` 的追踪强绑定
在 `SqliteWorkflowRepository.saveWorkflowRunSnapshot` 与 `InMemoryWorkflowRepository.saveWorkflowRunSnapshot` 中：
```typescript
const isAuxiliary = isEpisodePreservingWorkflowKind(snapshot.workflowRun.kind);
const shouldKeepEpisodes = keepCurrentEpisodes === true || isAuxiliary;
const isSearchRecord = snapshot.workflowRun.kind === "resource_search";

// resource_search 快照独立于追踪状态，绝不受 requireTrackedSeason 阻断
const requireTracked = !isSearchRecord && reservationRequiresTrackedSeason({
  ...(requireTrackedSeason === true ? { requireTrackedSeason: true } : {}),
  ...(shouldKeepEpisodes ? { keepCurrentEpisodes: true } : {}),
});
```

### 2.2 确保快照水合元数据可用且不触碰剧集表
在 `replaceWorkflowRunSnapshot` 中：
```typescript
const writeSeasonState = options.runOnly !== true;
const existingSeason = this.db
  .prepare("SELECT 1 FROM tracked_seasons WHERE id = ? AND connected_storage_id = ?")
  .get(snapshot.season.id, connectedStorageId);

if (!existingSeason || writeSeasonState) {
  this.db
    .prepare(
      "INSERT INTO media_titles (id, payload) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET payload = excluded.payload",
    )
    .run(snapshot.title.id, JSON.stringify(snapshot.title));
  this.upsertTrackedSeason(snapshot.season, accountId, connectedStorageId);
}
this.upsertWorkflowRun(snapshot.workflowRun, accountId, connectedStorageId);
this.deleteWorkflowRunChildren(snapshot.workflowRun.id);

if (writeSeasonState) {
  // 仅在非 runOnly 场景才管理集状态，搜索快照绝不触碰 episode_states
  this.db
    .prepare("DELETE FROM episode_states WHERE tracked_season_id = ? AND connected_storage_id = ?")
    .run(snapshot.season.id, connectedStorageId);
  ...
}
```

### 2.3 订阅列表物理过滤非追踪工作流
在 `scopedRunRows` 中增加过滤：
```typescript
.filter((row) => !isStagingJanitorId(row.id) && !isStagingJanitorId(row.trackedSeasonId) && row.kind !== "resource_search");
```
并在 `InMemoryWorkflowRepository` 的 `isVisibleTrackedSnapshot` 中对齐过滤：
```typescript
function isVisibleTrackedSnapshot(snapshot: PersistWorkflowRunSnapshotInput): boolean {
  return (
    !isStagingJanitorId(snapshot.workflowRun.id) &&
    !isStagingJanitorId(snapshot.season.id) &&
    snapshot.workflowRun.kind !== "resource_search"
  );
}
```

---

## 3. 门禁防护与验证
- 针对该问题建立专项门禁 `tools/gates/check-untracked-title-inspection.mjs`。
- 自动化运行 `npm run gate:inspection`，对 SQLite 及内存仓储进行未追踪状态持久化与快照反查全链路测试，防止回潮。

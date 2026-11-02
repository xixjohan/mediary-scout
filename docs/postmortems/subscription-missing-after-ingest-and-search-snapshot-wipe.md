# 龙珠超：比鲁斯 (2026) 入库后在活动中已更新但在订阅中仍显示缺少根因调研与治理方案

## 1. 问题背景与真实案例还原

### 1.1 问题现象
用户反馈：作品 **《龙珠超：比鲁斯 (2026)》**（TMDB ID: 312359）在后台成功获取并部分集入库，在「活动（Activity）」页面及通知中明确显示已更新且任务执行成功：
- 通知中心显示：
  > 📺 **龙珠超：比鲁斯 第 1 季**  
  > 📈 已获取至最新 · 后续更新自动追踪  
  > ✅ 本次新增：E01、E02、E03  
  > 🎞 每集：约 6.9 GB  
- 活动列表记录：
  > 工作流 `type2_init` (`d7250a30-a08e-4342-8268-93c1ff8a6107`) 状态为 `succeeded`，转存成功保留 3 个文件（`kept: 3, thrownAway: 67`），耗时约 3 分 47 秒。

**然而在「我的订阅（Subscription）」列表中**：
该作品卡片未显示「追更中（3/3）」，而是赫然打上了 ⚠️ **「有缺集」/ 缺少**（甚至显示缺少全部 3 集），剧集详情页季行中获取进度显示为 0/3，产生了严重的业务感知矛盾——用户误以为入库失败或文件丢失。

---

## 2. 根因深度剖析（Root Cause Analysis）

通过对运行时数据库（`run/mediary.db`）、持久化仓储层（`SqliteWorkflowRepository` / `InMemoryWorkflowRepository`）、工作流引擎（`runner-v2`）、资源检索接口（`POST /api/titles/resources`）及展示层（`title-hub.ts` / `title-aggregate.ts`）的执行链路追踪，彻底查明了事故的完整发生时序：

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │ 1. 初始入库 (Type2 Init Workflow)                           │
                    │   - 成功转存 S01E01~S01E03，写入 notification 与 activity   │
                    │   - persistSingleSeason 写入 episode_states (E01~E03: true) │
                    └──────────────────────────────┬──────────────────────────────┘
                                                   │
                                                   ▼
                    ┌─────────────────────────────────────────────────────────────┐
                    │ 2. 用户浏览详情页或手动搜索资源 (POST /api/titles/resources)│
                    │   - 搜索命中并为了暂存候选快照调用 saveWorkflowRunSnapshot   │
                    │   - 传入 buildResourceSearchRun: 显式声明 episodes: []      │
                    │   - 漏传 keepCurrentEpisodes: true                          │
                    └──────────────────────────────┬──────────────────────────────┘
                                                   │
                                                   ▼ 【致命漏洞爆发】
                    ┌─────────────────────────────────────────────────────────────┐
                    │ 3. SqliteWorkflowRepository.replaceWorkflowRunSnapshot      │
                    │   - 判定 writeSeasonState = true                            │
                    │   - 执行: DELETE FROM episode_states WHERE tracked_season_id│
                    │   - 龙珠超已入库的全部集状态瞬时被物理抹除 (清空为 0 条)！   │
                    └──────────────────────────────┬──────────────────────────────┘
                                                   │
                                                   ▼
                    ┌─────────────────────────────────────────────────────────────┐
                    │ 4. 用户进入「我的订阅」页面 (getLibraryWall)                │
                    │   - repository.listTrackedSeasonStates 读取集状态           │
                    │   - state.episodes 为空，计算 obtainedCount = 0             │
                    │   - TMDB 最新已播 latestAiredEpisode = 3                    │
                    │   - obtained(0) < aired(3) ⇒ 判定为 "partial" (有缺集/缺少) │
                    │   - 而活动页读的是 workflow_runs 成功记录，造成两头分裂！   │
                    └─────────────────────────────────────────────────────────────┘
```

### 2.1 证据事实（Database Evidence）
检查 `run/mediary.db`：
1. `media_titles` 存在 `tmdb_tv_312359`（龙珠超：比鲁斯，2026）。
2. `tracked_seasons` 存在 `tmdb_tv_312359_s1`（第 1 季，`latestAiredEpisode: 3, totalEpisodes: 19`）。
3. `workflow_runs` 中记录了初始入库工作流：
   - `id: d7250a30-a08e-4342-8268-93c1ff8a6107`, `kind: type2_init`, `status: succeeded`, `startedAt: 2026-10-31T01:38:05.156Z`。
   - `transfer_attempts` 显示成功转存并保留 3 集（S01E01, S01E02, S01E03）。
   - `notifications` 记录了新增 E01、E02、E03。
4. 在此之后，`workflow_runs` 出现了两条新记录：
   - `id: search_search_acct_default_312359_1793562081317`, `kind: resource_search`, `startedAt: 2026-11-01T19:41:21.317Z`
   - `id: search_search_acct_default_312359_1793570237659`, `kind: resource_search`, `startedAt: 2026-11-01T21:57:17.659Z`
5. 查询 `episode_states WHERE tracked_season_id = 'tmdb_tv_312359_s1'`：
   **结果返回 0 行！全表仅存 3 行 Movie 的记录，TV 剧集全部被清空！**

### 2.2 核心代码缺陷：隐式破坏性覆盖（Implicit Destructive Overwrite）
在 `packages/workflow/src/providers/resource-search-run.ts` 中：
```typescript
export function buildResourceSearchRun(input: BuildResourceSearchRunInput): PersistWorkflowRunSnapshotInput {
  return {
    title: input.title,
    season: input.season,
    workflowRun: {
      id: resourceSearchRunId(input.snapshot.id),
      kind: RESOURCE_SEARCH_KIND,
      status: "succeeded",
      ...
    },
    episodes: [], // 注释自称：搜索没有转存，故置空
    resourceSnapshots: [input.snapshot],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    accountId: input.accountId,
    connectedStorageId: input.connectedStorageId ?? null,
  };
}
```
当详情页或用户检索调用 `POST /api/titles/resources`（包括常规与流式两处）时：
```typescript
await getWorkflowRepository().saveWorkflowRunSnapshot(
  buildResourceSearchRun({ ... })
);
```
这里**未传入 `{ keepCurrentEpisodes: true }`**！

在仓储层 `packages/workflow/src/persistence/sqlite.ts`：
```typescript
private replaceWorkflowRunSnapshot(
  snapshot: PersistWorkflowRunSnapshotInput,
  options: { runOnly?: boolean } = {},
): void {
  ...
  const writeSeasonState = options.runOnly !== true;
  ...
  if (writeSeasonState) {
    this.db
      .prepare("DELETE FROM episode_states WHERE tracked_season_id = ? AND connected_storage_id = ?")
      .run(snapshot.season.id, connectedStorageId);
    const insertEpisode = this.db.prepare(
      "INSERT INTO episode_states (tracked_season_id, connected_storage_id, episode_code, payload) VALUES (?, ?, ?, ?)",
    );
    for (const episode of snapshot.episodes) {
      insertEpisode.run(...);
    }
  }
}
```
当 `options.runOnly` 为默认的 `false` 时，系统判定需要同步覆写季状态，**首先无条件执行 `DELETE FROM episode_states`，随后遍历 `snapshot.episodes`（即空数组 `[]`）执行插入——已入库的全部剧集状态瞬间蒸发**！

同类隐患还存在于：
1. `apps/web/app/api/titles/organize/route.ts`：整理操作调用 `saveWorkflowRunSnapshot(buildOrganizeRun(...))`，`buildOrganizeRun` 同样带 `episodes: []`，未传 `keepCurrentEpisodes: true`。
2. `packages/workflow/src/execution/manual-import-command.ts`：手动入库预约 `buildManualImportReservation` 同样带 `episodes: []`，预约阶段调用 `reserveWorkflowRun` 同样未标记 `keepCurrentEpisodes: true`。

---

## 3. 业界主流方案调研与对比

我们对行业标杆开源媒体自动化系统进行了横向架构对比：

| 系统 / 方案 | 领域模型设计 | 搜索结果处理方式 | 剧集与文件关联机制 | 缺集判定口径 | 对本项目的启示 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Sonarr / Radarr** (C#) | `Series` / `Season` / `Episode` / `EpisodeFile` 严格实体分层 | 搜索结果作为内存 `Release` 或事件流返回，完全独立于库表，永不落入媒体主表 | `EpisodeFile` 独立建表，物理文件导入时通过 Foreign Key 挂载到 `Episode`，无实体级全量抹除 | `Monitored && AirDateUtc < Now && EpisodeFileId == 0` | 检索与入库属于完全正交的领域事件，搜索记录绝不能逆向污染或重置实体状态 |
| **MoviePilot** (Python) | `Subscribe` (订阅) 与 `Media` (媒体库) 解耦，`History` 记账 | 站点检索结果存入 Redis 缓存或内存会话，不触发订阅表或文件列表的变更 | 依赖网盘/本地目录扫描 (`DirectoryWatcher`) 与 STRM 文件生成双向校准 | 已播集数与本地扫描到的有效视频文件取差集 | 搜索元数据快照应当具备专属存储或生命周期，绝不能借道「伪工作流快照」覆写剧集状态 |
| **Jellyseerr / Overseerr** (TypeScript) | `Media` 状态机与 `MediaRequest` 请求解耦 | 搜索直接打上游 TMDB API，前端直连，无服务端中间持久化快照污染 | 依赖下级服务端（Plex/Jellyfin/Radarr）Webhook 回调通知状态 | Radarr/Sonarr 状态直接映射 | 单向数据流：只有明确确认的采集/入库事件才能驱动 `Media.status` 迁移 |

**核心共识**：
1. **职责分离（SRP）**：搜索仅是查询，其输出物是「候选（Candidates）」，绝不是「已入库剧集（EpisodeStates）」的代表；
2. **写保护（Immutable / Append-Only Ingestion）**：已入库的剧集状态是昂贵的物理网盘转存结果，除非发生明确的物理删除（Untrack / Delete / File Gone），任何记录类、元数据类、整理类工作流绝对严禁重置集状态表；
3. **防御性设计（Defensive Default）**：仓储层在面对非采集类任务时，默认行为应是「只读/追加任务本身」，而不是「破坏性刷新全集」。

---

## 4. 当前系统基础设施与可复用能力分析

经审计，当前代码库中已具备完备的基础设施，无需引入笨重第三方库即可实现多层防护：
1. **显式保留开关**：`PersistWorkflowRunSnapshotInput` 与 `ReserveWorkflowRunInput` 已经原生支持 `keepCurrentEpisodes?: boolean`；
2. **底层单任务持久化**：`SqliteWorkflowRepository.replaceWorkflowRunSnapshot` 已经具备 `options.runOnly: true` 分支，当该标记为真时，只更新 `workflow_runs`、`resource_snapshots`，完全不触碰 `episode_states`；
3. **内存仓储双模对齐**：`InMemoryWorkflowRepository` 亦实现了 `keepCurrentEpisodes`（从 `this.episodesBySeason` 原样继承）；
4. **工作流类型区分体系**：`WorkflowKind` 已清晰区分业务采集任务（`type2_init`, `type3_monitor`, `movie_init`, `replace_request`）与辅助/记录任务（`resource_search`, `title_organize`, `manual_import`）；
5. **集状态确定性生成器**：`createEpisodeStates` 原生支持基于季号、总集数、已播集数的标准状态生成与状态合并。

---

## 5. 具体解决方案设计

### 5.1 解决方案架构图
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. 仓储层纵深防御 (Repository Fail-Safe)                                    │
│    - 非采集类工作流 (resource_search / title_organize) 强制默认 runOnly: true  │
│    - 任何 snapshot.episodes 为空且未显式指定覆写的操作，自动继承现有集状态     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ 2. 写入源头严格标记 (Caller Explicit Opt-in)                                │
│    - POST /api/titles/resources: 显式声明 keepCurrentEpisodes: true        │
│    - POST /api/titles/organize: 显式声明 keepCurrentEpisodes: true         │
│    - manual-import-command: 预约时显式声明 keepCurrentEpisodes: true       │
│    - buildResourceSearchRun / buildOrganizeRun 元数据内建保护标志           │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ 3. 数据原地自愈 (Self-Healing & Data Repair)                                │
│    - 针对 run/mediary.db 历史被误清空的剧集（如龙珠超：比鲁斯、Lupin）：      │
│    - 根据成功转存记录 (transfer_attempts/notifications) 重建完整集状态     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ 4. 自动化质检门禁 (Quality Gate & AST Verification)                         │
│    - 新增 tools/gates/check-episode-preservation.mjs 静态 AST 门禁          │
│    - 单元测试钉死：非采集工作流入库绝不抹除已入库集状态                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. 避免同类问题的门禁与测试体系

1. **静态代码分析门禁（Quality Gate）**：
   在 `tools/gates/check-episode-preservation.mjs` 中扫描所有调用 `saveWorkflowRunSnapshot` 与 `reserveWorkflowRun` 的代码位置，凡工作流类型为 `resource_search`、`title_organize`、`manual_import` 者，若未包含 `keepCurrentEpisodes` 保护属性，门禁直接阻断并报错退出。
2. **仓储层单元测试（Vitest Tests）**：
   - 验证在已拥有已获取剧集（如 E01-E03 `obtained: true`）的季上执行 `resource_search`，`episode_states` 仍然完好保留。
   - 验证执行 `title_organize` 与 `manual_import` 预约，`episode_states` 同样完好保留。
   - 验证内存实现与 SQLite 实现行为完全一致（Parity）。

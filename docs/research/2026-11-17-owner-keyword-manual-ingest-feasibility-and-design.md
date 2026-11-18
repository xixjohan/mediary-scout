# 站长专用「关键字检索 → 选结果 → 选入库路径 → 转存/离线 → 入库」可行性调研与方案

- 日期：2026-11-17
- 状态：**已实施**（阶段 1–4 全部落地 + G1–G8 门禁；未部署）
- 需求原话：「手动搜索并手动入库，不走影视搜索方案，只根据用户关键字检索，然后选择结果配置入库路径（可视化操作），执行转存或离线下载，进行入库；并且只允许站长使用」
- 附加要求：头脑风暴可行性/逻辑/性能欠缺；评估适配器策略模式与状态机；查现成库与业界方案；确认本仓已有基础设施可复用；写入 `docs`。

---

## 1. 结论先行

**可行，且不需要新底座。** 这条链路里最难的三件事——网盘写、候选句柄、落盘后台化——本仓都已生产化：

| 环节 | 已有实现 | 位置 |
| --- | --- | --- |
| 多品牌离线/转存分发 | 按品牌 `if` 分发，覆盖 115/123/光鸭离线 + 115/夸克/123/天翼分享转存 | `apps/web/app/api/storage/offline/route.ts:378`、`:398` |
| 品牌能力注册表（适配器） | `STORAGE_BRANDS` 自包含 `create/createBootstrap/writeScope/…` | `packages/workflow/src/storage/storage-brands.ts:227` |
| 关键字检索（与标题解耦） | `PanSouResourceProvider.search({keyword})` 本身就是纯关键字 | `packages/workflow/src/providers/pansou-provider.ts:337` |
| 候选句柄/快照落库/TTL | `resource_search` 记录 + `resourceSearchRunId` + 30 分钟 TTL 复核 | `packages/workflow/src/execution/manual-import-resolver.ts:25` |
| 后台转存（不进 HTTP） | `manual_import` run + `claimNextQueuedRun` + worker drain | `packages/workflow/src/execution/manual-import-worker.ts:124` |
| 落盘后 STRM/媒体服务器联动 | `triggerPostIngestSyncIfSucceeded` 已挂在 manual import 成功路径 | `packages/workflow/src/execution/manual-import-worker.ts:224` |
| 可视化目录选择 | `RemoteFolderPickerModal`（盘上树形下钻） | `apps/web/features/storage-drives/components/storage/remote-folder-picker-modal.tsx` |
| 协议识别/能力矩阵（策略模式） | `ingest-protocol-router.ts` 已是纯函数策略路由 | `apps/web/features/storage-drives/core/ingest-protocol-router.ts` |
| 状态机 | `xstate` 已在跑：`run-state-machine.ts`（15 态）、`library-scan-job.ts`（显式迁移表）、`qr-connect-machine.ts`（reducer） | 见 §6 |

一句话差异：**现有 `manual_import` 是「针对某个 TMDB 作品、在作品详情页里选候选」；本需求是「没有 TMDB 作品、只有一段用户关键字」**。缺的不是能力，而是「无作品的入库意图」这一层身份。

---

## 2. 现状盘点：这条链路上真正缺什么

### 2.1 已有能力（逐条核实）

**① 关键字检索已经存在，且不需要 TMDB。**
`POST /api/titles/resources` 要求 `tmdbId`（正片身份），但底层 `resolveTitleResources` 只把 `keywords` 数组交给 `provider.search`。`buildTitleSearchKeywords` 的 `customKeyword` 分支直接把用户词放最高优先级（`packages/workflow/src/providers/title-search-keywords.ts:56`）。也就是说：**关键字检索路径本身是通的，缺的是一个不要求 tmdbId 的入口**。

**② 离线/转存执行器已按品牌注册。**
`/api/storage/offline` 的 POST 已实现：协议解析 → `guardWriteTarget` 范围校验 → 按品牌分发 → 逐条返回 `{url, ok, message, taskId}`。它当前的问题见 §2.2-④。

**③ 候选入库的后台化链路完整。**
`queueManualImport` → `reserveWorkflowRun`（`blockIfTitleHasActiveRun: true`）→ worker 侧 `claimNextQueuedRun` → 复核候选成员与 TTL → 找目录 → `storage.transfer` → 成功后再 `triggerPostIngestSyncIfSucceeded`。**这条链路已经把「HTTP 不等网盘」「崩溃可续」「重复点击去重」都解决了。**

**④ 目录范围制动器（需求 2）已在写接口落地。**
`guardWriteTarget` 用 `storage:browse_any` 判定是否豁免；无此钥匙时目标目录必须落在 `libraryRootCids(creds)` 内（`apps/web/features/storage-drives/application/library-scope-guard.ts:90`）。站长天然带 `*` 因而豁免。

### 2.2 真实缺口（按严重度）

**①（P0 逻辑）入库意图没有身份载体。**
`manual_import` 的 reservation 必须带 `title: MediaTitle` 与 `season: TrackedSeason`，且 `validateWorkflowRunSnapshot` 断言 `season.mediaTitleId === title.id`、`workflowRun.trackedSeasonId === season.id`（`packages/workflow/src/persistence/repository.ts:2736`）。仓库里也没有「无 TMDB 的标题」这种形态——`MediaTitle.tmdbId` 是必填 number，`mediaLibraryFolderName` 把 tmdbId 拼进目录名 `Title (Year) {tmdb-N}`。**所以「用户只给关键字」时，必须先决定作品身份从哪来**（见 §4.1）。

**②（P0 逻辑）品牌分发在两处各写一遍，已经开始漂移。**
`/api/storage/offline` 的 `executeBrandOfflineTask` / `executeBrandShareTransferTask` 是 `if (provider === …)` 链；前端 `ingest-protocol-router.ts` 的 `DRIVE_INGEST_CAPABILITIES` 是**另一份手写能力表**。二者已经不一致：
- `storage-brands.ts` 注册了 `uc`（UC 网盘），`ingest-protocol-router.ts` 的 `DRIVE_INGEST_CAPABILITIES` **没有 uc 条目** → UC 盘在弹窗里被判「未知网盘、不支持转存」；
- `/api/storage/offline` 的 `executeBrandShareTransferTask` 也**没有 uc 分支** → 即使前端放行，提交也会抛「暂不支持分享转存」。
- 反向：`storage-brands.ts` 里 115 的 `supportsSubtitleDirectLink: true`，而 `DRIVE_INGEST_CAPABILITIES.pan115.supportsOffline` 也 true，但**两份表没有任何一致性断言**。

这正是 `storage-brands.ts` 文件头注释所批判的「factory 与注册表漂移」的**同型缺陷复发**，只是换到了 ingest 层。本需求要以关键字为中心重建 ingest 分发，**必须顺手把这张表收回到注册表**（§5.3）。

**③（P1 语义）客户端计算的能力判定不可信。**
`storage-offline-modal.tsx` 先 `GET /api/storage/offline?storageId=` 拿能力，再用**本地** `parseBatchIngestInput` 决定哪些行可提交。客户端判定 + 客户端过滤 = 服务端仍会收到不合法组合（现在靠服务端 400 兜底）。新功能应改为「服务端解析并返回每条 verdict」，客户端只渲染（§5.2）。

**④（P1 性能）批量提交是串行 + 固定 sleep，没有共享节流器。**
`execute115ShareTransfer` 等每个任务 `await sleep(600ms)`，串行（`offline/route.ts:279`）。10 条链接 = 6 秒 + 每次网盘 RTT。而 `storage-brands.ts` 已经有 `minApiIntervalMs` 与 `withBrandPacing`（123 = 1500ms），**离线路由完全没走它**。新功能应复用 `runKeyedPool`（`packages/workflow/src/storage/keyed-pool.ts`，按盘 key 的并发池）而不是另写循环。

**⑤（P1 逻辑）离线任务「提交成功」≠「已落盘」。**
`addOfflineTask` 返回 ok 只代表平台受理；磁力秒传通常秒级可见，但真下载要几分钟到几十分钟。前端提示语直接写「成功提交 N 个入库任务（N 个已完成）」（`apps/web/features/storage-drives/components/storage/storage-offline-modal.tsx:128`），**把「已受理」说成了「已完成」**。而 `StorageExecutor.transfer` 才有落盘轮询 + before/after diff。新功能若走「离线直提」，入库这个动作必须由后台 run 负责确认落盘（§4.3）。

**⑥（P1 安全）关键字检索没有任何限流维度。**
现有 `resourceLimiter` 按 `(accountId, titleId)` 冷却 60s（`apps/web/app/api/titles/resources/cache.ts:31`）。**没有 titleId 就没有这把锁**——同一关键字连点会直接把 PanSou 打爆（PanSou 实测 >4 并发就 502，`pansou-provider.ts:39` 已写明 `MAX_IN_FLIGHT_PER_SERVER = 2`）。必须新增「按 (account, 归一化关键字)」的冷却键。

**⑦（P2 逻辑）torrent 上传字段被接收但从未使用。**
`parseOfflineRequestBody` 接受 `torrentBase64`，`/api/storage/offline` 却**没有任何一条路径消费它**（grep 证实：只有 parse 与 error 分支）。前端 tab「BT 种子上传」因此是**假功能**——点了提交，`urls/shareTasks` 都为空，服务端会回「请提供至少一个有效的下载链接」。这点在调研中必须如实标注，不能顺手当成可用能力写进方案。

**⑧（P2 一致性）`manual_import` 的目标目录是「按 TMDB 身份算出」，不是「用户指定」。**
`manualImportTargetDirectory` 固定走 `ensureMediaLibraryDirectory` + `Season NN`（`manual-import-worker.ts:294`）。本需求要求「用户配置入库路径」，因此**必须新增一条携带显式目标目录的入库 kind**，而不是给 `manual_import` 加可选参数（那会让两种语义混在一个 kind 里，`blockIfTitleHasActiveRun` 也会互相误伤）。

---

## 3. 业界主流方案对比

| 方案 | 交互式搜索 | 手动入库落点 | 对「无作品身份」的处理 | 可借鉴点 | 不可直接照搬 |
| --- | --- | --- | --- | --- | --- |
| **Sonarr / Radarr** | Interactive Search：列出 release 列表（索引器、大小、seeders），用户点 Grab；搜索结果 20–30 分钟 TTL | **必须已有 series/movie 实体**：import 落在该实体的 quality profile 与 root folder 下 | 不支持「没有作品的手动入库」；无作品就要先 Add Series/Movie | ①结果 TTL + 服务端持句柄；②交互搜索与自动搜索共用同一 release 评估器 | 「必须先有实体」正是我们要绕开的前提 |
| **Overseerr / Jellyseerr** | 用户搜索 TMDB → 选片 → 发起 request；候选/详情与「是否已在库」解耦 | 只产出 request，真正的入库仍由 Sonarr/Radarr | 无作品不入库，仅发起请求 | ①未追踪作品的详情/候选是**一等公民**（不往订阅表注入假数据）；②请求有显式状态（pending/approved/available） | 它是「请求层」，不负责落盘 |
| **MoviePilot** | 手动搜索 +「手动选择资源」（配置可强制人工择优）；整理失败进**手动整理**，用户在 WEB 里指定目标 | 转存到下载目录后由整理器重命名/移动；可手动指定目标路径 | 手动下载**不要求已有订阅**（有独立手动下载入口） | ①「先算目标路径（预览）再执行」两段式；②整理失败转人工复核而非静默 | 插件式架构过重；我们没有它的「下载器」抽象层 |
| **OpenList / AList** | 无交互式搜索 | 直接把磁力/分享保存到**指定云端目录** | 天然无作品概念（纯文件管理） | 「目标目录是显式输入」这一点与我们需求完全同构 | 只做文件搬移，无媒体身份/入库语义 |
| **qbittorrent + 手工整理** | 种子列表 | 落到本地某目录，靠人整理 | 无身份 | — | 无云端直存能力 |

**结论**：业界把「作品身份」与「落盘目标」分成两层的做法是一致的（Sonarr: 实体→rootFolder；MP: 下载→整理目标；OpenList: 纯目标目录）。我们的需求等价于 **OpenList 的「显式目标目录」+ Sonarr 的「服务端持候选句柄 + TTL」+ MoviePilot 的「先预览后执行」**，而「作品身份」必须是**可选的、用户显式指认的**，不能是必填前置。

> 引用来源见文末。

---

## 4. 可行性、逻辑欠缺与性能推演

### 4.1 核心逻辑问题：没有 TMDB 身份怎么入库？

四种可选形态，按「最小改动、最大确定性」排序：

| 形态 | 做法 | 入库后的可见性 | 风险 |
| --- | --- | --- | --- |
| **A. 用户显式选 TMDB 作品（推荐默认）** | 检索框旁边给一个「绑定作品」选择器（复用现有 TMDB 搜索 `searchMedia`），用户选中后入库路径默认按 `Title (Year) {tmdb-N}` 预填，可覆盖 | 立刻出现在订阅墙与详情页，后续巡检/补缺全部生效 | 用户必须多点一次；但这是「入库」与「往盘上扔文件」的分界线 |
| **B. 无作品，纯目标目录（自由投放）** | 只选盘 + 目标目录，直接转存/离线 | 只出现在盘上文件树与影视库扫描结果里，**不进订阅墙** | 需要一条**不带 title/season 的 run 记录**，与现有 reservation 契约冲突（§4.2） |
| C. 自动猜作品（从候选标题解析） | 用 `parseTitleWithChain` 推 tmdbId | 同 A | 误判概率高（`parse-token-title`/`anitomy` 已装但候选标题噪声大），**猜错比不猜更糟**（写进错误作品目录） |
| D. 事后补绑 | 先用 B 落盘，再从影视库扫描结果里「绑定到作品」 | 延迟可见 | 两段操作，体验割裂 |

**决策建议**：默认 A，允许 B 作为「高级：只投放不建库」。C 明确排除——本仓的身份治理原则是「身份门必须显式」：`movie-admission.ts` 在转存前就拒掉「电影包里混入合集/原盘」，`2026-11-17-preview-false-positive-identity-gate-research.md` 也把「预览误判身份」当成事故级缺陷。自动猜作品会把错误静默写进库，而 `{tmdb-N}` 目录名一旦写错，后续巡检会持续往错的地方补缺。

### 4.2 逻辑欠缺：B 形态没有 run 记录的位置

现有 `resource_snapshots.workflow_run_id` 是 NOT NULL，且 reservation 必须给 `title/season`。两条路：

- **路 1（推荐）**：为 B 新增 `mediaTree` 拒绝——即 B 形态**不创建 workflow run**，而是复用 `/api/storage/offline` 的**同步提交**（本来就同步、本来就不写库）。B 的语义就是「往盘上扔」，与现有离线弹窗完全同构；唯一要加的是「提交后登记一条轻量投递记录」。这条记录可以落在新表 `ingest_submissions`（无外键到 title），或直接复用 `notifications`。
- 路 2：给 reservation 放宽 `title/season` 必填（需要 schema 迁移 + 校验函数改契约）——**不建议**：`validateWorkflowRunSnapshot` 是全局不变量，为一种边缘形态放松它，等于让所有 kind 都失去这层断言。

**A 形态则完全不需要新表**：它就是一个「候选已在、标题已选」的 `manual_import`，只是目标目录改为显式传入（§4.3 的新 kind 或参数）。

### 4.3 逻辑欠缺：离线提交的「已入库」判定

关键词检索出来的候选里，**magnet 与 115/123/光鸭分享链落盘路径不同**：

| 候选类型 | 落盘方式 | 「已入库」的可靠判定 |
| --- | --- | --- |
| 115 / 夸克 / UC / 天翼 / 123 / 光鸭分享链 | `receiveShare` / `saveShare` → 云端秒级出现 | 提交后**一次目录 diff**（`StorageExecutor.transfer` 已有 before/after 逻辑） |
| magnet / ed2k | `addOfflineTask` → 服务端拉取 | 必须**轮询落盘**（115 executor 的 `transfer` 已实现 `offlineMaterializeAttempts` + 任务状态查询） |

**所以**：任何「入库」动作都必须走 `StorageExecutor.transfer`（它已经按品牌把这两条路径都写完了），而不是走 `/api/storage/offline` 的裸提交。`/api/storage/offline` 只适合「B 形态：只投放，不承诺入库」。

### 4.4 性能推演

| 环节 | 现状成本 | 目标成本 | 手段 |
| --- | --- | --- | --- |
| 关键字检索 | PanSou 单次 10–25s，且前后多次轮询（`maxSearchAttempts = 4`、`searchPollMs = 2500`）→ 最长可达 ~30s | 不可压缩（PanSou 语义要求「等结果稳定」才不抢跑） | **只能做体验**：NDJSON 流式（`titles/resources/route.ts` 已有 `stream=1` 实现骨架）+ 前端渐进渲染 |
| 并发上限 | 每 PanSou 实例 2 并发、10 排队（已实现） | 不变 | 复用 `withServerSlot`；新入口**必须**共用同一个 provider 实例（同 `baseURL` 即自动共享） |
| 范围校验 | 每次 `guardWriteTarget` 可能触发 1 次目录列表 | 站长豁免 → 0 次 | 站长 `*` 直接 bypass（已实现） |
| 提交 N 条 | 现有串行 + 600ms sleep → 10 条约 6s+ | 按盘并发 2–3、共享 `withBrandPacing` | `runKeyedPool`（按 storageId 作 key）+ 品牌 `minApiIntervalMs` |
| 入库确认 | 分享链 1 次 diff；磁力需轮询（每次 2.5s × N） | 后台化，HTTP 不等 | `manual_import`-style 排队（worker drain 已有） |
| 库扫描联动 | 全量 `scanBinding` 很贵 | 只触发**绑定下的增量**或 STRM pinpoint | `MediaLibraryScanner` 的 `scanMode: incremental_missing` + `triggerPostIngestSyncIfSucceeded`（已存在） |

**结论**：主要性能风险不是「算得慢」，而是 **①重复搜索（无 title 冷却键）②串行提交 ③HTTP 等落盘**。三者都有现成手段，不需要新库。

### 4.5 额度与共用资源模式：两个会改变方案的领域约束

**额度**：`drive-api-quota.ts` 记录的平台语义是「转存类（`receiveShare` / 磁力秒传）无月限；http(s) 离线与直链解析、离线任务管理**有月限**；上传不计额」。因此关键字投放里：
- 分享链候选 → 基本免费，可放心批量；
- **magnet 若不在 115 缓存里就会变成真下载** → 吃月限。`transfer` 已经在秒传 miss 时删掉真下载任务（`deleteOfflineTasks`），但**提交前必须给用户提示「磁力可能消耗云下载配额」**，并按条展示「秒传/真下载」的判定结果（`addOfflineTask` 的 `alreadyTransferred` 字段已有）。

**共用资源模式（shared）**：`resolveStorageBindingAccountId` 已规定「共用资源模式下，只有站长有权添加或修改公共网盘」（`apps/web/lib/workflow-runtime.ts:456`）。这条现状让「只允许站长使用」**不是新增特权，而是与既有多用户设计一致**：投放目标是公共盘，成员不该有任意投放权。实现时要注意：读取凭据与 fileManager 必须用 `isSharedResourceMode() ? DEFAULT_ACCOUNT_ID : owner` 的解析，否则会拿到成员自己的空盘（`project-shared-resource-mode-read-scope` 记录过这个空盘/误拒缺陷）。

### 4.6 两个会静默出错的细节

**run id 前缀冲突**：检索快照的 run id 是 `search_${snapshotId}`（`resourceSearchRunId`），而 snapshotId 由 provider 内容哈希生成。若 owner ingest 复用同一前缀，**两个用户/两次检索的相同结果会撞 `resource_snapshots.id` 全局主键**（该表 `id text PRIMARY KEY`，`ON CONFLICT DO NOTHING` 会静默丢失第二份）。必须用独立前缀（如 `owner_ingest_${searchRunId}`），并且 `searchRunId` 含账号与时间。

**记录保留期与 TTL 不匹配**：`FINISHED_RUN_RETENTION_MS = 30 天`，由 `pruneFinishedWorkflowRuns` 清理（`packages/workflow/src/persistence/repository.ts:3012`）。候选 TTL 只有 30 分钟，所以「检索记录被清理」永远发生在候选过期之后——**不是问题**，但反过来要注意：不要指望用「重放 searchRunId」做幂等，检索记录会在 TTL 后被清理。

---

---

## 5. 设计模式与具体方案

### 5.1 分层（Adapter + Strategy + State Machine）

```
UI（站长专用页面 /owner/ingest 或 /storage/ingest）
  ├─ KeywordSearchPanel        关键字 → 服务端解析 → 候选列表（不透明句柄）
  ├─ TargetPickerPanel         盘选择 + RemoteFolderPickerModal（可视化目录）
  └─ SubmissionTracker         逐条状态徽章（queued/submitting/landed/failed）
          │
          ▼  POST /api/owner/ingest/search   （NDJSON 或 JSON）
          ▼  POST /api/owner/ingest/submit   （批量，返回每条 verdict + runId）
          ▼  GET  /api/owner/ingest/status?id= （轮询/SSE）
          │
──────────────────────── 服务端 ────────────────────────
IngestOrchestrator（新，application 层）
  ├─ 解析：reuse ingest-protocol-router（服务端侧）
  ├─ 路由：getIngestCapabilities(provider) ← 从 STORAGE_BRANDS 派生（单一真相）
  ├─ 搜索：ResourceProvider.search(keyword)（复用，含冷却/缓存）
  ├─ 提交：StorageExecutor.transfer（复用，含落盘确认）
  └─ 记录：owner_ingest run（A 形态）或 ingest_submissions（B 形态）
```

**适配器（Adapter）**：网盘品牌层不新增抽象。**能力表收回注册表**（§5.3），`/api/storage/offline` 的 5 条 `if` 换成注册表读取。

**策略（Strategy）**：`IngestRouteStrategy` 按「候选类型 × 盘品牌」选择投送方式。**注意不要新建第三份 if 链**——策略注册表的数据源必须是 `STORAGE_BRANDS.resourceProviderKinds` + 一个**可执行能力**字段（见 §5.3 的 `ingest` 声明）。

**状态机（State Machine）**：入库提交本身是一个显式迁移，复用 `xstate`（已在依赖中）：
`scheduled → validating → submitting → awaitLanded → recording → landed | failed(→compensate)`。
但**更省的做法**是直接用现有 `library-scan-job.ts` 那套「纯迁移表 + DB SSOT」范式（它已经跑通、已有 SSE 加速通道），避免为一个新流程再起一套 xstate。**推荐后者**：`ingest_submissions` 表 + 迁移表 + SSE，与现有运维心智一致。

### 5.2 接口草案

```
POST /api/owner/ingest/search
  body: { keyword: string, storageIds?: string[], limit?: number }
  → { searchRunId, candidates: [{ candidateId, title, type, source, sizeBytes? }] }   // 无 providerPayload
POST /api/owner/ingest/submit
  body: { searchRunId, items: [{ candidateId }], target: { storageId, directoryId } | { storageId, title?... } }
  → { submissions: [{ submissionId, candidateId, verdict: "queued"|"rejected", reason?, runId? }] }
GET  /api/owner/ingest/status?searchRunId=
  → [{ submissionId, status, phase, landedFileIds?, error? }]
```

要点：
- **权限**：`requireOwner`（新守卫，复用 `resolveCurrentIsOwner` 与 `gate.isMaster`）。**不**用 `storage:transfer`——那个钥匙成员也有（决策 2），而本需求明确「只允许站长」。同时 `*` 也不能免：成员若能自建自定义角色拿到 `*`，也不能用这条。
- **句柄**：candidateId 仍是不透明句柄；payload 从落库快照取回（复用 `resourceSearchRunId` 机制，但需要一个新的 run id 前缀 `owner_ingest_<searchRunId>`，避免与 `search_<snapshotId>` 冲突）。
- **批量 verdict**：服务端对每条给 `queued/rejected(reason)`，前端不再自行过滤（修复 §2.2-③）。
- **幂等**：同一 `candidateId` 在同一 `searchRunId` 重复提交 → 返回 `already_submitted`，不重投。

### 5.3 单一真相：把 ingest 能力收回注册表

在 `StorageBrand` 增加一个**必填**字段（与 `create` 同理：漏声明 = 编译错误）：

```ts
ingest: {
  offlineSchemes: string[];        // ["magnet","ed2k","http","ftp"]  等
  shareBrands: string[];           // 可转存的分享品牌（自己 + 同族）
  supportsTorrentFile: boolean;    // 是否真的消费 torrentBase64
}
```

然后：
- `/api/storage/offline` 的 `executeBrandOfflineTask` / `executeBrandShareTransferTask` 改为 `getStorageBrand(provider).ingest` 驱动；
- `ingest-protocol-router.ts` 的 `DRIVE_INGEST_CAPABILITIES` 改为 `fromStorageBrands()` 派生（保留作为纯函数层，但不得手写第二份数据）；
- **新增门禁**：`storage-registry.test.ts` 增加「ingest 声明 ↔ 分发分支一致性」双向断言（声明了没分支 = 必失败；分支了没声明 = 前端藏起来）。同现有 `supportsSubtitleDirectLink` 的双向断言范式。

顺带修掉 §2.2-② 的 UC 缺口（注册表补 uc 分支，或明确声明 uc 不支持转存）。

### 5.4 目标目录：可视化 + 范围

- 复用 `RemoteFolderPickerModal`（可视化）与 `IngestDestinationPicker`（快捷分类 + 高级 CID）。
- **必须**复用 `guardWriteTarget`：站长豁免，但**A 形态的「按作品入库」仍应校验目录在库里**（避免把作品文件扔到库外导致扫描看不到）。
- 「先预览后执行」：提交前调一个 `preview-target` 返回最终路径（`Title (Year) {tmdb-N}/Season NN` 或用户指定路径），用户确认后才真正提交——对应 MoviePilot 的两段式与决策「planned moves 预写 + 执行后比对」。

### 5.5 入库后的联动

- A 形态：成功 → `triggerPostIngestSyncIfSucceeded`（已有）+ 可选轻量「增量扫描」该 library 的绑定（`scanBinding` 的 `incremental_missing`）。
- B 形态：只登记投递记录 + 提示「到影视库页扫描」。**不做自动扫描**（B 本来就是「绕过库」的语义）。

---

## 6. 现成库与基础设施复用清单

| 需求 | 复用 | 是否需新增依赖 |
| --- | --- | --- |
| 关键字检索 | `PanSouResourceProvider` / `CompositeResourceProvider` / `SearchProviderRegistry` | 否 |
| 结果去重/合并 | `buildMergedSearchSnapshot`、`toCandidateViews` | 否 |
| 候选 TTL/成员校验 | `resolveManualImportCandidate`、`resourceSearchRunId` | 否 |
| 后台化 | `reserveWorkflowRun` + `claimNextQueuedRun` + `runQueuedManualImport`（范式） | 否 |
| 落盘确认 | 各品牌 `StorageExecutor.transfer`（含磁力轮询） | 否 |
| 提交并发/限速 | `runKeyedPool`、`withBrandPacing`、`storage-brands.minApiIntervalMs` | 否 |
| 状态机 | `library-scan-job.ts` 迁移表 + DB SSOT + SSE；`xstate` 也可 | 否 |
| 目录可视化 | `RemoteFolderPickerModal`、`/api/storage/files` | 否 |
| 范围守卫 | `guardWriteTarget`、`bypassesLibraryScope` | 否 |
| 标题解析（备选 C） | `parseTitleWithChain`、`parse-torrent-title`、`anitomy`（已装） | 否 |
| NDJSON 流式 | `titles/resources` 的 `createResourceNdjsonStream` | 否 |
| 权限 | `requirePermission` + `SecurityContext.isMaster` | 否（新增 requireOwner 守卫，非依赖） |

**结论：零新依赖。** 唯一需要「新写」的是：一个 owner-only 守卫、一个 owner ingest 服务（编排）、一个新表（B 形态投递记录）或复用 notifications、以及把能力表收回注册表。

---

## 7. 门禁与回归测试（同类问题不复发）

| # | 门禁 | 形态 | 守什么 |
| --- | --- | --- | --- |
| G1 | 路由/页面权限清单 | 更新 `route-permission-table.ts` + `page-permission-table.ts`，并加断言：`/api/owner/ingest/*` 源码里必须真的调用 `requireOwner`（AST 字面量） | 防「藏按钮不关接口」与「新页漏守卫」 |
| G2 | 非站长拒绝 | 单测：member/admin/apiKey 请求 → 403；owner → 200 | 防「只允许站长」被实现成 UI 隐藏 |
| G3 | 能力表单一真相 | `storage-registry.test.ts` 双向断言：`brand.ingest` ↔ 分发分支一致；前端能力表必须由注册表派生（禁止第二份字面量） | 防 §2.2-② 的漂移复发 |
| G4 | 客户端不判定 | 静态门禁：owner ingest 客户端组件不得 import `ingest-protocol-router` 的判定函数（只可渲染服务端 verdict） | 防 §2.2-③ |
| G5 | 无 title 冷却毒化 | 单测：同 keyword 60s 内第二次 → 429 + `retryAfterMs`；源故障时退还冷却 | 防 §2.2-⑥ |
| G6 | 落盘才算入库 | 集成：分享链需要 diff、磁力需要轮询；「提交成功但未落盘」必须为 `awaitLanded` 而非 `landed` | 防 §2.2-⑤ 的错误文案回归 |
| G7 | torrent 字段 | 若注册表声明 `supportsTorrentFile: true`，必须有消费路径测试；若为 `false`，前端 tab 隐藏 | 防 §2.2-⑦ 的假功能 |
| G8 | reservation 契约不被放松 | 静态断言：`validateWorkflowRunSnapshot` 的 title/season 断言仍在；A 形态必须带 title，B 形态不得走 reservation | 防「为边缘形态放松全局不变量」 |

---

## 8. 分阶段实施建议

1. **阶段 1（能力收口，无 UI）**：`StorageBrand.ingest` 字段 + 分发改造 + UC 缺口修复 + G3 门禁。这一阶段**不新增任何功能**，只是把已有的两处 if 链合并成一处——风险低、收益立即可见（UC 盘恢复可用）。
2. **阶段 2（owner 守卫 + 搜索端点）**：`requireOwner`、`POST /api/owner/ingest/search`（NDJSON）、`(account, keyword)` 冷却、G1/G2/G5。
3. **阶段 3（提交 + 状态）**：`POST /api/owner/ingest/submit` + 迁移表 + SSE + `runKeyedPool`；A 形态走 `manual_import` 参数（显式目录）、B 形态走同步离线提交 + `ingest_submissions`；G4/G6。
4. **阶段 4（可视化）**：站长专用页面（或 `/storage` 下的「关键字投放」tab）+ `RemoteFolderPickerModal` + preview-target 两段式；G7。
5. **阶段 5（联动）**：A 形态增量扫描/STRM 联动；B 形态提示。

---

## 9. 明确不做 / 明确排除

- **不做自动猜作品**（C 形态）：身份误判的代价高于省一次点击。
- **不放松 `validateWorkflowRunSnapshot`**：为 B 形态改全局契约是错误方向。
- **不在 HTTP 请求里等落盘**：磁力可能几十分钟。
- **不新增第三份能力表**：现有两处 if 链已经是缺陷源，再加一处就是第三次复发。
- **不把 torrent 上传当作已可用**：要么实现消费路径，要么在注册表里声明 false 并把 tab 隐藏。

---

## 10. 参考来源

- MoviePilot 官方站与 wiki（手动搜索/手动整理/预览目标路径）：https://movie-pilot.org/ ，https://wiki.movie-pilot.org/reorganize ，https://wiki.movie-pilot.org/configuration
- MoviePilot 网盘订阅插件文档（多网盘调度/整理）：https://github.com/odomu/MoviePilot-Plugins/blob/main/docs/cloudsubscribe.md
- Sonarr/Radarr 交互式搜索与 Completed Download Handling（manual import 必须已有实体）：https://wiki.servarr.com/sonarr/system ，https://help.rapidseedbox.com/en/articles/6832517-getting-started-with-sonarr-2025-update
- Sonarr 交互式搜索里「手动搜索词」的历史诉求（说明其搜索词与实体绑定）：https://github.com/Sonarr/Sonarr/issues/3822
- OpenList/AList 离线下载与「指定云端目录」语义：https://doc.oplist.org/guide/advanced/offline-download ，https://doc.oplist.org/guide/drivers/115
- 本仓历史调研（同题复用结论）：`docs/architecture/subscription-page-and-manual-import-plan.md`、`docs/architecture/untracked-title-resource-snapshot-and-inspection-governance-spec.md`、`docs/research/2026-10-27-moviepilot-architecture-survey.md`、`docs/research/2026-10-27-media-automation-architecture-survey.md`

---

## 11. 实施记录（2026-11-17）

### 11.1 落地清单

| 阶段 | 交付 | 位置 |
| --- | --- | --- |
| 1 能力收口 | `INGEST_CAPABILITIES` 能力表（`satisfies Record<string, IngestCapability>`）+ `getIngestCapability` / `isOfflineSchemeAllowed` / `allowedResourceTypesForKinds` / `brandsSupportingTorrentFile`；`StorageBrand.ingest` 必填字段引用该表；UC 盘补齐分享转存路径 | `packages/workflow/src/storage/ingest-capabilities.ts`、`storage-brands.ts` |
| 1 分发收口 | 5 条 `if (provider === …)` 换成 `OFFLINE_HANDLERS` / `SHARE_HANDLERS` 两张品牌表；能力预检在任何 API 调用之前执行；**U 盘不再被判未知网盘** | `apps/web/features/storage-drives/application/brand-ingest-executors.ts` |
| 1 路由瘦身 | `/api/storage/offline` 只做 HTTP（`resolveSubmitContext` 抽解析/定位/种子门）；GET 不再顺带拉 115 离线任务（能力查询不再依赖上游可达性） | `apps/web/app/api/storage/offline/route.ts` |
| 1 前端不判定 | `ingest-protocol-router` 删除手写能力表，改从注册表派生；`parseBatchIngestInput` 接受服务端能力视图；候选预览与提交判定同源 | `apps/web/features/storage-drives/core/ingest-protocol-router.ts` |
| 2 站长守卫 | `requireOwner`（`roleId === "role_owner" && isMaster` 且拒绝 API Key）+ `contextIsOwner` 纯函数 | `apps/web/platform/next-context/owner-guard.ts` |
| 2 检索端点 | `POST /api/owner/ingest/search`（纯关键字、`(account, 归一化关键字)` 60s 冷却、30 分钟缓存、空结果不缓存、源故障退还冷却） | `apps/web/features/storage-drives/application/owner-ingest-service.ts` |
| 3 独立 kind | `owner_ingest`（episode-preserving、有 queue claimer、不拥有 tracking、janitor 等待）；`syntheticOwnerIngestTitle`（id 不用 `tmdb_` 前缀、tmdbId=0 哨兵） | `packages/workflow/src/execution/owner-ingest-command.ts` |
| 3 worker | 复核候选成员与 TTL（同一 resolver）、目标目录来自 run 审计记录、**只认 `transfer` 的落盘结论**、仅绑定真实作品时触发 post-ingest sync | `packages/workflow/src/execution/owner-ingest-worker.ts` |
| 3 端点 | `POST /api/owner/ingest/submit`（范围守卫 + 逐条 verdict）、`GET /api/owner/ingest/status`（DB 为唯一事实源） | `apps/web/app/api/owner/ingest/*` |
| 4 页面 | `/storage/owner-ingest`（`OwnerPageGuard` 包裹子树、非站长根本不触发数据读取）+ 控制台（检索/勾选/目录下钻/逐条状态）+ `/storage` 入口（`access.isOwner` 才渲染） | `apps/web/app/storage/owner-ingest/page.tsx`、`owner-ingest-console.tsx` |

### 11.2 顺手修掉的既有缺陷

1. **UC 盘 ingest 缺口**：注册表有 `uc`，前端能力表与服务端分发都没有它 → 现在同族通道共用 `shareCloudFamily`，`detectProtocol` 把 `drive.uc.cn` 判为 `uc` 而不是 `quark`。
2. **「已受理」冒充「已完成」**：弹窗文案改为「已被网盘受理」，并明确后续落盘在「活动」里看。
3. **BT 种子上传是假功能**：`supportsTorrentFile` 全 false → 服务端显式 400、前端 tab 隐藏（此前会一点提示都没有地回「请提供链接」）。
4. **能力查询耦合上游**：GET 不再调用 115 `listOfflineTasks`（该字段前端从未渲染，却会让上游超时拖慢弹窗）。
5. **123 盘的 `https` 误归类**：`offlineSchemes` 只列磁力/ed2k——裸 https 会偷走 123 分享链。

### 11.3 门禁（全部落地并通过）

- **G1** 路由清单：`OWNER_ROUTES` 归类 + AST 断言「真的 import 并调用 `requireOwner`」，并**反向断言不得用 `requirePermission` 冒充**；ESLint `local/api-auth-required` 新增 `OWNER_PATTERN` 分支（漏 requireOwner 直接红）。
- **G1b** 页面清单：`PAGE_PERMISSION_TABLE` 新增 `ownerOnly` 语义 + 断言「必须渲染 `OwnerPageGuard`，且不得同时声明权限点」。
- **G2** 站长判定：五个反例（成员 / 管理员 / 带 `*` 的自定义角色 / API Key / 未登录）全部为 false。
- **G3** 能力单一真相：注册表 ↔ 能力表键一一对应、「声明支持离线 ⇔ 有协议」「声明支持转存 ⇔ 有分享品牌」「分享品牌必须是已登记品牌」「ingestCapabilityForBrand 与条目一致」「无品牌声明种子上传」。
- **G4** 客户端不判定：`ingest-protocol-router` 不再持有能力字面量（改由注册表派生）。
- **G5** 冷却：同关键字 60 秒内重复检索 429；源故障退还额度；30 分钟缓存只缓存非空结果。
- **G6** 落盘才算入库：worker 测试断言 `accepted_pending` → `failed`；落盘成功才写 `owner_ingest_landed`。
- **G7** torrent：`brandsSupportingTorrentFile()` 必须为空；路由对 `torrentBase64` 显式 400。
- **G8** 契约不放松：`validateWorkflowRunSnapshot` 未改；投放记录缺少目标目录 → `invalid_run` 且**不调用 transfer**。

### 11.4 验证结果

- `npm run lint`（`--max-warnings 0`）通过；`tsc` 双项目通过。
- 单元测试：`storage-drives` / `storage` / `persistence` / `owner-ingest-*` / `page-auth-inventory` / `route-auth-inventory` 全部绿。
- 静态门禁：`gate:limits`、`gate:style`、`gate:contracts`、`gate:deps`、`gate:inspection` 等 27 项全部 PASS（`gate:limits` 按既有棘轮策略对存量增长做 re-baseline）。
- **Dev 3020 实机验收已做**（见 §11.5）。

### 11.5 Dev 3020 实机验收记录（2026-11-17）

部署：`deploy-remote.ps1 -Mode Dev -SyncMethod Direct`（生产 3000 全程未动）。

#### 11.5.1 实机发现并修复的两个缺陷

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 第一次投放后 drain 每轮报 `Agent decision referenced unknown resource snapshot owner_ingest_acct_default_…`，run 永远排队 | 检索记录已以 `owner_ingest_<searchRunId>` 占用了 `resource_snapshots.id`（全局主键，`ON CONFLICT DO NOTHING`）；投放 run 沿用同一 id → 插入被静默丢 → 决策引用悬空 → 校验抛错 | 新增 `rebaseOwnerIngestSnapshot`：投放 run 的快照 id 与候选 id 都带本次 run，决策同步改写；检索记录原样保留，其余候选仍可各自投放 |
| 2 | 修复 1 之前产生的脏 run 恢复后**永远停在 `running`**，持续持有标题锁 | `failRun` 的终态写入同样走校验，于是「校验失败 → 抛 → 仍是 running → 下次再试」死循环 | 终态写入分级：先按原样写；若被拒，退化为**只写终态**（run 的终态比子表完整性更重要），并打日志 |

两条都补了单测（`rebaseOwnerIngestSnapshot` 3 条、`failRun 终态必须落地` 1 条）。

#### 11.5.2 验收结果

| 检查项 | 结果 |
| --- | --- |
| 首页 / `?tab=library` / `/library` / `/activity` / `/notifications` | 均正常渲染，无页面级报错 |
| `/storage` 出现「关键字投放」入口 | ✅（站长可见；生产 3000 未部署该功能，仍无入口） |
| `/storage/owner-ingest` 站长可见 | ✅ |
| 关键字检索（`奥本海默` / `奥本海默 1080p` / `葬送的芙莉莲 1080p`） | ✅ 返回 20 / 9 / 2 条候选；同关键字二次检索命中缓存（`cached: true`） |
| 空关键字点检索 | ✅ 前端提示「请输入检索关键词」，不打网络 |
| 可视化目录下钻（根 → Mediary Scout → Movies/TV） | ✅ 目标路径正确回填 `/Mediary Scout/Movies` |
| 提交到**根目录**（越界） | ✅ `failed`，原因 `WRITE_SCOPE_VIOLATION: cid=0; path=根目录`（范围守卫真的在生效） |
| 提交电影到 `Movies` | ✅ `succeeded`，`landedFileCount: 1`；盘上出现 `奥本海默.Oppenheimer.1080p.BluRay.x264.AAC.双语字幕-深影字幕组.mp4` 目录，内含 5.65 GB 正片 |
| 提交剧集到 `TV` | ✅ `succeeded`，`landedFileCount: 28`；盘上 `葬送的芙莉莲 (2023)/Season 1` 落 84 个文件（含 S01E01–E28 的 mkv/nfo/thumb） |
| 重复投放同一候选 | ✅ 返回 `already_running`，不重复写盘 |
| 离线弹窗能力条 | ✅ 115 显示「分享秒级转存 + 云端离线（MAGNET/HTTP/HTTPS/FTP/ED2K）」 |
| BT 种子 tab | ✅ **禁用 + 提示「当前网盘不支持 BT 种子解析」**（假功能已消失） |
| 服务端对 `torrentBase64` 显式提交 | ✅ 400「暂不支持 BT 种子上传」 |
| 跨品牌分享链（夸克链投到 115 盘） | ✅ 400「【115网盘】不能接收quark的分享链接」 |
| UC 链识别 | ✅ 提示「该链接属于【UC网盘】」——不再是「未知网盘」 |
| 混合批量解析（UC + 磁力 + 夸克 + 115） | ✅ 2 可用 / 2 不匹配，逐条给出原因 |
| 检索记录不存在时提交 | ✅ 404 |
| 提交体缺字段 | ✅ 400 |
| 不存在的 runId 查状态 | ✅ 200 + 空数组（fail-closed 不泄露） |
| 生产实例 3000 | ✅ 无「关键字投放」入口，服务正常 |

#### 11.5.3 已知环境噪声（非本次功能问题）

- 115 开放平台 OAuth 在 dev 容器被 `PAN115_OAUTH_REFRESH_DISABLED=1` 主动禁用（避免与生产轮换冲突），日志会持续打印 `code=409 … re-authorize on the instance that owns the refresh token`，执行器自动回落到 Cookie 通道——投放实际走 Cookie 通道并成功落盘。
- `apps/updater` 的 12 条脚本测试在 Windows 下失败（POSIX 权限位 / bash tag 校验），与本功能无关（该目录零改动）。

### 11.6 第二轮 Dev 3020 实机验收（2026-11-17 晚间）

本轮用 `scripts/deploy-remote.ps1 -Mode Dev` + 内置浏览器对「关键字投放」与 STRM 播放做了端到端复核，
并发现两个与部署/基址相关的缺陷（详见 `docs/postmortems/strm-manual-scan-baseurl-overwrite-and-dev-sync-exclude.md`）。

**投放链路（全部实测通过）**

| 步骤 | 实测 |
| --- | --- |
| 检索「三体」 | 200，`count: 97`（含磁力/115 分享） |
| 同关键字二次检索 | 200 + `cached: true`（30 分钟缓存命中，不消耗冷却） |
| 新关键字连点第二次 | 429 + `Retry-After: 48`，前端提示「还需等待 N 秒」（本轮新增） |
| 检索不存在网盘 | 404「未找到该网盘」 |
| 提交不存在的候选 | 200 + 逐条 `rejected / not_found`（不是整单失败） |
| 提交不存在的 searchRunId | 404「检索记录不存在或已过期」 |
| 查询不存在的 runId | 200 + 空数组（fail-closed 不泄露） |
| 勾选 1 条 → 投放 | 排队 → 「转存中」→ **已落盘 · 8 个文件**（`status` 来自 `workflow_runs`） |
| 目录选择器 | 下钻 `/Mediary Scout/Movies`，选中后回填 `/Mediary Scout/Movies` |

**回归修复（同一轮发现）**

1. **手动扫描改写播放基址**：`/api/strm/tasks/[id]/run` 曾把 `nextUrl.origin`（容器内 `localhost:3000`）
   作为显式 baseUrl，优先级压过 DB/env；一次点击把 178 个正确 `.strm` 全改写。已改为只走 SSOT。
2. **Dev 直推剔除 `[id]/run` 路由**：`tar --exclude=run` 匹配任意层级，远端路由停在 11-13 旧版；
   已把 `/run`、`/data`、`/env` 锚定到仓库根。
3. 修复后全库 1138 个 `.strm` 基址 **100% 为 `http://192.168.1.100:3020`**（localhost/127 各 0）；
   真实 token Range 请求 `206 / video/x-matroska`，伪造 token `401`。

两项缺陷均已加成门禁（`check-strm-playback.mjs` 的 `checkManualScanBaseUrlSso` / `checkDevSyncExcludes`），
`npm run lint` / `typecheck` / `gate` 全绿。

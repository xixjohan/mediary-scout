# 巡影 · 资源提供商多源化 / 手动选材入库 / 订阅化 调研与落地方案

> **文档位置**：`docs/provider-abstraction-manual-mode-and-subscription-plan.md`
> **编写时间**：2026-10-27
> **配套调研**（本文引用其结论，不重复其内容）：
> - [docs/research/2026-10-27-media-automation-architecture-survey.md](research/2026-10-27-media-automation-architecture-survey.md) —— Sonarr/Radarr、qBittorrent、Seerr、rclone、Alist 横向调研
> - [docs/research/2026-10-27-moviepilot-architecture-survey.md](research/2026-10-27-moviepilot-architecture-survey.md) —— MoviePilot 源码级调研（订阅模型 / 手动选种 / 存储适配器 + 能力声明 / Outbox）
> - [docs/library-selection-survey-2026-10-27.md](library-selection-survey-2026-10-27.md) —— 库选型，npm/GitHub API 实测数据
> **本文定位**：把上面两份外部调研，落到**本仓库当前代码的真实状态**上，回答两个具体问题，给出可 TDD 的分阶段方案。
> **标注约定**：【事实】= 已读代码/官方文档核实；【推断】= 基于事实的推理；【未查证】= 无可靠来源。

---

## 0. 结论先行

### Q1：资源提供商能否用适配器/策略模式支持多类型服务？

**能，而且大部分已经建成了。** 缺的不是模式，是**收拢**：

| 已有资产 | 位置 | 状态 |
|---|---|---|
| `ResourceProvider` / `StorageExecutor` 端口接口 | [packages/workflow/src/ports.ts](packages/workflow/src/ports.ts) | 生产使用 |
| `CompositeResourceProvider`（多源并行 + 合并） | [composite-provider.ts:18](packages/workflow/src/composite-provider.ts#L18) | 生产使用 |
| `FallbackResourceProvider` + 每源健康度 | `fallback-provider.ts`、`resource-source-health.ts` | 生产使用 |
| `STORAGE_BRANDS` 数据驱动品牌注册表（5 家） | [storage-brands.ts:78](packages/workflow/src/storage-brands.ts#L78) | 生产使用 |
| `createExecutorForBrand` 工厂（按 provider 分发） | [storage-executor-factory.ts](packages/workflow/src/storage-executor-factory.ts) | 生产使用 |
| 能力门控（`transferSubtitleUrl?` 可选方法） | `ports.ts` | 生产使用 |

**真实缺口只有两个**：

1. **注册表与工厂是两套**。品牌元数据在 `STORAGE_BRANDS`（数据），executor 构造在 `storage-executor-factory.ts` 的 `if (input.provider === "pan115") …` 链里（代码，5 个分支）。加一家网盘要改两个地方，且工厂的 if-else 不受 `STORAGE_BRANDS` 约束——**登记了品牌却没有 executor 是可能的静默失败**。全仓库另有 **7 处**散落的 `provider === "pan115"|"quark"|"tianyi"` 硬判。
2. **搜索提供方是 env 开关，不是注册表**。`MEDIA_TRACK_SEARCH_PROVIDER` 在 3 个文件里被直接读来分叉（[apps/web/lib/search-page.ts](apps/web/lib/search-page.ts) 3 处、`workflow-runtime.ts` 4 处、`title-hub.ts` 1 处）。加一个搜索源要改 3 个文件。

**结论**：这是「把已有的两套机制合并成一套」的重构，不是从零适配器化。预计改动集中在 2 个文件 + 7 处硬判收拢。

### Q2：搜索能否加模式选择（全自动 / 手动）？

**能，而且手动模式在设计文档里早就写好了，只是从来没实现。**

- [docs/workflow-product-architecture.md:287](workflow-product-architecture.md#L287) 明确列出了 `ManualLinkProvider`：*"Let users provide links they already have permission or intent to use."*
- 代码里 `ResourceType` 已经包含 `"manual"` 这个成员（[domain.ts:56](packages/workflow/src/domain.ts#L56)）——**类型预留了，实现没有**。
- 仓库里**已经有一条生产可用的「用户勾选文件 → 确定性入库」流程**：[`importForeignWorkAsMovie`](packages/workflow/src/commands.ts#L423)，前端在 [foreign-work/[workflowRunId]/page.tsx:78](apps/web/app/foreign-work/[workflowRunId]/page.tsx#L78)。它的注释写得很清楚：*"The recognition agent only FLAGS a file as belonging to a different title; naming the destination and pulling the trigger is the user's decision."*

**所以手动模式不是新子系统，是泛化一条已验证的流程。**

MoviePilot 的调研为这个判断提供了外部佐证【事实】：MP 的手动下载入口是 `POST /api/v1/download {media_in, torrent_in, downloader?, save_path?}`，内部走 `DownloadChain().download_single(context, source="Manual")`——**与订阅自动下载是同一个入口，只差 `source` 标记**。也就是说「手动选种」和「自动订阅」收敛到同一执行链，是这个领域已验证的建模，不是我们的发明。

### 关于订阅

订阅的雏形已经有了：`tracked_seasons`（= 订阅目标）+ [`runScheduledType3Monitoring`](packages/workflow/src/worker.ts#L588)（= 调度器）+ `type3_monitor`（= 执行器）+ `replace_request` / `user_messages`（= 重试与人工干预）。**缺的是显式的策略层与黑名单层**，不是缺一个 `subscription.status` 状态机——后者是调研中反复警告的陷阱（见 §4.2）。

### 关于日志页

**数据已经全在库里了**，缺的只是 UI 与查询接口。[`agent_steps`](packages/workflow/src/sqlite.ts#L1387) 表记录每一次工具调用（`ordinal / toolName / args / activity / phase / apiCalls / at`），`agent_decisions` 记录每次决策。`repository.listAgentSteps` 已实现且带 scope 门控（[repository.ts:324](packages/workflow/src/repository.ts#L324)）——**但全仓库没有任何前端消费它**。这是纯 UI 缺口。

---

## 1. 现状盘点（代码级证据）

### 1.1 三层划分早已定义，且已被代码印证

[workflow-product-architecture.md](workflow-product-architecture.md) 提出的三分法，今天在代码里是成立的：

```
metadata source        → TMDB（回答"这是什么片"）      tmdb-provider.ts
resource index source  → PanSou / Prowlarr（"哪有资源"） pansou-provider.ts / prowlarr-provider.ts
acquisition executor   → 115/夸克/天翼/123/光鸭（"怎么落地"） storage-*-executor.ts
```

这个划分是本文所有建议的地基：**手动模式改的是中间层，订阅改的是驱动层，两者互不污染。**

### 1.2 当前用户旅程：从"选片"到"入库"全程无人工介入

实测当前交互链（[search-form.tsx](apps/web/components/search-form.tsx) → [search-view.ts:8](packages/workflow/src/search-view.ts#L8)）：

```
用户输入片名 → TMDB 搜索 → 列表（SearchActionState:
  can_request / already_tracked / active_workflow / can_reserve / reserved）
→ 点"获取" → 【此后的搜索/挑选/转存/整理全部由 agent 自动完成】
→ 用户只在结果页看到"已获取 S01E06，仍缺 S01E07"
```

**用户从来没见过真实的资源**——分享链接、磁力、文件夹名，一样都没见过。这就是"全自动模式"的确切含义，也是手动模式要插入的那个断点。

### 1.3 关键资产：`CandidateRegistry` 已经铺好了人机同构的路

[candidate-registry.ts:11](packages/workflow/src/acquisition-v2/candidate-registry.ts#L11) 的设计注释：

> *"the V2 interfaces … carry only the fields the AGENT judges from (id/title/hints) — NOT the raw share url. The registry is the side channel that keeps each observed candidate's full ResourceCandidate (with providerPayload) so the storage adapter can transfer it by id. The agent never sees raw urls; the system resolves them."*

**这句话是手动模式的架构钥匙**：系统早就把「选择者只看到 id+标题」和「完整 URL 走侧信道」分开了。LLM 是今天的选择者；**把选择者换成人，接口一行不用改**。

同理，[domain.ts:234](packages/workflow/src/domain.ts#L234) 的 `CandidateDispositionKind = "selected" | "rejected" | "uncertain"` 已经为"人不确定"预留了取值。手动模式本质是：**把 `uncertain` 从"agent 自己记一笔"升级为"推给人，人给答案"。**

### 1.4 缺口清单

| # | 缺口 | 位置 | 影响 | 严重度 |
|---|---|---|---|---|
| G1 | 品牌注册表与 executor 工厂两套机制 | `storage-brands.ts` vs `storage-executor-factory.ts` | 加网盘改两地；登记品牌无 executor 会静默失败 | 中 |
| G2 | 7 处散落的品牌硬判 | 全仓库 | 新品牌漏改即走错分支 | 中 |
| G3 | 搜索提供方 env 分叉 3 文件 8 处 | `search-page.ts`/`workflow-runtime.ts`/`title-hub.ts` | 加搜索源改 3 文件 | 中 |
| G4 | `ManualLinkProvider` 未实现 | — | 用户无法粘贴自己的链接 | **高（本次核心）** |
| G5 | 无"搜索→人选文件夹/文件→入库"流程 | — | 手动选材完全不可用 | **高（本次核心）** |
| G6 | 无显式订阅策略层（过滤/冷却/质量） | — | 订阅只能全有全无 | 中 |
| G7 | 无黑名单/拒绝记录表 | `rejected_resources` 有雏形 | 换源请求会反复推同一个坏源 | 中 |
| G8 | `agent_steps` 无 UI 消费 | 前端 | 排障只能看文件日志 | 中 |
| G9 | `StorageExecutor` 无取直链能力 | `ports.ts` | STRM/302 播放路线被堵死 | 低（后续） |
| G10 | `sys_queue_jobs` 无停滞任务回收 | `sqlite-queue.ts` | 崩溃后 locked 任务永久卡死 | **高（稳定性）** |

---

## 2. Q1 方案：统一注册表

### 2.1 目标形态

把「品牌元数据」和「executor 构造」合并成**一张自洽的注册表**，让"加一家网盘 = 加一个条目"：

```ts
// packages/workflow/src/storage-registry.ts（示意，非现有代码）
interface StorageDriverEntry {
  provider: string;
  label: string;
  authKind: "cookie" | "token";
  /** 构造 executor；缺省即视为"该品牌已登记但未接线"——显式抛错而非静默降级 */
  create: (input: DriverCreateInput) => StorageExecutor;
  /** 可选能力声明，与 ports.ts 的 ? 方法互为印证 */
  capabilities?: { offlineDownload?: boolean; directLink?: boolean; shareSource?: boolean };
}

const REGISTRY = new Map<string, StorageDriverEntry>();
export function registerDriver(entry: StorageDriverEntry): void { /* … */ }
export function getDriver(provider: string): StorageDriverEntry {
  const e = REGISTRY.get(provider);
  if (!e) throw new Error(`unknown storage driver: ${provider}`);
  return e;
}
```

**关键设计决策：`create` 缺失 = 抛错，不是返回 null。** 这直接消掉 G1 里"登记了品牌却没 executor"的静默失败类。

**搜索提供方照此办理**：`ResourceProvider` 的注册表取代 3 个文件里的 env 分叉（G3），`MEDIA_TRACK_SEARCH_PROVIDER` 退化为"选默认项"而非"分支条件"。

### 2.2 多源化的隐藏前提：媒体身份必须带来源前缀

这一点在本次调研中浮出水面，且**成本极低、收益极大**，容易被漏掉。

【事实】MoviePilot 的订阅模型用 `media_source + media_id` 表达统一媒体身份，官方注释即举例：*"如 `douban+1295644` 与 `themoviedb+550` 是两个身份"*。本项目当前的 `MediaTitle` 身份是 `tmdbId` + `mediaType`（`tmdb_tv_283428` / `tmdb_movie_238` 形式的 `titleKey`，见 [user-requests.ts](packages/workflow/src/user-requests.ts) 注释）。

【推断】今天只有 TMDB 一个元数据源，裸 `tmdbId` 不会混淆。但一旦引入第二个元数据源（豆瓣、IMDb、TVDB），或者接入 Jackett/Prowlarr 这类会带回自己 ID 的索引器，**同名/同年/同 ID 不同源的误匹配就会变成真实 bug**：`douban` 的 1295644 与 `themoviedb` 的 1295644 完全可能是两部片。

**建议**：在阶段 1（注册表收拢）顺手把身份改成 `source + id` 形式。此时改是一行类型的代价；等接了第二个源再改，是要动 `media_titles` / `tracked_seasons` / `user_messages` / `resource_snapshots` 一串表的迁移。

### 2.3 为什么不用 DI 容器

库选型调研的结论（[library-selection-survey-2026-10-27.md §B](library-selection-survey-2026-10-27.md)）：tsyringe / inversify / typed-inject 都需要装饰器或反射元数据，对本项目（Next.js 单体、≤10 个实现、测试要直接塞 fake）是**净负收益**。朴素的 `Map<string, impl> + factory` 完全够，且测试里 `registerDriver({ ...create: () => fake })` 一行搞定。

### 2.4 风控与性能（这一层最需要克制）

**风控现状【事实】**：115 漏桶 1.2s/发（[packages/shared/src/rate-limiter.ts:102](packages/shared/src/rate-limiter.ts#L102)），夸克令牌桶 3/s burst 5，光鸭 token 认证。`withBrandPacing` 是装饰器，只包 pacing 不改语义。

**加新网盘时最容易被忽略的三件事**：
1. **新品牌默认不限速**——`withBrandPacing` 对未登记品牌"零包装（返回同一对象）"（brand-pacing.ts 注释原文）。这是**故意留给新驱动为零摩擦，也是封号风险的入口**。新驱动必须显式登记 pacing 参数。
2. **凭证刷新要能回写**——`createExecutorForBrand` 已有 `onCredentialRefresh` 钩子（光鸭 refresh 轮换 token、天翼自愈轮换 sessionKey）。新驱动若用 token 认证却忽略这个钩子，会在 token 过期后永久失效。
3. **写作用域隔离**——`scopeCids`（rootCid + Movies/TV/Anime）决定 executor 能碰哪些目录。新驱动若忽略写作用域，`removeDirectory` 的"拒绝 root/parent"保护就失效了。

**性能【事实，实测于 3001 真实实例】**：

| 端点 | 中位延迟 |
|---|---|
| `/api/health` | ~3.5ms |
| `/api/auth/bootstrap` | ~2.5ms |
| `/?q=奥特曼`（含 TMDB 搜索 + 缓存命中） | ~21–32ms |

Web 层不是瓶颈。**真正的成本在网盘 API**：一次转存要过 1.2s 漏桶，加上列目录、轮询落地、重命名、去扁平化，单次入库数十次 API 调用是常态。因此：
- 手动模式**不能**在前端同步等待网盘往返，必须走队列异步（§3.3）；
- 多驱动并行时必须**按 drive 串行**——`runScheduledType3Monitoring` 已有 `maxConcurrentRuns`（默认 1，[worker.ts:617](packages/workflow/src/worker.ts#L617)）+ keyed pool 保证"同一 drive 从不并发"，新驱动要沿用这个约束。

---

## 3. Q2 方案：搜索模式选择

### 3.1 核心设计：人机同构的选择器（本文最重要的一个判断）

当前流水线（[workflow-product-architecture.md](workflow-product-architecture.md) 原文）：

```
ResourceProvider → ResourceSnapshot → agent judgment nodes
  → validated AgentDecision → storage executor → verification
```

`agent judgment nodes` 这一步，**输入是 `ResourceSnapshot`（id + title + hints），输出是 `AgentDecision`（selectedCandidateIds + episodeMapping + rejectedCandidateIds + confidence + reason）**。

【推断】把这一步抽象成端口，人就是另一个实现：

```ts
// packages/workflow/src/acquisition-v2/selector.ts（示意，非现有代码）
interface CandidateSelector {
  /** 自动模式：跑 LLM agent；手动模式：写一条 pending 决策，等人 */
  select(input: { snapshot: ResourceSnapshot; context: SelectorContext }): Promise<SelectorOutcome>;
}

type SelectorOutcome =
  | { kind: "decided"; decision: AgentDecision }
  /** 手动模式：已落库，等待 UI 提交。run 停在 awaiting_review，不占 agent 预算 */
  | { kind: "awaiting_human"; pendingDecisionId: string };
```

**这个设计的三重收益**：
1. **执行侧零改动**——`storage executor` 收到的还是 `AgentDecision`，它不知道背后是 LLM 还是人；
2. **手动模式天然获得崩溃恢复**——`awaiting_human` 是个持久状态，重启后人继续选，不会丢；
3. **审计天然统一**——`agent_decisions` 表加一个 `source: "agent" | "human"` 列即可，"这条是谁定的"从此可查。

这与 MoviePilot 的 `download_single(context, source="Manual"|"Subscribe")` 是同一个思想，只是我们把选择前置成了端口，而 MP 把来源做成了参数——**我们的形态更利于测试（可注入 fake selector），MP 的形态更利于插件介入（事件挂钩子）**。两者不冲突，`source` 列可以同时保留。

### 3.2 手动模式数据流

```
① 用户点"获取"（或专门的"手动选材"入口）
        ↓  系统预热快照，不启动 agent
② viewResourceSnapshot 同源数据 → 前端列候选
   （显示：标题、发布日、体积、linkHistory「本作曾转过此链」）
        ↓  用户勾选
③ 用户提交 → 写 pending decision（source: human）
        ↓  队列认领
④ transfer → 落地轮询 → inspect → organize
   （与自动模式完全同一条执行链，零分叉）
        ↓
⑤ 完成通知（与自动模式同一通道）
```

**第 ② 步的数据已经全都有了**：`viewResourceSnapshot` / `searchResources` 工具（[agent-loop.ts:153](packages/workflow/src/acquisition-v2/agent-loop.ts#L153) 起）返回的正是快照；`CandidateRegistry` 侧信道持有完整 URL。**前端缺的只是把这两样渲染出来。**

### 3.3 选文件夹/文件：原语已全部存在

用户要求的"选择资源（文件夹、文件）"需要的列举能力，`StorageExecutor` **已经全有**：

| 需要的能力 | 已有方法 |
|---|---|
| 浏览目录树 | `listTree({ maxDepth })` |
| 列子目录 | `listSubdirectories({ maxDepth })` |
| 列直接子目录（单次列举，安全） | `listChildDirectories(directoryId)` |
| 列目录下视频文件 | `listVideoFiles(directoryId)`` |
| 按 provider file id 移动 | `moveFiles({ fileIds, targetDirectoryId })` |

**但这套原语今天只暴露给 agent**（在沙盒工具集里），没有任何用户态 API 能触达。**这就是 G5 的确切内容：不是缺能力，是缺一个带权限门控的用户态列举端点。**

安全边界【推断，必须显式设计】：agent 的沙盒有写作用域约束，人态的列举端点**必须复用同一套 scope 校验**（`runMatchesScope` 的思路，[sqlite.ts:972](packages/workflow/src/sqlite.ts#L972)），否则等于开了一个越权目录遍历口子。

### 3.4 性能边界：网盘列目录不是免费的

调研结论（[research §2.3](research/2026-10-27-media-automation-architecture-survey.md)）中 Sonarr 的做法值得照抄：

> *"If a directory has more than 100 files in it then Sonarr will not recursively search the directory nor attempt to parse and match the files."*

【推断】本项目应设三道闸：
1. **单次列举深度上限**（`maxDepth` 已有参数，前端应限制在 2–3 层）；
2. **单目录文件数上限**（>100 不递归，与 Sonarr 对齐）；
3. **列举结果服务端缓存**（短 TTL，如 60s）——网盘列目录要过限速桶，用户来回点同级目录会反复打 API。

第 3 点尤其重要：手动模式的交互频率远高于自动模式（人在浏览），但网盘 API 预算比自动模式还紧。

### 3.5 风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| **人态列举端点越权** | 若不做 scope 校验，等于开放任意目录遍历 | 复用 agent 的写作用域 + `runMatchesScope` 式 fail-closed 门控 |
| **awaiting_human 任务永久挂起** | 用户勾选了却不提交，任务卡死占队列 | 加 `pending_decision_expires_at` + janitor 回收（仓库已有 `staging-janitor.ts` 可参照） |
| **手动与自动双轨分叉** | 若在执行链上分叉，后续每个新功能都要做两遍 | 选择器端口化（§3.1），执行链保持单一 |
| **人也会选错** | 人选了坏源，比 agent 选错更难自动恢复 | 提交前展示 `linkHistory`（"本作曾转过此链"）+ 提交后仍走 `rejected_resources` 黑名单，下次不再推 |

---

## 4. 订阅逻辑方案

### 4.1 现状：订阅的四块拼图已存在三块

| 订阅需要的能力 | 现有实现 |
|---|---|
| 订阅目标（监控什么） | `tracked_seasons` + `media_titles` |
| 调度器（什么时候查） | [`runScheduledType3Monitoring`](packages/workflow/src/worker.ts#L588) 每日巡检，跨账号，按 owner 凭证执行 |
| 执行器（怎么获取） | `type3_monitor` run + agent |
| 人工干预（错了重找） | `user_messages` → `replace_request`（[user-requests.ts](packages/workflow/src/user-requests.ts)） |
| **策略层（按什么规则选）** | **无** ← 缺口 G6 |
| **黑名单（什么不再推）** | `rejected_resources` 雏形 ← 缺口 G7 |

### 4.2 调研给出的最重要警告：不要建 `subscription.status` 状态机

Sonarr/Radarr 的做法（[research §1.2](research/2026-10-27-media-automation-architecture-survey.md)，官方原文）：

> Missing = *"In the database, monitored, but missing from the filesystem"*
> Wanted = *"monitored, missing, but should be available based on the availability settings"*

**"已监控但缺失 / 已下载待导入 / 已入库"不是三个状态字段，而是「两个开关 + 四个派生查询」。**

【推断】本项目照此办理：订阅状态从 `tracked_seasons` 的 `monitored` + `episode_states.obtained` **派生**，不新增状态字段。派生查询今天已部分存在（`listTrackedSeasonStates` 已在 [agent/library/route.ts](apps/web/app/api/agent/library/route.ts) 用于算出 `missingAired`）。

另两条同源警告：
- **队列不落库**（Sonarr 原文：*"The queue is not stored anywhere within the application"*）——本项目 `sys_queue_jobs` 是持久队列，这是**有意的差异**（单机要崩溃恢复），但意味着"队列里"不等于"订阅的一种状态"，不要把两者混在一个状态机里。
- **订阅本质是「增量新发布 × 缺失集合」交集**，前提是索引器支持按时间倒序翻页。**国内网盘搜索（PanSou/磁力聚合）大多没有可靠增量游标**，所以本项目只能做「周期全量重搜 + 指纹去重 + 冷却」，**借鉴其水位线结构，不要照搬其成本模型**。

### 4.3 四件套设计（调研的最高杠杆建议）

```
① 监控目标      tracked_seasons / media_titles（已有，不改）
② 派生查询      monitored ∧ missing（已有雏形，补 wanted = monitored ∧ missing ∧ 应已可获取）
③ 独立策略表    subscription_policies（新增）——与目标解耦才能复用
④ 黑名单表      rejected_resources（已有雏形，补全）
```

**策略表字段可直接抄 qBittorrent 规则字段集**（[research §2.1](research/2026-10-27-media-automation-architecture-survey.md)，字段原文照录自 qui 文档）：

| 字段 | 用途 |
|---|---|
| `mustContain` / `mustNotContain` | 包含/排除关键词（如排除"CAM""伪4K"） |
| `episodeFilter` | `S01-S03;E01-E10` 季集范围 |
| `useRegex` | 上述条件是否正则 |
| `cooldownDays` | 命中后 N 天内不再匹配同一来源（对应 Ignore subsequent matches for） |
| `savePath` / `category` / `tags` | 目标与归类 |

**两个低成本高价值的配套**（qBittorrent 有、本项目没有）：
- **规则预览**：保存策略前，先用当前搜索结果试跑，告诉用户"这条规则会命中 3 个、排除 7 个"。没有它，用户写正则全靠猜。
- **Reprocess**：策略改完后，对未处理的历史结果重放。没有它，改规则只对未来生效，过去的漏网之鱼永远补不回来。

### 4.4 订阅的四个可直接照搬的建模（来自 MoviePilot 源码）

【事实，[MP 调研](research/2026-10-27-moviepilot-architecture-survey.md)】MP 的订阅行有约 30 个字段，但可以压成四个决策：

**① 状态只用四值**：`N` 新建 / `R` 订阅中 / `P` 待定 / `S` 暂停（contract.py 原文）。完成后写 `SubscribeHistory`（携同一 `activity_key`），订阅行删除。
→ 【推断】本项目连这四态都不必新建：`tracked_seasons.status` 已有 `active | completed`（[domain.ts:17](packages/workflow/src/domain.ts#L17)），补一个"暂停"即可，**不要建第七种 WorkflowKind**。

**② 进度靠派生，不靠状态**：MP 没有"下载中/部分完成"这种订阅行状态，用 `lack_episode`（缺失集数）+ `note`（已下载集号列表）推导。`compute_lack_episode() = 总集数 − 已下载集`。
→ 本项目 `episode_states.obtained` 已经是同款派生源，`agent/library/route.ts` 里算 `missingAired` 就是这条逻辑。**已对齐，无需改动。**

**③ 洗版的最简表达**：`best_version` 开关 + `current_priority` 优先级基线 + 「优先级 == 100（目标最大值）即完成」；整包洗版用 `best_version_full`。只有完结剧集支持洗版。
→ 【推断】这比"版本比较引擎"简单一个数量级，且本项目已有 `replace_request` + `pending_replacements` 表作为地基。**优先级基线可以就是一个整数配置项。**

**④ 双轨调度**：增量刷新（站点列表/RSS → 缓存 → 只匹配本轮新增）负责日常追更；全量搜索（MP 默认 24h）负责补漏；**两者共用同一个搜索实现**。
→ 【推断】本项目的 `runScheduledType3Monitoring` 已经是"全量巡检"这一轨，缺的是"增量"那一轨和两者共用搜索实现的显式约束。考虑到 PanSou 没有可靠增量游标（§4.6 已述），**建议先只做全量轨 + 指纹去重，增量轨作为可选优化**。

### 4.5 网盘管理（增删查改 + 批量操作）：一个泛化管理合同

用户把「网盘管理」列为本项目的三大本质之一，但前面的方案里没有直接覆盖它。调研给出了一个很干净的形态：

【事实】MP 的存储抽象是「统一接口 + 能力声明 + 泛化管理合同」：`storage_manage(storage, action, **params)` → 统一返回 `{success, message, data}`，`StorageChain.manage_storage` 透明转发、**无存储特定逻辑**。同时 `support_transtype()` 声明该存储支持哪些整理方式（本地：复制/移动/硬链/软链/引用链接；网盘：仅移动/复制）。

【推断】本项目照此办理的收益：
- **前端可以完全数据驱动**——一个"网盘管理"页面 + 一张能力矩阵表，而不是 5 个品牌各写一套 UI；
- **批量操作有了统一载体**——`action` + `params[]` 天然表达"对 N 个 fileId 执行同一动作"，不必每个动作设计一个批量端点；
- 与 G1 的注册表合并：**能力声明就放在注册表条目里**（§2.1 已预留 `capabilities` 字段），一处定义、前后端共用。

这与 Alist 的 `driver.Driver`（写操作全是独立可选接口）和 rclone 的 `Features()` 是同一思想，且本项目的 `transferSubtitleUrl?` 可选方法已经在这个路上走了半步。

### 4.6 成本模型（必须一开始就算清）

【推断】以"每日巡检 + 周期全量重搜"为基线：

- 每次巡检每个监控季要跑一次 `searchResources`（或复用预热快照）；
- PanSou 是搜索 API，**没有 RSS 那样的廉价增量游标**，所以"每天 10–144 次查询覆盖任意规模库"的 Sonarr 成本模型**不适用**；
- 实际成本 ≈ `监控季数 × 每日搜索次数 × 单次搜索延迟`，且**每次搜索都要过网盘/搜索源的限速**。

**这意味着订阅规模有硬上限。** 建议：监控季数上限做成配置项并默认保守（如 50），超限时明确告知，而不是默默拖垮巡检。这一点必须在做订阅 UI 之前就算，否则用户加到 200 季才发现巡检跑不完。

【事实】`.env.example` 含 11 处 `COOKIE|TOKEN|SECRET|PASSWORD` 形式的凭据键——这正是 §5.3 脱敏要求的具体依据。

---

## 5. 日志页面方案

### 5.1 数据已在，UI 不在

【事实】[`agent_steps`](packages/workflow/src/sqlite.ts#L1387) 表已持久化每一次工具调用：

```ts
interface AgentStep {
  ordinal: number;
  toolName: string;
  args: Record<string, unknown>;
  activity: string;
  phase: "search" | "pick" | "transfer" | "verify" | "organize" | "mark" | "finalize";
  apiCalls?: number;   // 累计 115 API 调用数
  at: string;
}
```

`agent_decisions` 已持久化每次决策。`repository.listAgentSteps` 已实现且**带 scope 门控**（[repository.ts:324](packages/workflow/src/repository.ts#L324)，fail-closed：未知 run 对任何 scope 不可见）。

**但全仓库没有任何前端消费这两个接口。** 排障今天只能看 `run/server.log` 文件。

### 5.2 方案：三层，从薄到厚

| 层 | 内容 | 工作量 |
|---|---|---|
| **L1 运行详情页内嵌时间线** | 复用 `listAgentSteps`，在 activity/run 详情页渲染工具调用序列。**零新表、零新接口** | 小 |
| **L2 领域事件落库** | 新增 `sys_logs(ts, level, module, event, entity_type, entity_id, message, data_json)`，只落 INFO+ 领域事件（不是所有 debug）。配 pino 自定义 transport | 中 |
| **L3 查询面板** | 按 level/模块/时间/实体过滤 + 分页 + FTS5 全文索引 + 30 天保留清理 | 中 |

**L1 应该先做且立刻可交付**——数据、接口、门控全都现成，纯粹是渲染。

### 5.3 两个必须注意的坑

1. **Next.js 打包陷阱**【事实，来自调研】：pino 不能被 bundler 直接打包，需 `pino-webpack-plugin` / `esbuild-plugin-pino`。若走 L2，这一步漏了会在生产构建时才炸。
2. **脱敏**【推断】：`.env.example` 里有大量 pan115/quark/123 凭据，`agent_steps.args` 是**原始工具参数**——里面完全可能含 cookie。**日志页渲染前必须过脱敏**，否则一个登录态用户就能在 UI 里看到自己的网盘 cookie。这是本方案里安全风险最高的一项，建议 L1 就先做脱敏（哪怕只是键名黑名单）。

---

## 6. 设计模式落地总表

| 模式 | 用在哪里 | 现状 | 建议 |
|---|---|---|---|
| **适配器** | `StorageExecutor` / `ResourceProvider` 端口 | ✅ 已建成 | 保持；补 `link()`/`putUrl()`/只读 `ShareSource` 三个可选能力（解锁 STRM、磁力离线投递、分享链接转存三条路） |
| **策略** | 选择规则、限速、去重、命名 | 🟡 部分（`withBrandPacing` 是策略装饰器） | 订阅策略表落地为数据驱动的策略对象 |
| **工厂 + 注册表** | executor/provider 装配 | 🟡 两套机制并存（G1） | 合并为单一注册表；`create` 缺失即抛错 |
| **状态机（显式 FSM）** | run 生命周期 | ✅ XState v5 + Saga 补偿，已生产 | **不要扩散**。只在新的人工介入流程上用 |
| **状态机（转移表）** | 手动选材任务 | ❌ 无 | 用**手写转移表**，不用 XState（见下） |
| **观察者/事件** | 通知、日志 | 🟡 `notification-report.ts` | 领域事件统一走一个总线，日志页与通知共用 |
| **Saga 补偿** | 失败回滚 | ✅ 已有（`compensations` 逆序执行） | 手动模式的暂存区清理复用同一机制 |
| **门面** | `workflow-runtime.ts` | ✅ 已有 | 保持（3888 行的门面，重构时勿拆散其公开面） |

### 6.1 关于状态机的明确判断（避免过度设计）

调研给出的判据是**三条同时成立几条**：①存在需禁止的非法转移 ②同一事件在不同状态下行为不同 ③需持久化+可恢复+可审计。

【推断】逐条对到本项目：

| 流程 | ①非法转移 | ②同事件异态 | ③持久化可恢复 | 结论 |
|---|---|---|---|---|
| 现有 run 生命周期 | ✅ 强（Saga 补偿） | ✅ | ✅ | **XState 合理，已用** |
| **手动选材任务** | ✅ 中（选完不能退回搜索） | ✅ 中 | ✅ 强（等人几小时） | **值得显式 FSM** |
| 订阅状态 | ❌ 派生即可 | ❌ | ❌ | **状态字段+派生查询，不要 FSM** |
| 网盘账号 active/frozen | ❌ 简单二态 | ❌ | ✅ | **状态字段+守卫** |
| `sys_queue_jobs` | ✅ 已有 CHECK 约束 | ❌ | ✅ | **已是正确海拔，不要动** |

**手动选材用哪种 FSM？** 推荐**手写转移表**而非 XState（库选型调研结论：XState v5 对 Node 单体"运行时不过重、认知过重"，且 actor 引用不可直接 JSON 序列化，落库要自建 snapshot 还原）：

```ts
// packages/workflow/src/acquisition-machine.ts（示意，非现有代码）
export const ACQUISITION_TRANSITIONS = {
  selected:        { stage: 'staging', reject: 'blocked', cancel: 'cancelled' },
  staging:         { verify: 'verifying', fail: 'staging_failed', cancel: 'cancelled' },
  verifying:       { needReview: 'awaiting_review', pass: 'importing', fail: 'verify_failed' },
  awaiting_review: { approve: 'importing', reject: 'blocked', edit: 'staging' },
  importing:       { done: 'imported', fail: 'import_failed' },
  imported:        { organize: 'organizing', reopen: 'staging' },
} as const;
```

好处：可单测、可序列化成前端展示、SQLite 里存一个 `state` 列 + `state_entered_at` 列，**天然获得"卡在某一状态多久了"的可观测性**。若将来要可视化，再把这张表翻成 XState（`states`/`on` 几乎一一对应），迁移成本低。

---

## 7. 库选型结论（详表见配套文档）

一句话组合（[library-selection-survey-2026-10-27.md](library-selection-survey-2026-10-27.md)）：

> registry map+factory（B）+ 手写 union FSM + ts-pattern（A）+ **自建 SQLite 队列表（已有）** + croner（C）+ p-retry + cockatiel（D）+ pino 或 tslog + 自写 logs 表/FTS5 面板（E）+ parse-torrent + 自写 ed2k/网盘/PT adapter（F）

**对本项目特别有意义的四条**：

1. **不需要引入任何队列库**——`sqlite-queue.ts` 的设计（`BEGIN IMMEDIATE` + `UPDATE ... RETURNING` 原子认领 + 指数退避 + 死信）与生态里最成熟的 `vardiya` 高度一致，路线已被验证。**只补停滞任务回收**（`locked_at` 已存在，加超时判定）——这是 G10，也是当前最实在的稳定性缺口。
2. **不需要任何 DI 容器**（见 §2.3）。
3. **`parse-torrent`** 直接可用（磁力解析），ed2k 手写 20 行正则即可（生态库全部停更多年）。
4. **PT/BT 站点 API 与网盘分享链接都没有成熟 TS 库**——这反而印证了 Q1 的方向：这些本来就该是自研 adapter，进注册表。

---

## 8. 业界对比摘要（详表见配套调研）

| 维度 | Sonarr/Radarr | MoviePilot | Alist | **巡影现状** | 巡影目标 |
|---|---|---|---|---|---|
| 网盘适配 | 不支持国内网盘 | **统一接口 + 能力声明**（7 存储） | **统一 Driver 适配器** | 端口 + 工厂（两套） | **单一注册表 + capabilities** |
| 资源发现 | 索引器（RSS 增量） | 站点解析器族（~20 框架） | — | PanSou/Prowlarr（全量） | **+ ManualLinkProvider** |
| 人工介入 | **Interactive Import** | **`download_single(source="Manual")`** | 离线下载对话框 | 仅 foreign-work 一处 | **可选模式，同一执行链** |
| 订阅建模 | **两开关+派生查询** | **身份+季集+过滤+洗版，状态仅 N/R/P/S** | — | tracked_seasons | **+ 策略表 + 黑名单** |
| 网盘管理 | 本地 FS | **泛化管理合同 `storage_manage`** | Driver 方法 | 散落 executor 方法 | **统一 action 合同** |
| 队列 | 不落库 | Outbox + durable 队列 | 无 | **SQLite 持久队列** | 保持 + 停滞回收 |
| 状态机 | 内部 FSM | 订阅四态 + Transfer 六态 | — | **XState + Saga** | 保持，不扩散 |
| 破坏性操作 | Atomic Move | **先算目标路径再执行** | — | 直接执行 | **预览→确认两步** |
| 日志 | 日志页 | 日志页 | — | 数据在库无 UI | **L1→L3 渐进** |

**一个重要的反向确认**：【事实】MP 核心**不做**「网盘分享链接转存」——全仓 grep 无分享链接解析，网盘在 MP 中是「整理目标」而非「下载源」，分享链接调度属第三方插件。而**本项目的核心恰恰是分享链接/磁力入库**。这说明巡影的产品定位比 MP 更靠前一层（资源获取），不能照搬 MP 的"下载器 + 本地目录 + 整理"链路——我们是"网盘 SDK 直连 + 任务状态机"。调研中 MP 那条"下载器依赖 + 路径映射 + 5 分钟轮询下载器"的**不该抄**项，正是这个原因。

**四条最值得抄的**：Sonarr 的派生查询（§4.2）、qBittorrent 的规则字段集+预览+Reprocess（§4.3）、Sonarr Interactive Import 的"列候选→人确认→选导入方式"（§3.2）、Alist 把分享链接建模为**只读 Driver** 而非特殊操作（§6 适配器行）。

**一条最该抄但最容易被忽略的**：MoviePilot 的「先算目标路径再执行」——手动整理走 `POST /transfer/manual/target-path`（预览目的路径）→ `POST /transfer/manual`（执行）两步。**对"整理"这种破坏性操作，预览-确认是必须的**：一旦转存错目录，网盘侧没有回收站可依赖。本项目现有的 `importForeignWorkAsMovie` 注释已体现同一精神（"确认前不会被移动或删除"），但自动流程里的 `organize` 步骤没有预览环节。

---

## 9. 分阶段路线图

排序原则：**先补稳定性缺口，再做用户可见功能；每阶段独立可交付、可回滚。**

### 阶段 0：稳定性（不面向用户，但应最前）

- **G10 停滞任务回收**：`sys_queue_jobs.locked_at` 加超时判定，崩溃后卡死的任务自动重取。
  - 为什么最前：它是个静默故障——今天的表现是"某个任务永远不跑，且没有任何提示"。手动模式会**大幅增加**长时挂起任务数，这个缺口不补，阶段 2 会把问题放大。
  - 可 TDD：造一个 locked 超过阈值的任务，断言被重新认领。

### 阶段 1：注册表收拢（纯重构，无行为变化）

- 合并 `STORAGE_BRANDS` 与 `storage-executor-factory.ts` 为单一注册表；`create` 缺失即抛错。
- 收拢 7 处散落品牌硬判（G2）。
- 搜索提供方改注册表，消除 3 文件 8 处 env 分叉（G3）。
- **媒体身份加来源前缀**（§2.2）：`tmdbId` → `tmdb + id`。此时是一行类型的代价；等接了第二个元数据源再改，是要动一串表的迁移。
- **验收**：加一个假的测试驱动，只改注册表一处即可工作；故意登记品牌不接 executor，断言抛错。
- 这一步是后续所有阶段的地基，且**无用户可见变化**，风险最低。

### 阶段 2：日志页 L1（最小可交付）

- activity/run 详情页内嵌 `listAgentSteps` 时间线。
- **先做脱敏**（§5.3 第 2 点）。
- 零新表、零新接口、零迁移。

### 阶段 3：手动选材（本次核心）

按依赖顺序，每步独立可交付：

1. **用户态列举端点**（G5）：带 scope 门控的目录/文件浏览 API。复用时设三道闸（§3.4）。
2. **`ManualLinkProvider`**（G4）：用户粘贴分享链接/磁力 → 成为一个 `ResourceProvider`。**这是最小手动模式**——不用做目录浏览器就能交付。
3. **选择器端口化**（§3.1）：抽出 `CandidateSelector`，`agent` 与 `human` 两个实现。
4. **手动选材 FSM**（§6.1 转移表）：`state` + `state_entered_at` 两列，含 `awaiting_review` 与过期回收。
5. **前端选材面板**：候选列表 + `linkHistory` + 勾选 + 提交。
6. **模式选择 UI**：全自动 / 手动，作为 run 级选项（**不是全局开关**——不同片可能想用不同模式）。
7. **整理预览**：转存前先算目标路径并展示，确认后执行（§8 末条）。网盘侧没有回收站，这一步不是锦上添花。

### 阶段 4：订阅策略层

1. `subscription_policies` 表 + 策略匹配（qBittorrent 字段集）。
2. **规则预览**（保存前试跑）——低成本高价值，建议与 1 同批。
3. 黑名单补全（G7）：`rejected_resources` 接通换源请求，避免反复推同一坏源。
4. 冷却期（`cooldownDays`）。
5. **Reprocess**（改规则后重放历史）——放最后，因为它要等策略表稳定。

### 阶段 5（可选，后续）

- **泛化网盘管理合同**（§4.5）：`storage_manage(storage, action, params)` 统一 `{success,message,data}`，前端数据驱动；批量操作有了统一载体。**这一项同时满足用户列出的项目本质第 3 条，且与阶段 1 的注册表天然合流。**
- `StorageExecutor.link()` 带 `expiresAt` → STRM/302 播放路线。
- `putUrl()` 泛化（把 `transferSubtitleUrl?` 的特化提升为通用能力）→ 磁力/http/ed2k 走网盘自己的离线下载。
- 只读 `ShareSource` 能力 → 分享链接成为可枚举、可预览、可选择的输入源。
- 日志页 L2/L3（领域事件落库 + 查询面板）。
- 轻量 typed 事件总线（`transfer.complete` / `download.added` 解耦媒体服务器刷新与通知）——本项目已有 `notification-report.ts`，补一个总线即可，不必引库。

---

## 10. 未决问题（需要产品决策，不要默认）

1. **手动模式的作用域**：是"每次获取都让人选"（重），还是"自动失败/低置信时降级为人审"（轻，且与已有的 `uncertain` 天然衔接）？【推断】后者更符合单用户自部署的实际使用，且实现量小得多。**建议先做后者。**
2. **订阅规模上限**：巡检成本与监控季数线性相关（§4.6），上限设多少？超限行为是拒绝还是降级巡检频率？
3. **导入方式三选一**：网盘场景下应是「转存到目标目录 / 只记录引用（STRM）/ 软链」。前两者今天可实现，**STRM 依赖 G9（`link()` 能力）尚未实现**——是否要在阶段 5 之前就承诺这个选项？
4. **`apps/web/public/support/*.png` 与 `docs/support/`**：上一轮移除打赏入口后已无引用，是否清理？（遗留待确认，与本方案无关）
5. **`agent_steps.args` 的脱敏粒度**：键名黑名单（便宜，可能漏）还是值模式匹配（贵，更安全）？这决定 L1 的工作量。

---

## 11. 一句话总结

> 适配器和策略模式**已经在这座代码库里了**（端口、组合提供者、品牌注册表、XState+Saga、SQLite 队列五样俱全）；本次真正要做的是**收拢两套并存的装配机制**、**把 `ManualLinkProvider` 这个写了两年的设计真正实现**、以及**克制住不要给订阅建状态机**。手动模式的架构钥匙是 `CandidateRegistry` 早已铺好的"选择者只看 id、完整 URL 走侧信道"——把选择者从 LLM 换成人，执行链一行不用改。而 MoviePilot 用 `download_single(source="Manual")` 证明了这条收敛路径在业界同样成立。

---

## 附录：三份调研的分工

| 文档 | 内容 | 何时读 |
|---|---|---|
| 本文 | 落到本仓库代码状态的方案与路线图 | 决策与排期时 |
| [research/2026-10-27-media-automation-architecture-survey.md](research/2026-10-27-media-automation-architecture-survey.md) | Sonarr/Radarr 派生查询、qBittorrent 规则字段、Seerr 双层状态、rclone/Alist 驱动抽象、STRM、FSM 判据、pino | 需要原始出处与原文引用时 |
| [research/2026-10-27-moviepilot-architecture-survey.md](research/2026-10-27-moviepilot-architecture-survey.md) | MP 源码级：订阅四态、洗版优先级、存储能力声明、Outbox、设计模式清单 | 需要国内 NAS 影音自动化的细节建模时 |
| [library-selection-survey-2026-10-27.md](library-selection-survey-2026-10-27.md) | 各候选库的实测数据（star/发布/许可/体积/下载量） | 引入任何新依赖前 |

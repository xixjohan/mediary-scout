# 巡影 · 项目优化方案

> **文档位置**：`docs/project-optimization-plan.md`
> **编写时间**：2026-10-27
> **本文是以下两份计划的合并与收敛**（保留作为过程记录，不再并行维护）：
>   - [provider-abstraction-manual-mode-and-subscription-plan.md](provider-abstraction-manual-mode-and-subscription-plan.md) —— 通用设计：注册表、选择器端口、订阅建模、日志页
>   - [subscription-page-and-manual-import-plan.md](subscription-page-and-manual-import-plan.md) —— 具体功能：订阅页改版、查询资源→手动入库→自动整理（含 6 项已闭环决策）
>
> **合并动机**：两份文档的缺口清单、设计模式、路线图各写了一遍，阶段编号还互相冲突（前者「阶段 0–5」含 6 步手动选材，后者「阶段 A–E」把同一件事收窄成 3 步）。本文给出**一份**诊断、**一份**路线图。
> **底层调研**（本文只摘结论，详见原文）：
>   - [research/2026-10-27-media-automation-architecture-survey.md](research/2026-10-27-media-automation-architecture-survey.md)
>   - [research/2026-10-27-moviepilot-architecture-survey.md](research/2026-10-27-moviepilot-architecture-survey.md)
>   - [library-selection-survey-2026-10-27.md](library-selection-survey-2026-10-27.md)
> **标注约定**：【事实】= 已读代码/官方文档核实；【推断】= 基于事实的推理；【未查证】= 无可靠来源。

---

## 0. 一页总览

### 0.1 一句话

> 这座代码库的**模式地基已经基本建成**（端口、组合提供者、品牌注册表、XState+Saga、SQLite 队列五样俱全）；本次优化不做架构革命，而是**收拢两套并存的装配机制**、**把设计文档里写了两年却从未实现的 `ManualLinkProvider` 真正做出来**、**修正一个页面误称**，并**克制住不要给订阅建状态机**。

### 0.2 五个工作流，一条主线

| 工作流 | 内容 | 性质 |
|---|---|---|
| **W1 装配层收拢** | 品牌注册表与 executor 工厂合并；搜索提供方改注册表；媒体身份加来源前缀 | 纯重构，无用户可见变化 |
| **W2 手动选材入库** | 订阅页改名 + 缺失待办区；详情页资源查询；手动入库；自动整理三级 | **本次产品功能主体** |
| **W3 订阅策略层** | 策略表 + 规则预览 + 黑名单 + 冷却 + Reprocess | 产品深度 |
| **W4 可观测性** | 日志页三层（L1 时间线 → L2 落库 → L3 查询面板） | 排障能力 |
| **W5 网盘管理统一合同** | `storage_manage(storage, action, params)` 泛化合同 + 能力声明 | 前端数据驱动 |

**主线是 W2**——它是唯一直接产生用户可见价值的一条，且它的架构钥匙（选择器端口）早已铺好。W1 是 W2/W3/W5 的共同地基，W4 独立可并行。

### 0.3 优化原则（从两份计划提炼，冲突时按此排序）

1. **正确性 > 门禁全绿 > 覆盖面 > 便利性。** 特别是：宁可启动/导入失败报错，也不能在陈旧状态上假报成功。
2. **不加新依赖。** 库选型调研的结论是一个都不用引（详见 §5）。
3. **不给订阅建状态机。** 这是本次调研最反复出现的警告。
4. **执行链单一。** 手动与自动共用同一条执行链，只换选择器——否则每个新功能都要做两遍。
5. **每阶段独立可交付、可回滚。** 按风险梯度排序：先做不碰网盘写操作的。

---

## 1. 现状诊断

### 1.1 已经建成的（**不要重做**）

| 资产 | 位置 | 说明 |
|---|---|---|
| `ResourceProvider` / `StorageExecutor` 端口 | [ports.ts](../packages/workflow/src/ports.ts) | 干净的两层端口 |
| `CompositeResourceProvider` | [composite-provider.ts:18](../packages/workflow/src/composite-provider.ts#L18) | 多源并行 + 合并 |
| `FallbackResourceProvider` + 每源健康度 | `fallback-provider.ts`、`resource-source-health.ts` | 故障转移 |
| `STORAGE_BRANDS` 品牌注册表（5 家） | [storage-brands.ts:78](../packages/workflow/src/storage-brands.ts#L78) | 数据驱动的品牌元数据 |
| `createExecutorForBrand` 工厂 | [storage-executor-factory.ts](../packages/workflow/src/storage-executor-factory.ts) | 按 provider 分发 |
| 能力门控 | `ports.ts` 的 `transferSubtitleUrl?` | 可选方法即能力声明 |
| XState v5 + Saga 补偿 | [run-state-machine.ts](../packages/workflow/src/acquisition-v2/run-state-machine.ts) | 显式 FSM，已生产 |
| 纯 SQLite 持久队列 | [sqlite-queue.ts](../packages/workflow/src/sqlite-queue.ts) | 原子认领 + 退避 + 死信 |
| `CandidateRegistry` 侧信道 | [candidate-registry.ts:11](../packages/workflow/src/acquisition-v2/candidate-registry.ts#L11) | **选择者只看 id，完整 URL 走侧信道** |
| `agent_steps` / `agent_decisions` 落库 | [sqlite.ts:1387](../packages/workflow/src/sqlite.ts#L1387) | 每次工具调用与决策已持久化 |
| 唯一的手动导入流程 | [commands.ts:423](../packages/workflow/src/commands.ts#L423) `importForeignWorkAsMovie` | 人勾选文件 → 确定性入库，已生产验证 |
| 确定性解析原语 | [episode-code.ts:8](../packages/workflow/src/episode-code.ts#L8)、[media-title-parser.ts:112](../packages/workflow/src/media-title-parser.ts#L112) | 整理可不依赖 LLM |
| 订阅页内搜索 + 过滤 | [library-quick-find.tsx:19](../apps/web/components/library-quick-find.tsx#L19) | 已存在，不用做 |

### 1.2 十个缺口（合并两份文档，每项都有归属批次）

| # | 缺口 | 位置 | 严重度 | 归属 |
|---|---|---|---|---|
| **G1** | 品牌注册表与 executor 工厂两套机制；登记品牌无 executor 会**静默失败** | `storage-brands.ts` vs `storage-executor-factory.ts` | 中 | **批次 1** |
| **G2** | 7 处散落的 `provider === "pan115"\|"quark"\|"tianyi"` 硬判 | 全仓库 | 中 | **批次 1** |
| **G3** | 搜索提供方是 env 分叉（3 文件 8 处），不是注册表 | `search-page.ts` / `workflow-runtime.ts` / `title-hub.ts` | 中 | **批次 1** |
| **G4** | `ManualLinkProvider` 设计存在两年，**从未实现** | —（[workflow-product-architecture.md:287](../docs/workflow-product-architecture.md#L287)） | **高** | **批次 3** |
| **G5** | 无「搜索→人选文件夹/文件→入库」流程；`StorageExecutor` 的列举原语齐全但**只暴露给 agent** | — | **高** | **批次 3** |
| **G6** | 无显式订阅策略层（过滤/冷却/质量） | — | 中 | **批次 5** |
| **G7** | 黑名单/拒绝记录只有雏形，换源请求会反复推同一个坏源 | `rejected_resources` | 中 | **批次 5** |
| **G8** | `agent_steps` 无任何前端消费，排障只能看文件日志 | 前端 | 中 | **批次 2** |
| **G9** | `StorageExecutor` 无取直链能力，STRM/302 路线被堵死 | `ports.ts` | 低 | **批次 5**（可选） |
| **G10** | `sys_queue_jobs` 无停滞任务回收，崩溃后 locked 任务**永久卡死且无提示** | `sqlite-queue.ts` | **高（稳定性）** | **批次 2** |

### 1.3 三个「心智」问题（不是 bug，但影响产品成立）

1. **页面误称**：`?tab=library` 叫「媒体库」，但 [getLibraryWall](../apps/web/lib/title-hub.ts#L452) 的注释是 *"Poster-wall view of **every tracked title**"*——它返回全部追踪中的作品（`tracking/partial/complete/reserved`），**本来就是订阅列表**。
2. **信息黑洞**：用户从来看不到真实资源。当前旅程是「搜片名 → 点获取 → **之后全自动**」，分享链接、磁力、体积、发布日一样都没见过。
3. **订阅无出口**：订阅只能全自动跑，用户无法对某一部片说「这次我自己选」。

---

## 2. W1 装配层收拢

### 2.1 目标形态

把「品牌元数据」（`STORAGE_BRANDS`，数据）与「executor 构造」（`storage-executor-factory.ts` 的 5 个 `if` 分支，代码）合并成**一张自洽的注册表**，让「加一家网盘 = 加一个条目」：

```ts
// packages/workflow/src/storage-registry.ts（示意，非现有代码）
interface StorageDriverEntry {
  provider: string;
  label: string;
  authKind: "cookie" | "token";
  /** 构造 executor；缺省即视为「已登记但未接线」——显式抛错而非静默降级 */
  create: (input: DriverCreateInput) => StorageExecutor;
  /** 可选能力声明，与 ports.ts 的 ? 方法互为印证 */
  capabilities?: { offlineDownload?: boolean; directLink?: boolean; shareSource?: boolean };
}
```

**关键设计：`create` 缺失 = 抛错，不是返回 null。** 这直接消掉 G1 的静默失败类。

搜索提供方照此办理：`ResourceProvider` 注册表取代 3 文件 8 处 env 分叉（G3），`MEDIA_TRACK_SEARCH_PROVIDER` 退化为「选默认项」而非「分支条件」。

### 2.2 多源化的隐藏前提：媒体身份必须带来源前缀

【事实】MP 用 `media_source + media_id` 表达统一媒体身份，官方注释即举例：*"如 `douban+1295644` 与 `themoviedb+550` 是两个身份"*。本项目当前是裸 `tmdbId`（`tmdb_tv_283428` 形式）。

【推断】今天只有 TMDB 一个元数据源，裸 ID 不会混淆。一旦接入第二个源（豆瓣/IMDb/TVDB）或 Jackett/Prowlarr 这类会带回自己 ID 的索引器，**同名/同年/同 ID 不同源的误匹配会变成真实 bug**。

**现在改是一行类型的代价；等接了第二个源再改，是要动 `media_titles`/`tracked_seasons`/`user_messages`/`resource_snapshots` 一串表的迁移。**

### 2.3 风控与性能（这一层最需要克制）

【事实】115 漏桶 1.2s/发（[rate-limiter.ts:102](../packages/shared/src/rate-limiter.ts#L102)），夸克令牌桶 3/s burst 5。`withBrandPacing` 是装饰器，只包 pacing 不改语义。

**加新网盘最易忽略的三件事**：
1. **新品牌默认不限速**——`withBrandPacing` 对未登记品牌「零包装（返回同一对象）」。这是故意留的零摩擦，**也是封号风险的入口**。新驱动必须显式登记 pacing。
2. **凭证刷新要能回写**——`createExecutorForBrand` 已有 `onCredentialRefresh` 钩子（光鸭 refresh 轮换 token、天翼自愈轮换 sessionKey）。token 认证的新驱动忽略它，会在 token 过期后永久失效。
3. **写作用域隔离**——`scopeCids`（rootCid + Movies/TV/Anime）决定 executor 能碰哪些目录。忽略它，`removeDirectory` 的「拒绝 root/parent」保护就失效。

**实测基线**【事实，3001 真实实例】：`/api/health` ~3.5ms、`/api/auth/bootstrap` ~2.5ms、`/?q=` ~21–32ms。**Web 层不是瓶颈，成本全在网盘 API**——一次转存要过 1.2s 漏桶，加上列目录、轮询落地、重命名、去扁平化，数十次调用是常态。

---

## 3. W2 手动选材入库（本次产品功能主体）

### 3.1 核心设计：人机同构的选择器

当前流水线：

```
ResourceProvider → ResourceSnapshot → agent judgment nodes
  → validated AgentDecision → storage executor → verification
```

`agent judgment nodes` 的**输入**是 `ResourceSnapshot`（id + title + hints），**输出**是 `AgentDecision`（selectedCandidateIds + episodeMapping + rejectedCandidateIds + confidence + reason，[domain.ts:206](../packages/workflow/src/domain.ts#L206)）。

而 [candidate-registry.ts:11](../packages/workflow/src/acquisition-v2/candidate-registry.ts#L11) 的注释已经划好了边界：

> *"the V2 interfaces … carry only the fields the AGENT judges from (id/title/hints) — NOT the raw share url. The registry is the side channel that keeps each observed candidate's full ResourceCandidate (with providerPayload) … The agent never sees raw urls; the system resolves them."*

【推断】把这一步抽象成端口，**人就是另一个实现**：

```ts
interface CandidateSelector {
  select(input: { snapshot: ResourceSnapshot; context: SelectorContext }): Promise<SelectorOutcome>;
}
type SelectorOutcome =
  | { kind: "decided"; decision: AgentDecision }
  | { kind: "awaiting_human"; pendingDecisionId: string };  // 手动模式
```

**三重收益**：① 执行侧零改动（executor 收到的还是 `AgentDecision`，不知道背后是 LLM 还是人）；② 手动模式天然获得崩溃恢复（`awaiting_human` 是持久状态）；③ 审计天然统一（`agent_decisions` 加一个 `source: "agent" | "human"` 列）。

**业界佐证**：MP 的 `download_single(context, source="Manual"|"Subscribe")` 是同一个思想——手动与订阅自动下载收敛到同一入口，只差 `source`。

### 3.2 三样必须新建的东西（其余全部已有）

| 环节 | 现状 | 要做的 |
|---|---|---|
| 订阅页内搜索 + 过滤 | ✅ 已存在 | 不用做 |
| 详情页 | ✅ 已存在（`/show/[tmdbId]`） | 加「资源」面板 |
| **① 用户态资源搜索端点** | ❌ 全仓库 `ResourceProvider.search()` 调用方**全是内部**（sandbox、pansou-chain、transfer-smoke、provider 链转发） | 新建 |
| **② 候选→入库解析链** | ❌ 无用户路径 | 新建 |
| **③ 手动入库任务载体** | ❌ 无 | 新建 |
| 整理动作原语 | ✅ 齐全（`moveToSeason`/`flattenMovie`/`markObtained` + 确定性解析） | 只缺触发器 |

**① 的要点**：
- 权限门控复用 `runMatchesScope` 的 fail-closed 思路（[sqlite.ts:972](../packages/workflow/src/sqlite.ts#L972)）——这个端点暴露资源搜索能力，不能裸奔。
- 关键词构造复用 agent 的既有分工（裸标题预热 + 繁体/英文/原名升级），**不让用户手打关键词**。
- **60s 限流间隔**（同一标题多快能再搜一次，防连点打爆上游）+ 单用户并发 1。
- **30 分钟 TTL**（candidate 还能用多久）。这两个是不同的事，别混。

**② 的关键决策**：`CandidateRegistry` 是**进程内内存 Map**，跨进程/重启即失效。所以 payload 必须从**已落库的 `resource_snapshots` 按 candidateId 取回**，不依赖那个 Map。同时 import 时必须校验「candidateId 确实属于传入的 snapshotId」，否则用户可以拿别处的 id 混进来。

**③ 的关键**：不在 HTTP 请求里同步跑完（网盘 API 慢且要过漏桶），入 `sys_queue_jobs`，用新 `WorkflowKind`。

### 3.3 安全边界：payload 绝不下前端

【事实】`ResourceCandidate.providerPayload` 里就是**原始分享链接/磁力**。

- 搜索端点只返回 `id / title / type / source / postedAt / sizeBytes / linkHistory`；
- `providerPayload` 只在后端 import 时从快照取回；
- 前端拿到的 candidateId 是**不透明句柄，不是 URL**。

好处：① 分享链接不泄到浏览器历史/日志；② 前端无法绕过服务端逻辑自己拼转存请求；③ 与 agent 的同款边界一致，一套心智。**应加测试断言响应体不含 URL 形态字符串。**

### 3.4 自动整理：三级策略

**决策（用户确认）：确定性优先 → 低置信转人工 → agent 作为推荐的可选升级（默认关）。**

```
L1 确定性   episodeCodeFromFileName 对每个文件都解析出唯一集码
            ∧ 目标季目录可唯一确定
            → 直接放置，无需人工
L2 人工复核 有文件解析不出集码 / 一个包跨多季 / 目标季不唯一
            → manual_review，前端列文件与建议目标，用户确认或改判
L3 agent    用户在整理面板显式选「用 AI 整理」才起 run（默认关闭）
```

电影与命名规范的单季包，`episodeCodeFromFileName` + `ensureMediaLibraryDirectory` 完全够用（`importForeignWorkAsMovie` 已生产验证）；多季混包/命名混乱才需要 agent。混合策略让 90% 情况秒级、零成本、可预测，剩下 10% 不会静默放错。

**共同护栏（必须）**：整理是破坏性操作，网盘侧没有回收站。抄 MP 的「先算目标路径再执行」（`POST /transfer/manual/target-path` 预览 → `POST /transfer/manual` 执行）：**执行前在任务记录里写下 planned moves，执行后对比 actual，出偏差即停并报人工。**

### 3.5 性能：用户态比 agent 更吃限流预算

| 环节 | 成本 | 缓解 |
|---|---|---|
| 资源搜索 | PanSou/Prowlarr 往返，可能多源并行 | 60s 限流间隔 + 单用户并发 1；`sourceHealth` 标记不健康源 |
| 转存 | 115 漏桶 1.2s/发，一次入库数十次调用 | 队列异步；同 drive 串行（沿用 `maxConcurrentRuns` 默认 1） |
| 落地轮询 | 需轮询网盘看文件是否出现 | 退避轮询；超时进 `manual_review` |
| 整理列举 | 列目录要过限速桶 | 短 TTL 缓存；深度与文件数上限（抄 Sonarr 的 >100 不递归） |

【推断】**用户态的交互频率比 agent 高得多**（人在浏览、来回点），但网盘 API 预算比 agent 还紧。所以限流**不是优化，是必需**——否则手动模式会先撞限速，而 agent 模式不会。

### 3.6 风险与对策

| 风险 | 对策 |
|---|---|
| payload 泄漏到前端 | API 契约层切掉 + 测试断言响应体不含 URL 形态 |
| candidateId 混用 | import 时校验 `candidateId ∈ snapshot.candidates` |
| 整理放错且不可逆 | planned moves 预写 + 执行后比对；低置信转人工 |
| 搜索打爆上游 | 60s 限流间隔 + 单用户并发 1 |
| awaiting 状态永久挂起 | 30 分钟 TTL，过期后 candidateId 失效 |
| 与 agent 链路分叉 | 执行链共用 `transferCandidate` + 同一 FSM，只换选择器 |
| 多盘归属错 | 跟随当前 workspace scope，不做 drive 选择器 |

---

## 4. W3/W4/W5 摘要

### 4.1 W3 订阅策略层

**现状**：订阅的四块拼图已存在三块——订阅目标（`tracked_seasons`）、调度器（[runScheduledType3Monitoring](../packages/workflow/src/worker.ts#L588) 每日巡检）、执行器（`type3_monitor`）、人工干预（`user_messages` → `replace_request`）。缺策略层与黑名单。

**最重要的警告：不要建 `subscription.status` 状态机。**

【事实】Sonarr 官方原文：Missing = *"In the database, monitored, but missing from the filesystem"*——「已监控但缺失/待导入/已入库」是**两个开关 + 四个派生查询**，不是三个状态字段。MP 也只有 `N/R/P/S` 四态，且进度靠 `lack_episode` 派生（*"MP 没有把下载中/部分完成做成订阅行的显式状态"*）。

**四件套**：
```
① 监控目标      tracked_seasons / media_titles（已有，不改）
② 派生查询      monitored ∧ missing（已有雏形，补 wanted）
③ 独立策略表    subscription_policies（新增）——与目标解耦才能复用
④ 黑名单表      rejected_resources（已有雏形，补全）
```

**策略字段直接抄 qBittorrent 规则字段集**：`mustContain`/`mustNotContain`、`episodeFilter`（`S01-S03;E01-E10`）、`useRegex`、`cooldownDays`（对应 Ignore subsequent matches for）、`savePath`/`category`/`tags`。

**两个低成本高价值配套**：**规则预览**（保存前用当前搜索结果试跑，告诉用户「这条规则会命中 3 个、排除 7 个」）与 **Reprocess**（改规则后对未处理历史结果重放）。

**MP 四个可照搬的建模**：① 状态只用四值（本项目连四态都不必新建，`tracked_seasons.status` 已有 `active|completed`，补「暂停」即可）；② 进度靠派生不靠状态；③ 洗版最简表达 = `best_version` + `current_priority` 基线 + 「优先级==100 即完成」；④ 刷新/搜索双轨共用同一搜索实现。

**成本模型（必须一开始就算清）**：Sonarr 的订阅是「增量新发布 × 缺失集合」交集，前提是索引器支持按时间倒序翻页。**国内网盘搜索（PanSou/磁力聚合）大多没有可靠增量游标**，所以本项目只能做「周期全量重搜 + 指纹去重 + 冷却」，**借鉴其水位线结构，不要照搬其成本模型**。实际成本 ≈ `监控季数 × 每日搜索次数 × 单次搜索延迟`，且每次要过限速。**监控季数上限应做成配置项并默认保守（如 50）**，超限明确告知而非默默拖垮巡检。

### 4.2 W4 日志页面

【事实】[agent_steps](../packages/workflow/src/sqlite.ts#L1387) 已持久化每次工具调用（`ordinal/toolName/args/activity/phase/apiCalls/at`），`agent_decisions` 已持久化每次决策，`repository.listAgentSteps` 已实现且带 scope 门控（[repository.ts:324](../packages/workflow/src/repository.ts#L324)，fail-closed）。**但全仓库没有任何前端消费它。**

三层，从薄到厚：

| 层 | 内容 | 工作量 |
|---|---|---|
| **L1** | activity/run 详情页内嵌 `listAgentSteps` 时间线。**零新表、零新接口** | 小 |
| **L2** | `sys_logs(ts,level,module,event,entity_type,entity_id,message,data_json)`，只落 INFO+ 领域事件 | 中 |
| **L3** | 按 level/模块/时间/实体过滤 + 分页 + FTS5 + 30 天保留清理 | 中 |

**两个必须注意的坑**：
1. **Next.js 打包陷阱**：pino 不能被 bundler 直接打包，需 `pino-webpack-plugin`/`esbuild-plugin-pino`。走 L2 时漏了会在生产构建才炸。
2. **脱敏（本方案安全风险最高的一项）**：`agent_steps.args` 是**原始工具参数**，完全可能含 cookie；而 `.env.example` 有 11 处 `COOKIE|TOKEN|SECRET|PASSWORD` 键。**一个登录态用户就能在 UI 里看到自己的网盘 cookie。** 建议 L1 就先做脱敏（哪怕只是键名黑名单）。

### 4.3 W5 网盘管理统一合同

【事实】MP 的存储抽象是「统一接口 + 能力声明 + 泛化管理合同」：`storage_manage(storage, action, **params)` → 统一 `{success,message,data}`，`StorageChain.manage_storage` 透明转发、**无存储特定逻辑**。`support_transtype()` 声明该存储支持哪些整理方式（本地：复制/移动/硬链/软链/引用链接；网盘：仅移动/复制）。

【推断】本项目照此办理：**前端可完全数据驱动**（一个管理页 + 一张能力矩阵，而非 5 个品牌各写一套 UI）；**批量操作有统一载体**（`action` + `params[]` 天然表达「对 N 个 fileId 执行同一动作」）；与 W1 的注册表合流——**能力声明就放在注册表条目里**，一处定义、前后端共用。

这与 Alist 的 `driver.Driver`（写操作全是独立可选接口）、rclone 的 `Features()` 同思想，且本项目的 `transferSubtitleUrl?` 已在这路上走了半步。

---

## 5. 库选型结论：一个都不用引

> registry map+factory + 手写 union FSM + ts-pattern + **自建 SQLite 队列表（已有）** + croner + p-retry + cockatiel + pino/tslog + 自写 logs 表/FTS5 面板 + parse-torrent + 自写 ed2k/网盘/PT adapter

对本项目特别有意义的四条：

1. **不需要引入任何队列库**——`sqlite-queue.ts` 与生态最成熟的 `vardiya` 设计高度一致（同为 `UPDATE...RETURNING` 原子认领 + 一行 CHECK 状态约束），路线已被验证。**只补停滞任务回收**（G10）。
2. **不需要任何 DI 容器**——tsyringe/inversify/typed-inject 都要装饰器或反射元数据，对 ≤10 个实现、测试要塞 fake 的单体是净负收益。朴素 `Map<string, impl> + factory` 完全够。
3. **`parse-torrent`** 可直接用（磁力解析）；ed2k 手写 20 行正则（生态库全部停更多年）。
4. **PT/BT 站点 API 与网盘分享链接都没有成熟 TS 库**——这反而印证 W1 的方向：本来就该是自研 adapter，进注册表。

---

## 6. 设计模式落地总表

| 模式 | 用在哪里 | 现状 | 本次要做的 |
|---|---|---|---|
| **适配器** | `StorageExecutor` / `ResourceProvider` 端口 | ✅ 已建成 | 保持；后续补 `link()`/`putUrl()`/只读 `ShareSource` 三个可选能力 |
| **策略** | 选择规则、限速、整理方式 | 🟡 部分（`withBrandPacing` 是策略装饰器） | 抽 `OrganizeStrategy`（L1/L2/L3 三实现）；订阅策略落地为数据驱动策略对象 |
| **工厂 + 注册表** | executor/provider 装配 | 🟡 两套并存（G1） | 合并为单一注册表；`create` 缺失即抛错 |
| **状态机（显式 FSM）** | run 生命周期 | ✅ XState v5 + Saga 补偿 | **不要扩散** |
| **状态机（转移表）** | 手动导入任务 | ❌ 无 | 手写转移表，**不上 XState**（见下） |
| **门面** | 详情页数据组装 | ✅ `title-hub.ts` | 资源面板数据走同一门面，不新开 |
| **模板方法** | 导入流程公共骨架 | 🟡 `importForeignWorkAsMovie` 是特例 | 泛化时抽骨架，movie/tv 各填放置逻辑 |
| **Saga 补偿** | 失败回滚 | ✅ 已有 | 手动模式的暂存区清理复用同一机制 |
| **观察者/事件** | 通知、日志 | 🟡 `notification-report.ts` | 轻量 typed 事件总线，不必引库 |

### 6.1 关于状态机的明确判断（避免过度设计）

判据（三条同时成立几条）：①存在需禁止的非法转移 ②同一事件在不同状态下行为不同 ③需持久化+可恢复+可审计。

| 流程 | ① | ② | ③ | 结论 |
|---|---|---|---|---|
| 现有 run 生命周期 | ✅ 强 | ✅ | ✅ | **XState 合理，已用** |
| **手动导入任务** | ✅ 中 | ✅ 中 | ✅ 强 | **值得显式 FSM** |
| 订阅状态 | ❌ | ❌ | ❌ | **派生查询，不要 FSM** |
| 网盘账号 active/frozen | ❌ | ❌ | ✅ | **状态字段+守卫** |
| `sys_queue_jobs` | ✅ 已有 CHECK | ❌ | ✅ | **已是正确海拔，不要动** |

**手动导入用转移表而非 XState**：线性流程（搜索→选→转存→轮询→整理→标记），无并行/层级状态；且 XState v5 的 actor 引用不可直接 JSON 序列化，落库要自建 snapshot 还原。手写转移表 + SQLite 两列（`state` + `state_entered_at`）更轻，且**天然获得「卡在某一状态多久了」的可观测性**。若将来要可视化，再把表翻成 XState，迁移成本低。

---

## 7. 统一路线图（合并两份计划的 11 个阶段为 5 个批次）

排序原则：先做不碰网盘写操作的；每批次独立可交付、可回滚。

```
批次 1  装配层收拢 + 页面正名      ── 零网盘写操作，风险最低
批次 2  稳定性 + 只读能力          ── 日志 L1 / 停滞回收 / 资源查询
批次 3  手动入库                   ── 第一次碰网盘写操作
批次 4  自动整理（三级）           ── 碰破坏性操作，护栏最重
批次 5  订阅策略层 + 网盘管理合同  ── 产品深度
```

### 批次 1：装配层收拢 + 页面正名

**W1 全部 + W2 的 UI 部分**

- 合并 `STORAGE_BRANDS` 与 `storage-executor-factory.ts` 为单一注册表；`create` 缺失即抛错。
- 收拢 7 处散落品牌硬判（G2）。
- 搜索提供方改注册表，消除 3 文件 8 处 env 分叉（G3）。
- 媒体身份加来源前缀（§2.2）。
- **改名**：`媒体库` → `订阅`，A 类 + C 类共 8 处；**B 类不动**（数据所有权语义）。
- **加「缺失」待办区**：订阅页顶部，数据复用 `/api/agent/library` 已在算的 `missingAired`，海报墙降为下方总览。

**验收**：加一个假测试驱动，只改注册表一处即可工作；故意登记品牌不接 executor，断言抛错；`grep -rn "媒体库" apps/web` 只剩 B 类；待办区缺失集数与 `/api/agent/library` 的 `missingAired` **一致**（同一派生源，不允许两套算法）。

**为什么正名与待办区必须同批**：只改名不加待办区，用户点进「订阅」看到的还是一墙海报，不知道要干什么——这个名字撑不住一个版本。

### 批次 2：稳定性 + 只读能力

**G10 + W4 L1 + W2 的查询端点**

- **停滞任务回收**（G10）：`sys_queue_jobs.locked_at` 加超时判定。这是**静默故障**——今天的表现是「某个任务永远不跑且无提示」，而手动模式会**大幅增加**长时挂起任务数，不补会把问题放大。
- **日志页 L1**：详情页内嵌 `listAgentSteps` 时间线。**先做脱敏。**
- **用户态资源搜索端点**：`POST /api/titles/resources`，scope 门控 + 60s 限流 + 30 分钟 TTL。**仅详情页手动触发。**
- 详情页「资源」面板：查询按钮 + 候选列表（**不含 payload**）。

**到此用户已获得真实价值**：终于能看到某部片有哪些资源、多大、什么时候发的——即使还不能一键入库。且本批次**零网盘写操作**。

**验收**：造一个 locked 超阈值的任务，断言被重新认领；响应体断言不含 URL 形态；30 分钟内命中缓存、超 30 分钟 candidateId 失效；无 scope 时 fail-closed。

### 批次 3：手动入库

- 新建 import 端点：从快照取回 payload → 入 `sys_queue_jobs` → 新 `WorkflowKind`。
- **目标盘跟随当前 workspace scope**，不做 drive 选择器。
- 详情页「手动入库」按钮 + 进度（复用 `AcquiringPoller`）。
- 抽 `CandidateSelector` 端口，`agent`/`human` 两实现；`agent_decisions` 加 `source` 列。

**验收**：candidateId 不属于该 snapshot → 拒绝；超 30 分钟 → 拒绝；导入成功后徽章更新；手动与自动两条路径产出的 `AgentDecision` 结构一致。

### 批次 4：自动整理（三级）

- 抽 `OrganizeStrategy`，L1 确定性优先：`episodeCodeFromFileName` → `ensureMediaLibraryDirectory` → `moveToSeason` → `markObtained`。
- L2 低置信转人工：解析不出集码 / 跨多季 / 目标季不唯一 → `manual_review`，前端列文件与建议目标。
- L3 agent 仅在整理面板显式选择时启用，默认关。
- planned moves 预写 + 执行后比对。

**验收**：命名规范的单季包 → L1 全自动放对；命名混乱的包 → 进 `manual_review` 而非静默放错；planned 与 actual 不一致 → 停止并报人工。

### 批次 5：订阅策略层 + 网盘管理合同

- `subscription_policies` 表 + 策略匹配（qBittorrent 字段集）+ **规则预览**（与策略表同批，低成本高价值）。
- 黑名单补全（G7）：`rejected_resources` 接通换源请求。
- 冷却期（`cooldownDays`）。
- **Reprocess**（放最后，要等策略表稳定）。
- 泛化网盘管理合同（W5）：`storage_manage(storage, action, params)` 统一返回，前端数据驱动。
- （可选）`link()` 带 `expiresAt` → STRM/302；`putUrl()` 泛化；只读 `ShareSource`。

**执行状态（2026-10-28）：四项主件齐备，两项改动说明如下。**

| 项 | 状态 | 说明 |
|---|---|---|
| `subscription_policies` + 策略匹配 + 规则预览 | 完成 | qBittorrent 字段集（mustContain/mustNotContain/episodeFilter/useRegex/cooldownDays）。预览接进订阅面板，保存前就能看到命中/排除数。 |
| 黑名单补全（G7） | 已核实完成 | plan 缺口表的「只有雏形」是更早的状态描述；`rejectedLookupOption` 已接进 `runReplaceRequestV2AndPersist`，且按 linkKey 与 label+size 双指纹过滤。 |
| 冷却期 | 完成 | `cooldownDays` + 水位线 `lastTakenAt`（由 run 的结果写回，不是由「跑完了」写）；改规则时按当前值重算，不被旧水位线卡住。 |
| **Reprocess** | **不建** | 查过「未处理历史结果」在本架构里没有对象：`resourceSnapshots` 只写不读（唯一读处是 `listLandingSources` 解析已转存文件的直链），没有「搜到了但没处理」的积压；`rejected_resources` 只由用户主动换源写入，改规则就自动解除是撤销用户意图。这不是疏漏，是 §4.1 成本模型的直接结果（周期全量重搜）。有意义的那一半——「改规则后下一轮生效」——已由冷却期按当前值重算覆盖。 |
| 泛化网盘管理合同（W5） | **收窄后做了一半** | 不建 `storage_manage` 动作联合：本项目没有网盘管理页，文件管理类动作五家全支持（都是 `StorageExecutor` 必填方法），那样的能力矩阵是均匀装饰。做的是它有消费方的那一半：把「哪些盘能落字幕」从两处硬编码文案搬进注册表声明 `supportsSubtitleDirectLink`（REQUIRED，漏声明即编译错误），orchestrator 的字幕门与设置页同源。双向断言（声明与 executor 实现必须一致）防的是两种漂移：声明了没实现、实现了没声明。 |
| （可选）STRM/302 等 | 未建 | plan 标记可选，且 G9 判定为低优先级。 |

**本批次顺带修掉的三个真 bug**（均非本批次引入，详见各提交）：
① 冷却过滤按 `title` 单键，会让一家的冷却静默停掉另一家的订阅（标题跨账号共享）；
② 旧库缺 `last_taken_at` 列，造成写水位线时抛 `no such column`（真实生产卷 `data/mediary.db` 就处于这个状态）；
③ `npm run build:web` 自批次 4 收尾起就是红的（Turbopack 拒绝 `node:module` 进客户端 chunk），而 gate 一直绿——即用户无法部署。

---

## 8. 非目标（不可违反）

- 不自动执行构建、不配网盘凭证与模型 key（那是设置页用户自己的事）
- 不修改 `data/` 生产数据目录、不动 docker-compose 配置
- 不做多端口多实例管理、不做 systemd/容器化部署
- 多副本共享限流、per-account key、XState 扩散到新流程
- middleware 硬拦、Auth.js、付费远程访问功能本身
- MP 的进程内 importlib 插件机制 + compat 兼容层 + SDK 门面（TS 用适配器注册表 + 声明式配置即可）
- MP 的 V3 chain 包/owner 拆分/startup 组合根/架构机器门禁（治理成本属大型协作项目）
- MP 的多用户权限审批、订阅分享/follow（单用户不需要）
- MP 的 PT 爬虫族 + resources.v3 + 浏览器仿真 + Cloudflare 绕过 + CookieCloud + OCR 登录（若需 PT 站优先对接 Jackett/Prowlarr）
- **MP 的「下载器依赖 + 路径映射 + 5 分钟轮询下载器」链路**——MP 核心不做分享链接转存（网盘在 MP 中是整理目标而非下载源），而这是我们的核心，应走网盘 SDK 直连 + 任务状态机
- Rust 加速、AI Agent/MCP/工作流、音乐全链路、刮削（非核心，后期可选）

---

## 9. 遗留项处理记录（2026-10-28 用户确认，四项全部执行）

| # | 遗留项 | 决策 | 执行结果 |
|---|---|---|---|
| 1 | `apps/web/public/support/*.png` 无任何引用 | **清理** | 已删 2 个 PNG（250KB）并移除空目录；删除前复核代码零引用 |
| 2 | `docs/support/README.md`、`thanks.md` 描述旧打赏流程 | **更新** | 两份重写为「产品内不做打赏入口」的立场说明 |
| 3 | `fancydirty` 写死 | **改为当前仓库** | 仅改你点名的 2 个文件共 4 处；**未全量替换**，原因见下 |
| 4 | `fish2018/pansou` 第三方署名 | **保留** | 未改动 |

### 9.1 为什么没有全量替换 `fancydirty`

【事实】GitHub API 实证：`xixjohan/mediary-scout` **0 release / 0 tag**，上游 `fancydirty/mediary-scout` 有 1 个。fork 上**只有 `mediary` 分支**，`main` 分支 404（`docs/deploy.md` 在 `mediary` 上 200、在 `main` 上 404）。

因此全量替换会直接搞坏三类东西：

1. **所有下载链接**——`site/index.html` 的下载按钮、`README.md`/`README.en.md` 的 Releases 链接、`docs/deploy.md` 的下载指引，改成 fork 后全部指向空仓库。
2. **桌面更新通道**——[delivery-report-s5.md:78](../docs/delivery-report-s5.md#L78) 记录在案的产品立场：*fork 不发 `.dmg`/`.exe`，改默认会让存量桌面安装收不到更新*。
3. **CI badge 与 Star History 图**——会显示无构建、空图表。

**已改的 4 处**均为纯仓库/文档链接、不含 release 语义，且改后逐条实测 200：
- `site/guides/which-cloud-drive/index.html`：nav 的 GitHub（:83）、部署文档（:188，**同时把 `main` 改为 `mediary`**，否则 fork 上 404）、页脚「开源自部署」（:198）
- `workers/scout-connect/src/html/invite-page.ts`：页脚「开源自部署」（:74）

**其余约 60 处 `fancydirty` 保持原样**，其中「部署行为」类与「产品立场」类的分界在 [api-key-auth-and-self-update.md:291](../docs/api-key-auth-and-self-update.md#L291) 已有结论。若将来 fork 开始自己发 release，可按同一判据再收一轮。

### 9.2 连带不一致（已处理）

`README.md:27` 原为 `点击前往赏饭：[要饭嘛，不寒碜](docs/support/README.md)`、`README.en.md:26` 原为 `Support the author: [buy me a coffee](...)`——以打赏口吻链接到已重写为「产品内不做打赏入口」的页面。**已改为**「想帮忙？提 Issue 或改文档，比捐款管用」/「Want to help? An Issue or a docs fix beats a donation」，与目标页正文口径一致（该页列的正是提 Issue、做适配、补文档三项）。

---

## 10. 一句话总结

> 这次优化不做架构革命。**装配层收拢**（两套机制合一、身份加前缀）、**把写了两年没做的 `ManualLinkProvider` 做出来**（架构钥匙是 `CandidateRegistry` 早已铺好的「选择者只看 id、URL 走侧信道」——把选择者从 LLM 换成人，执行链一行不用改）、**修正一个页面误称**（`getLibraryWall` 返回的本来就是 every tracked title），并且**克制住不要给订阅建状态机**。五个批次按风险梯度排：零写操作 → 只读 → 第一次写 → 破坏性操作 → 产品深度。一个新依赖都不用引。

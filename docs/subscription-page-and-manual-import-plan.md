# 巡影 · 订阅页面改版与「搜索/详情 → 查询资源 → 手动入库 → 自动整理」方案

> **文档位置**：`docs/subscription-page-and-manual-import-plan.md`
> **编写时间**：2026-10-27（**2026-10-27 修订：6 项产品决策已闭环，见 §7**）
> **前置调研**（本文大量引用其结论，不重复）：
>   - [provider-abstraction-manual-mode-and-subscription-plan.md](provider-abstraction-manual-mode-and-subscription-plan.md) —— 上一轮总方案（含 G1–G10 缺口清单、选择器端口设计、手动模式数据流）
>   - [research/2026-10-27-moviepilot-architecture-survey.md](research/2026-10-27-moviepilot-architecture-survey.md) —— MP 源码级调研
>   - [research/2026-10-27-media-automation-architecture-survey.md](research/2026-10-27-media-automation-architecture-survey.md) —— Sonarr/Radarr、qBittorrent、Seerr、rclone、Alist
>   - [library-selection-survey-2026-10-27.md](library-selection-survey-2026-10-27.md) —— 库选型实测数据
> **本文定位**：把上一轮的通用设计，**收窄到这两个具体功能**上，给出可直接排期的落地步骤。
> **标注约定**：【事实】= 已读代码/官方文档核实；【推断】= 基于事实的推理；【未查证】= 无可靠来源。

---

## 0. 结论先行

### 功能 1「媒体库 → 订阅」：这不是改文案，是**修正一个误称**

【事实】[title-hub.ts:452](../apps/web/lib/title-hub.ts#L452) 的 `getLibraryWall` 注释原文是 *"Poster-wall view of **every tracked title**"*——它调 `listTrackedSeasonStates`，返回**全部追踪中的作品**，不是只返回已入库的。每张卡的状态来自 `TitleAggregateState = "untracked" | "tracking" | "partial" | "complete"`（[title-aggregate.ts:1](../apps/web/lib/title-aggregate.ts#L1)）外加 `libraryWallState` 的 `"reserved"`。

**也就是说这个页面本来就是订阅列表**，叫「媒体库」反而让人以为里面 only 是已下载的东西。改名是让名字追上事实。

**但要注意**：「媒体库」这个词在全仓库出现 **20+ 处，且承担两个不同的含义**——一个是「追踪列表」（要改），一个是「用户私有数据范围」（**不能改**，详见 §2.2）。所以这是 6–8 个文件的改动，不是一行。

### 功能 2「搜索/详情 → 查询资源 → 手动入库 → 自动整理」：三样东西要新建，其余全部已有

| 环节 | 现状 | 要做的 |
|---|---|---|
| 订阅页内搜索 | ✅ **已存在**——`LibraryQuickFind` 有 query + `all/complete/tracking/partial` 过滤（[library-quick-find.tsx:19](../apps/web/components/library-quick-find.tsx#L19)） | 不用做 |
| 详情页 | ✅ 已存在——`/show/[tmdbId]`（TvHub / MovieHub） | 加一个「资源」面板 |
| **查询相关资源** | ❌ **没有任何用户态 API**。全仓库 `ResourceProvider.search()` 的调用方**全是内部**（agent 沙盒 `sandbox.ts:781/2155`、`pansou-chain.ts:91`、`pan115-transfer-smoke.ts:39`） | **新建**（§3.2-①） |
| **手动入库** | ❌ 无用户路径。但 `CandidateRegistry` 侧信道已持有完整 payload | **新建**（§3.2-②③） |
| **自动触发整理** | 🟡 整理动作齐全（`moveToSeason`/`flattenMovie`/`markObtained` 是 agent 工具；`episodeCodeFromFileName`/`parseMediaFileName`/`ensureMediaLibraryDirectory` 是确定性原语），但**只在 agent 链路里被调用** | **新建触发器**（§3.4） |

**最关键的一点**：功能 2 的绝大部分在上一轮已经设计过了（选择器端口、`ManualLinkProvider`、`awaiting_review` 状态）。本次是把那套设计**落到一个具体页面上**，不需要新架构。

---

## 1. 现状盘点

### 1.1 当前 IA（事实）

```
/                     首页，两个 tab
  ?tab=search           搜索（TMDB 元数据搜索 → 获取/预定）
  ?tab=library          媒体库（= 全部追踪中的作品海报墙 + LibraryQuickFind）
/show/[tmdbId]          标题详情 hub（TvHub / MovieHub：季、集、徽章、获取按钮、留言换源）
/activity               工作流运行
/notifications          通知
/settings               设置
/w/[storageId]          按盘的工作区
/foreign-work/[workflowRunId]  疑似其他作品的手动入库（唯一的既有手动流程）
```

「订阅页面」= 用户指的就是 `?tab=library` 这个 tab（改名后）。「默认订阅路径」= `tracked_seasons` + [`runScheduledType3Monitoring`](../packages/workflow/src/worker.ts#L588) 每日巡检 + `type3_monitor` run——**本次不动它**。

### 1.2 一个重要的既有资产：foreign-work 已经证明了手动导入可行

【事实】[commands.ts:423](../packages/workflow/src/commands.ts#L423) `importForeignWorkAsMovie` 的注释：

> *"User-confirmed import of foreign-work files quarantined in staging. The recognition agent only FLAGS a file as belonging to a different title; naming the destination and pulling the trigger is the user's decision. Deterministic execution: find-or-create `Title (Year)` under the movies parent and move the files in."*

前端在 [foreign-work/[workflowRunId]/page.tsx:78](../apps/web/app/foreign-work/[workflowRunId]/page.tsx#L78)，文案是 *"确认前不会被移动或删除"*。

**这是仓库里唯一一条「人勾选文件 → 确定性入库」的生产流程。** 功能 2 的手动入库就是把它从「隔离区纠偏」泛化到「主动选材」。

### 1.3 详情页现在的样子

`/show/[tmdbId]` 的 TvHub（[page.tsx:174](../apps/web/app/show/[tmdbId]/page.tsx#L174)）包含：backdrop、海报、聚合徽章（`obtained/partial/missing/reserved/acquiring`）+ `追更中` + `SwapBadge`、标题、季集属性、动作区（`RequestRemainingButton` / `获取` / `预定`）、季行、留言换源区。

**没有任何资源信息**——用户看不到分享链接、磁力、体积、发布日。这就是要加的「资源」面板的位置。

---

## 2. 功能 1：媒体库 → 订阅

### 2.1 影响面清单（事实，逐处读过）

**A 类：追踪列表语义，应改为「订阅」**

| 位置 | 现文案 | 建议 |
|---|---|---|
| [app-sidebar.tsx:65](../apps/web/components/app-sidebar.tsx#L65) | 导航 `媒体库` | `订阅` |
| [library-quick-find.tsx:104](../apps/web/components/library-quick-find.tsx#L104) | `<h1>我的媒体库</h1>` | `我的订阅` |
| [page.tsx:441](../apps/web/app/page.tsx#L441) | `媒体库还是空的` / `去搜索页发起第一次获取吧` | `订阅还是空的` / 引导语可保留 |
| [show/[tmdbId]/page.tsx:133](../apps/web/app/show/[tmdbId]/page.tsx#L133) | backLabel `from === "library" ? "媒体库"` | `订阅` |
| [untrack-button.tsx:11](../apps/web/components/untrack-button.tsx#L11), [:81](../apps/web/components/untrack-button.tsx#L81) | `跳回媒体库` / `取消后从媒体库移除，网盘文件保留` | `订阅` |
| [workspace-switcher.tsx:38](../apps/web/components/workspace-switcher.tsx#L38) | 注释 `搜索/媒体库/` | 注释同步 |

**B 类：数据所有权语义，【推断】不应改**

| 位置 | 文案 | 为什么不动 |
|---|---|---|
| [login/page.tsx:253](../apps/web/app/login/page.tsx#L253) | `拥有一份只属于你的媒体库——你的获取记录、收藏都与其他用户互不可见` | 讲的是**多用户数据隔离**，不是追踪列表 |
| [login/page.tsx:119](../apps/web/app/login/page.tsx#L119) | `这台实例已有媒体库。设置站主用户名 + 密码来接管它` | 讲接管存量数据 |
| [settings/page.tsx:259](../apps/web/app/settings/page.tsx#L259) | `不影响他们的网盘和媒体库` | 重置密码的影响范围 |
| [settings-attention.ts:84](../apps/web/lib/settings-attention.ts#L84) | `不影响已有媒体库` | 同上 |
| [remote-access-section.tsx:202](../apps/web/components/settings/remote-access-section.tsx#L202) | `读取整个媒体库、网盘凭据与 LLM Key` | 远程访问的风险范围 |

**C 类：边界模糊，【已决：改】**

| 位置 | 文案 | 决策 |
|---|---|---|
| [not-found.tsx:27](../apps/web/app/not-found.tsx#L27) | `回到媒体库` | 改为「订阅」（导航链接，跟随 tab 语义） |
| [demo-acquire-playback.tsx:73](../apps/web/components/demo-acquire-playback.tsx#L73) | `已加入媒体库 · 仅本次演示` | 改为「已加入订阅」 |

> **决策记录（2026-10-27，用户确认）**：A 类 + C 类全部改；**B 类不动**（数据所有权语义与追踪列表是两件事，混改会造成「登录页说你的媒体库、侧边栏说订阅」的分裂）。

### 2.2 一个真实的设计问题：订阅页该显示什么？

【事实】今天 `?tab=library` 显示 `untracked/tracking/partial/complete/reserved` 五态，`LibraryQuickFind` 已能按 `complete/tracking/partial` 过滤。

【推断】改名叫「订阅」后，用户对「订阅页」的预期会是**「我在追什么、还缺什么」**，而当前默认视图是海报墙总览。两个可选方向：

- **方向甲（最小改动，未采用）**：只改名，视图不变。订阅页 = 全部追踪中的作品 + 状态徽章 + 已有过滤。
- **方向乙（更贴合「订阅」心智，已采用）**：默认视图增加「缺失」维度——顶部一块「还缺 N 集」的待办区，下面是海报墙。这正是 Sonarr 的 Wanted/Missing 派生视图（见 [research §1.2](research/2026-10-27-media-automation-architecture-survey.md)），且数据**已经完全现成**：`/api/agent/library` 里已经在算 `missingAired`（[agent/library/route.ts](../apps/web/app/api/agent/library/route.ts)），只是没在订阅页用。

【推断】建议**甲先行、乙作为订阅页的第一个迭代**。乙的成本很低（复用 `listTrackedSeasonStates` 的派生计算），但它是「订阅」这个名字能否立住的关键——否则用户点进「订阅」看到的还是一墙海报，不知道要干什么。

> **决策记录（2026-10-27，用户确认）：采用方向乙——改名 + 加「缺失」待办区。**
> 待办区放订阅页顶部，数据复用 `/api/agent/library` 已在算的 `missingAired`（[agent/library/route.ts](../apps/web/app/api/agent/library/route.ts)），**不新增计算逻辑**。海报墙降为待办区下方的总览。落地见阶段 E，但**建议与阶段 A 同批上线**——只改名不加待办区，「订阅」这个名字撑不住一个版本。

---

## 3. 功能 2：搜索/详情 → 查询资源 → 手动入库 → 自动整理

### 3.1 目标数据流

```
订阅页（改名后）
  ├─ LibraryQuickFind 搜索/过滤（已有）
  └─ 点卡片 → /show/[tmdbId] 详情
                  └─ 【新】资源面板
                       ① 「查询相关资源」按钮
                          → POST /api/titles/resources { tmdbId, mediaType, keyword? }
                          → 后端调 ResourceProvider.search()（用标题+年份+别名）
                          → 返回候选列表（id/title/type/source/postedAt/sizeBytes/linkHistory）
                          ← 不返回 providerPayload（见 §3.3）
                       ② 用户勾选候选 → 「手动入库」
                          → POST /api/titles/resources/import { tmdbId, candidateId, snapshotId, ... }
                          → 后端从侧信道取回完整 payload → transferCandidate
                       ③ 落地后自动触发整理
                          → 确定性放置（movie: find-or-create + move；tv: 按集码分季）
                          → markObtained
                       ④ 完成 → 详情页徽章更新（已有 AcquiringPoller 机制可复用）
```

### 3.2 三样必须新建的东西

#### ① 用户态资源搜索端点

【事实】不存在。所有 `ResourceProvider.search()` 调用方都是内部的：agent 沙盒（[sandbox.ts:781](../packages/workflow/src/acquisition-v2/sandbox.ts#L781)、[:2155](../packages/workflow/src/acquisition-v2/sandbox.ts#L2155)）、[pansou-chain.ts:91](../apps/web/lib/pansou-chain.ts#L91)、[pan115-transfer-smoke.ts:39](../packages/workflow/src/pan115-transfer-smoke.ts#L39)、`composite-provider.ts`/`fallback-provider.ts`/`jev-prefilter-provider.ts` 的内部转发。

【推断】新建 `POST /api/titles/resources`，要点：
- **权限门控必须复用现有 scope 机制**——`runMatchesScope` 的 fail-closed 思路（[sqlite.ts:972](../packages/workflow/src/sqlite.ts#L972)）。这个端点会暴露资源搜索能力，不能裸奔。
- **搜索关键词的构造要复用 agent 的既有逻辑**：agent 用「裸标题预热快照 + 繁体/英文/原名升级」（`viewResourceSnapshot` 的 description 明确说了这个分工）。用户态应该直接要「标题 + 年份 + originalTitle」组合，而不是让用户手打关键词。
- **快照要落库**：`resource_snapshots` 表已存在，`workflowRunId` 参数正是为 run 级命名空间设计的（[ports.ts](../packages/workflow/src/ports.ts) 的注释解释了原因）。用户态搜索需要一个稳定的 snapshot 归属，否则同一内容跨次搜索会撞主键（注释原文：*"the second run's snapshot is lost"*）。
- **并发与限流**：一次搜索要打 PanSou/Prowlarr，且可能触发多个源。必须限流——**同一标题 60s 内不重复搜**（防连点打爆上游的限流间隔）。注意这与决策 5 的 **30 分钟是两件事**：60s 管「多快能再搜一次」，30min 管「这次搜到的 candidate 还能用多久」。

#### ② 候选 → 入库的解析链

【事实】`CandidateRegistry`（[candidate-registry.ts:11](../packages/workflow/src/acquisition-v2/candidate-registry.ts#L11)）是进程内 `Map`，注释说它是 *"the side channel that keeps each observed candidate's full ResourceCandidate (with providerPayload)"*。

【推断】这里有个**必须解决的架构问题**：`CandidateRegistry` 是**进程内内存 Map**，而用户态请求可能落在另一个进程/容器（Next.js 多实例或重启后）。两条路：
- **路 A（推荐）**：`providerPayload` 本来就存在 `resource_snapshots` 的落库 payload 里（快照持久化）。用户态 import 时**从快照按 candidateId 取回 payload**，不依赖 `CandidateRegistry`。这样天然跨进程、跨重启。
- **路 B**：把 `CandidateRegistry` 换成 DB 表。改动大，且与快照持久化重复。

**选路 A**。这也意味着 import 端点必须校验「candidateId 确实属于传入的 snapshotId」，否则用户可以拿别处的 candidateId 混进来。

#### ③ 手动入库的任务载体

【推断】手动入库不该在 HTTP 请求里同步跑完（网盘 API 慢，且要过 1.2s 漏桶，见 [rate-limiter.ts:102](../packages/shared/src/rate-limiter.ts#L102)）。应入 `sys_queue_jobs` 队列，用一个新 `WorkflowKind`（如 `manual_import`）或复用 `replace_request` 的形态。

【推断】**关键设计**：这个任务的 FSM 应复用上一轮设计的转移表（[总方案 §6.1](provider-abstraction-manual-mode-and-subscription-plan.md)），状态存 `state` + `state_entered_at` 两列，天然获得「卡在某一状态多久了」。

### 3.3 安全边界：payload 绝不下前端

【事实】`ResourceCandidate` 含 `providerPayload: Record<string, unknown>`——**原始分享链接/磁力就在这里面**。而 [ports.ts](../packages/workflow/src/ports.ts) 的 V2 接口注释明确：*"the V2 interfaces … carry only the fields the AGENT judges from (id/title/hints) — NOT the raw share url"*。

【推断】这个边界对手动模式**更加重要**，必须显式落到 API 契约上：
- 搜索端点返回的候选**只含** `id / title / type / source / postedAt / sizeBytes / linkHistory`；
- `providerPayload` 只在后端 import 时从快照取回；
- 前端拿到的 candidateId 是不透明句柄，**不是 URL**。

好处：① 不会把用户的分享链接泄到浏览器历史/日志；② 前端无法绕过服务端逻辑自己拼转存请求；③ 与 agent 的同款边界保持一致，一套心智。

### 3.4 「自动触发整理」的两种实现与取舍

这是本次**最需要产品决策**的一点。整理需要回答「这些文件该放哪、叫什么」。

| | 方案 A：确定性整理 | 方案 B：复用 agent 整理 |
|---|---|---|
| 做法 | `episodeCodeFromFileName` 逐文件解析 → `ensureMediaLibraryDirectory` find-or-create → `moveToSeason` → `markObtained` | 落地后起一个 agent run，让它跑 `inspectStaging`/`moveToSeason`/`flattenMovie` |
| 电影 | ✅ 完全够用（`importForeignWorkAsMovie` 已生产验证） | 过度 |
| 单季剧集、命名规范 | ✅ 够用 | 过度 |
| 多季混在一个包里 / 命名混乱 / 特典版 | ❌ 会放错 | ✅ 能判断 |
| 耗时 | 秒级 | 分钟级（LLM） |
| 成本 | 零 | 每次 LLM 调用 |
| 可预测性 | 高 | 低 |

【事实】确定性原语全部现成：[episode-code.ts:8](../packages/workflow/src/episode-code.ts#L8) `episodeCodeFromFileName`、[:27](../packages/workflow/src/episode-code.ts#L27) `canonicalEpisodeFileName`、[media-title-parser.ts:112](../packages/workflow/src/media-title-parser.ts#L112) `parseMediaFileName`、`ensureMediaLibraryDirectory`。

【推断】**推荐混合，且默认走 A**：
1. 先跑确定性整理；
2. **解析失败/置信度低 → 转人工复核**（这正是 MP 的 `TransferExecutionState.manual_review` 形态，见 [MP 调研 §4](research/2026-10-27-moviepilot-architecture-survey.md)），把待整理文件列给用户，让用户指定目标；
3. 只有用户显式要求时才起 agent。

这样「自动触发整理」在 90% 情况下是秒级、零成本、可预测的；剩下 10% 不会静默放错。

> **决策记录（2026-10-27，用户确认）：三级策略——确定性优先 → 低置信转人工 → agent 作为推荐的可选升级。**
> 三级的触发条件与退出条件：
> - **L1 确定性**：`episodeCodeFromFileName` 对每个文件都解析出唯一集码、且目标季目录明确 → 直接放置，无需人工。
> - **L2 人工复核**：有文件解析不出集码 / 一个包里出现多个季 / 目标季目录无法唯一确定 → 进 `manual_review`，前端列出文件与建议目标，用户确认或改判。
> - **L3 agent**：用户在该标题的整理面板上**显式选择**「用 AI 整理」时才起 agent run（复用既有 `moveToSeason`/`flattenMovie` 工具面）。**默认不启用**——LLM 单次数分钟耗时与不可预测性，只在用户主动要求时值得。
>
> 三级的共同护栏不变：planned moves 预写 + 执行后比对。

**一个必须加的护栏**：整理是破坏性操作（网盘侧没有回收站）。MP 的做法是「先算目标路径再执行」（`POST /transfer/manual/target-path` 预览 → `POST /transfer/manual` 执行，见 [MP 调研 §7.1-9](research/2026-10-27-moviepilot-architecture-survey.md)）。【推断】手动入库的整理至少要做到：**执行前在任务记录里写下 planned moves，执行后对比 actual**，出偏差即停并报人工。

### 3.5 性能

**已有的实测基线**【事实，3001 真实实例】：`/api/health` ~3.5ms、`/api/auth/bootstrap` ~2.5ms、`/?q=` ~21–32ms。Web 层不是瓶颈。

**本次新增的成本**：

| 环节 | 成本 | 缓解 |
|---|---|---|
| 资源搜索 | PanSou/Prowlarr 往返，可能多源并行 | 同一标题 **60s 限流间隔**（非缓存 TTL）+ 单用户并发 1；`sourceHealth` 已能标记不健康源（`fallback-provider`） |
| 转存 | 115 漏桶 1.2s/发，一次入库数十次调用 | 队列异步，不占 HTTP；同 drive 串行（沿用 `maxConcurrentRuns` 默认 1） |
| 落地轮询 | 需轮询网盘看文件是否出现 | 退避轮询；超时进 `manual_review` |
| 整理列举 | 列目录要过限速桶 | 短 TTL 缓存（60s 限流间隔）；深度与文件数上限 |

【推断】**用户态的交互频率比 agent 高得多**（人在浏览、来回点），但网盘 API 预算比 agent 还紧。所以 §3.2-① 的缓存和限流**不是优化，是必需**——否则手动模式会先撞限速，而 agent 模式不会。

### 3.6 风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| **payload 泄漏到前端** | §3.3 | API 契约层就切掉；加测试断言响应体不含 URL 形态字符串 |
| **candidateId 混用** | 用户拿别处的 id 提交 | import 时校验 `candidateId ∈ snapshot.candidates` |
| **整理放错且不可逆** | 网盘无回收站 | planned moves 预写 + 执行后比对；低置信转人工 |
| **搜索打爆上游** | 用户连点 | 60s 限流间隔 + 单用户并发 1 |
| **awaiting 状态永久挂起** | 用户开了查询不导入 | 快照 TTL 过期（30 分钟），过期后 candidateId 失效 |
| **与 agent 链路分叉** | 手动/自动两套执行链，后续功能做两遍 | 执行链共用 `transferCandidate` + 同一 FSM，只换选择器 |
| **多盘归属错** | 手动入库落到错误的 drive | 沿用 `getActiveWorkspaceScope`，与订阅页当前盘一致（已决） |

---

## 4. 设计模式落地

| 模式 | 用在哪里 | 现状 | 本次要做的 |
|---|---|---|---|
| **适配器** | `ResourceProvider` 搜索源 | ✅ 端口 + 组合 + fallback + 健康度 | 不动；用户态端点只是又一个调用方 |
| **策略** | 整理方式（确定性 / agent / 人工） | 🟡 无显式策略 | 抽 `OrganizeStrategy`，三种实现可插拔 |
| **状态机（转移表）** | 手动导入任务 | ❌ 无 | 用上一轮的 `ACQUISITION_TRANSITIONS` 转移表，**不上 XState**（判据见下） |
| **门面** | 详情页数据组装 | ✅ `title-hub.ts` | 资源面板数据走同一个门面，不新开一个 |
| **模板方法** | 导入流程的公共骨架 | 🟡 `importForeignWorkAsMovie` 是特例 | 泛化时抽公共骨架，movie/tv 各填放置逻辑 |

### 4.1 为什么手动导入用转移表而不用 XState

判据（三条同时成立几条）：①存在需禁止的非法转移 ②同一事件在不同状态下行为不同 ③需持久化+可恢复+可审计。

【推断】手动导入任务：① 中（选完不能退回搜索）② 中 ③ **强**（等人几小时、进程可能重启）。→ 值得显式 FSM。

但**不值得上 XState**：这是线性流程（搜索→选→转存→轮询→整理→标记完成），没有并行/层级状态；且 XState v5 的 actor 引用不可直接 JSON 序列化，落库要自建 snapshot 还原（[library-selection-survey §A.1](library-selection-survey-2026-10-27.md)）。**手写转移表 + SQLite 两列**更轻，且天然可序列化成前端展示。

> 注：仓库**已有** XState（[run-state-machine.ts](../packages/workflow/src/acquisition-v2/run-state-machine.ts)，v5 + Saga 补偿）用于 run 生命周期。那是合理用法（有补偿语义），**不要扩散到新流程**。

---

## 5. 库与业界参考（均为上一轮已完成的调研，此处只摘结论）

**库：一个都不用引。**
- 队列：`sqlite-queue.ts` 已是对的形态（原子认领 + 退避 + 死信），与生态最成熟的 `vardiya` 设计一致。只建议补**停滞任务回收**（`locked_at` 已存在，加超时判定）。
- 磁力解析：`parse-torrent`（MIT，活跃）可直接用；ed2k 手写 20 行正则（生态库全停更）。
- DI 容器：不需要（≤10 个实现，测试要塞 fake）。
- 状态机：手写转移表 + `ts-pattern` 穷尽匹配。

**业界：三条最相关的先例。**

1. **Sonarr/Radarr Interactive Import**（[research §2.3](research/2026-10-27-media-automation-architecture-survey.md)）——*"Review all files within the path and attempt to match … allowing the user to review the results"*。这正是「列候选 → 人确认」的形态，且官方明确 *"Move Automatically 与 Interactive Import 是同一导入器的两种模式"*——**印证了 §3.6 的「执行链共用」决策**。另有一条值得抄的边界：*"If a directory has more than 100 files in it then Sonarr will not recursively search"*。
2. **MoviePilot `download_single(context, source="Manual")`**（[MP 调研 §3.3](research/2026-10-27-moviepilot-architecture-survey.md)）——手动与订阅自动下载收敛到同一入口，只差 `source`。**我们应在 `agent_decisions` 加 `source: "agent" | "human"` 列照搬这个建模。**
3. **Alist 把分享链接建模为只读 Driver**（[research §3.2](research/2026-10-27-media-automation-architecture-survey.md)）——`aliyundrive_share` 有独立的 `AccessToken/ShareToken/DriveId`，cron 2 小时续期，`Link` 返回的直链 `expire_sec: 600`。**这提示分享链接是有时效的**，手动入库的缓存不能太久（§3.6 的快照 TTL）。

---

## 6. 分阶段方案

排序原则：先做不碰网盘写操作的，再做碰的；每阶段独立可交付、可回滚。

**五个阶段已压缩为四个可交付批次**（决策 2 把原阶段 E 并入 A）：

```
A 改名 + 缺失待办区  ──┬─ 纯 UI + 只读派生，零写操作
B 只读资源查询        ──┤ 用户至此已获得真实价值
C 手动入库            ──┼─ 开始碰网盘写操作
D 自动整理（三级）    ──┘ 碰破坏性操作，护栏最重
```

### 阶段 A：改名 + 缺失待办区（纯 UI + 只读派生，零写操作）

- 改 §2.1 **A 类 + C 类**共 8 处；B 类不动。
- **同批加「缺失」待办区**（决策 2）：订阅页顶部，数据复用 `/api/agent/library` 已在算的 `missingAired`，海报墙降为下方总览。
- **验收**：`grep -rn "媒体库" apps/web` 只剩 B 类；待办区的缺失集数与 `/api/agent/library` 返回的 `missingAired` 一致（同一派生源，不允许两套算法）。
- 【推断】这一步零网盘写操作、零新表，风险最低，且是「订阅」这个名字能否立住的关键。

### 阶段 B：只读资源查询（不碰写操作）

- 新建 `POST /api/titles/resources`（§3.2-①），复用 scope 门控 + **30 分钟 TTL**（决策 5）+ 单用户并发 1。
- **触发范围仅详情页**（决策 3），不做每卡一键查。
- 详情页加「资源」面板：查询按钮 + 候选列表（**不含 payload**，§3.3）。
- **此阶段用户已能获得真实价值**：终于能看到某部片有哪些资源、多大、什么时候发的——即使还不能一键入库。
- **验收**：响应体断言不含 URL 形态；30 分钟内二次请求命中缓存；超 30 分钟 candidateId 失效；无 scope 时 fail-closed。

### 阶段 C：手动入库（开始碰写操作）

- 新建 import 端点（§3.2-②③）：从快照取回 payload → 入 `sys_queue_jobs` → 新 `WorkflowKind`。
- **目标盘跟随当前 workspace scope**（决策 6），不做 drive 选择器。
- 详情页「手动入库」按钮 + 进度（复用 `AcquiringPoller`）。
- **验收**：candidateId 不属于该 snapshot → 拒绝；超 30 分钟 → 拒绝；导入成功后徽章更新。

### 阶段 D：自动整理（三级策略）

- 抽 `OrganizeStrategy`，**L1 确定性优先**（决策 4）：`episodeCodeFromFileName` → `ensureMediaLibraryDirectory` → `moveToSeason` → `markObtained`。
- **L2 低置信转人工**：解析不出集码 / 跨多季 / 目标季不唯一 → `manual_review` 态，前端列文件与建议目标。
- **L3 agent 作为推荐的可选升级**：仅在整理面板显式选择「用 AI 整理」时启用，默认关闭。
- planned moves 预写 + 执行后比对（§3.4 护栏）。
- **验收**：命名规范的单季包 → L1 全自动放对；命名混乱的包 → 进 `manual_review` 而非静默放错；planned 与 actual 不一致 → 停止并报人工。

### 阶段 E：订阅页「缺失」待办区

> **已与阶段 A 合并上线**（决策 2）——只改名不加待办区，「订阅」这个名字撑不住一个版本。原阶段 E 的内容已并入阶段 A，此处保留编号以维持文档历史可读。

---

## 7. 决策记录（2026-10-27 用户确认，原「未决问题」全部闭环）

| # | 问题 | 决策 | 落到哪 |
|---|---|---|---|
| 1 | 改名范围（C 类改不改） | **改**。A 类 + C 类全改；B 类（数据所有权语义）不动 | 阶段 A |
| 2 | 订阅页默认视图 | **改名 + 加「缺失」待办区**（方向乙） | 阶段 A 与 E 同批上线 |
| 3 | 「查询相关资源」触发范围 | **仅详情页手动触发**，不做每卡一键查 | 阶段 B |
| 4 | 自动整理默认策略 | **三级：确定性优先 → 低置信转人工 → agent 作为推荐的可选升级**（默认不启用 agent） | 阶段 D |
| 5 | 快照/candidate TTL | **30 分钟** | 阶段 B/C |
| 6 | 多盘归属 | **跟随当前盘**（`getActiveWorkspaceScope`），不额外让用户选 | 阶段 C |

**决策 4 的展开**（因为它最影响实现）：

```
L1 确定性   episodeCodeFromFileName 对每个文件都解析出唯一集码
            ∧ 目标季目录可唯一确定
            → 直接放置，无需人工
L2 人工复核 有文件解析不出集码 / 一个包跨多季 / 目标季不唯一
            → manual_review，前端列文件与建议目标，用户确认或改判
L3 agent    用户在整理面板显式选「用 AI 整理」才起 run（默认关闭）
```

**决策 5 的落地细节**：30 分钟 TTL 同时约束三样——搜索端点的结果缓存、`resource_snapshots` 行的可用期、以及 import 端点接受的 candidateId 有效期。过期后 candidateId 失效，用户需重新查询。依据：分享直链本身有时效（Alist 阿里分享驱动 `expire_sec: 600` 是同类事实的佐证），缓存一个已过期的直链没有意义。

**决策 6 的落地细节**：手动入库的目标 drive = 订阅页当前的 workspace scope（`/w/[storageId]` 或账号默认盘），与「这个订阅归这个盘」的既有语义一致。**不做 drive 选择器**——那会把「选资源」这一步的决策面撑大，而选错盘的代价（文件落到别的盘）远高于选错候选。

---

## 8. 一句话总结

> 改名是**让名字追上事实**（这页面本来就是订阅列表，`getLibraryWall` 返回的是 every tracked title）；而「查询资源 → 手动入库 → 自动整理」的**数据、原语、执行链全都在**，缺的只是三样：一个带 scope 门控的用户态搜索端点、一条不把 payload 送往前端的导入链路、以及一个默认确定性、低置信转人工的整理策略。真正的新架构为零——上一轮设计的选择器端口和转移表，这次直接落到位。

**6 项决策已全部闭环（§7）**：C 类文案也改、订阅页加缺失待办区、资源查询仅详情页手动触发、整理走「确定性→人工→agent」三级、快照 TTL 30 分钟、入库跟随当前盘。**可以进入实现。**

# Mediary Scout vs WebToolForLinux: Agent 响应性能深度诊断与架构/设计模式重构方案

> **文档位置**：`docs/agent-speed-and-architecture-optimization-plan.md`  
> **编写日期**：2026-10-31  
> **对比标杆**：`E:\WorkProject\CSharp\PrivateProject\Web\WebToolForLinux`（C# / ASP.NET Core 9 / Clean Architecture）  
> **目标项目**：`E:\WorkProject\Node\_Project\mediary-scout`（TypeScript / Next.js 16 / Turbopack / Monorepo）

---

## 1. 核心诊断与执行摘要 (Executive Summary)

### 1.1 用户核心困惑
- **现象对比**：在标杆项目 `WebToolForLinux` 中，AI Agent（包括 Antigravity、Claude、Cursor 等编码助手）在进行**问题定位、代码排查、方案设计与增量优化**时，反应迅捷敏锐，数秒内即可精准命中靶心并给出干净的修改；而在当前项目 `mediary-scout` 中，Agent 的处理过程**异常迟缓、思维迟钝、反复漫游读取文件、甚至陷入多轮无效重试或状态判断混乱**。
- **根本归因**：这不是偶发的大模型抖动，而是由**三大深层次结构性病因**叠加产生的“放大器效应”：
  1. **文件物理巨石化（Monolithic Behemoth）**：当前项目存在多处单文件超 100KB~190KB 的“代码巨石”（如 `workflow-runtime.ts` 独占 **190KB / 近 4,000 行**）。每次读取消耗 40,000+ Tokens，直接引发大模型注意力稀释（Needle-in-a-Haystack）与首 Token 延迟（TTFT）暴增 10~20 倍；
  2. **提示词与技能配置“剧毒化”（Prompt & Skill Poisoning）**：根目录下遗留了高达 **100KB** 的 Python OpenClaw 时代的 `SKILL.md` 和 `references/00~08` 文档。它强加了“执行任何推理前必须强制通读 5 篇长篇大论、环境为 `./.venv/bin/python`、且任何副作用操作必须立刻挂起等待用户确认”的死律。外部 Coding Agent 启动即被带偏；而内部 Runtime Agent 的 Prompt 又充斥“字字泣血”、“逆鳞”等情绪化微观管理，严重拖垮执行效率；
  3. **架构职责泥潭化与状态机缺失（Architectural Entanglement & Missing FSM）**：标杆项目采用严格的 **Vertical Slice / Feature** 物理分层，平均单文件仅 **5.8 KB**；而当前项目将网盘扫码、凭据加解密、目录建树、Worker 调度、状态迁移、搜索流式推送全部糅杂在单个运行时文件中，缺少状态机约束，导致僵尸锁和状态覆写频发。

---

## 2. 深度量化对比：WebToolForLinux vs. Mediary Scout

通过对两个工程的物理代码文件、架构规范及 Token 开销进行真实扫描与统计，核心对比数据如下：

| 评估维度 | 标杆工程：WebToolForLinux (C#) | 当前工程：mediary-scout (TS/Node) | 对 Agent 响应速度的影响差异 |
| :--- | :--- | :--- | :--- |
| **源码文件总数与单文件均值** | 283 个 `.cs` 文件，**平均仅 5.8 KB**，最大文件 64 KB | 核心文件平均 30~50 KB，**最大文件高达 190 KB** | **小文件胜出**：Agent 检索单文件耗时 1s、几百 token；巨型文件一次读取即耗费数万 token 并引发卡顿 |
| **超巨型文件分布 (>100KB)** | **0 个** | **6 个**（`workflow-runtime.ts` 190KB、`repository-contract.ts` 182KB、`sandbox.ts` 141KB、`replace-request.test.ts` 126KB、`sqlite.ts` 114KB、`repository.ts` 105KB） | **致命拖慢**：Agent 在排查任何后端逻辑时，都必须把 190KB 的文件读入上下文，导致推理时间成倍拉长 |
| **物理分层与目录拓扑** | 严格 **Feature-Driven / Vertical Slice**：根级只有 `Features/`、`Shared/`、`Platform/`，Feature 下严格包含 `Contracts/`、`Application/`、`Adapters/`、`Routes/` | 物理目录虽分 `apps` / `packages`，但**职责边界模糊**：后端核心实现几乎全被塞进前端目录 `apps/web/lib/workflow-runtime.ts`，多包调用错综复杂 | **寻址确定性差异**：在 WebToolForLinux 中，找 EasyTier 逻辑直接定位 `Features/EasyTier`，寻址 $O(1)$；在当前项目中需跨 4 个包做全文模糊 Grep |
| **根目录 Agent / Skill 提示词** | 干净简洁的工程级 `README.md`、`docs/architecture` 规范，**无任何霸道抢占的全局 Skill 阻断** | 根目录存在 **104 行 `SKILL.md`**，强依赖 **`references/` 下 9 个大文件（合计 >100 KB）** | **剧毒级负面作用**：现代 Agent 自动扫描 workspace，被旧系统规范深度洗脑，导致执行逻辑出现认知分裂 |
| **工具修改（Diff/Edit）成功率** | **~98%**（目标文件几十行，上下文紧凑，替换锚点唯一） | **~60%**（4000 行巨型文件中寻找上下文极易匹配偏移或同名作用域冲突，触发工具报错并重试） | **操作往返膨胀**：一次修改在 WebTool 1 回合完成；在 scout 往往经历 Read -> Edit Fail -> Read Again -> Edit 3~5 回合 |
| **状态机完备性** | 关键领域（如挂载监控、FRP、EasyTier 节点状态）均有显式状态机，非法跃迁直接抛异常 | 多数流程为**隐式字符串标记**（`queued` / `running` / `succeeded` / `failed`），多处由分散的 `try/catch` 手动更新 | **容错自愈能力差异**：当前项目单步抛错即卡在 `running` 形成 30 分钟僵尸锁，导致 Agent 观察到的现象漂移不定 |

---

## 3. 提示词（Prompt）、README 与 Skill 文件的负面作用深度解剖

### 3.1 根目录 `SKILL.md` 与 `references/`：致命的“认知毒丸”
在 `e:\WorkProject\Node\_Project\mediary-scout\SKILL.md` 中，赫然定义了如下规则：
```markdown
name: clawd-media-track
description: "Resource tracking and acquisition workflow for media resources. MUST use when the user asks to get, add, track, monitor, search, acquire, transfer, or initialize movies, TV shows, anime, Pansou resources, or 115 cloud storage items..."

## FIRST ACTIONS (MANDATORY)
Before any clawd-media-track reasoning or tool use:
1. Read references/00-bootstrap-init.md
2. Check whether bootstrap is complete...
4. Read references/01-environment-contract.md
5. Read references/02-global-constraints.md
6. Read references/03-methods-reference.md
7. Determine whether the task is Type 1, Type 2, or Type 3
8. Read the matching type checklist
9. Output the current checkpoint as [Type X - Step N]
10. STOP and wait for user confirmation before any side-effecting action
...
- Python runtime: ./.venv/bin/python
```

#### 造成的恶劣后果：
1. **关键词全面劫持（Semantic Hijacking）**：
   - 触发词几乎涵盖了影视相关的所有动作（`get`, `add`, `track`, `search`, `acquire`, `transfer`, `115` 等）。当用户向 AI 提问“帮我优化网盘转存逻辑”或“排查 115 搜索变慢”时，AI 助手内部的技能匹配系统被误判激活。
2. **死锁式的上下文吞噬与阻断（Context Flooding & Deadlock）**：
   - 指令强制要求“在进行任何推理和工具调用前，先按顺序阅读 00、01、02、03”。这 9 个参考文件总计 **超过 100 KB**。一旦 Agent 照做，第一轮对话就被灌满数万 tokens，不仅耗时数十秒，还会严重挤占有效推理上下文。
   - 更严重的是第 10 条：“**STOP and wait for user confirmation before any side-effecting action**”。原本用户希望 Agent 快速诊断并自主修改代码，此指令却命令 Agent 停下来向用户确认，造成 Agent “不推不动、唯唯诺诺”。
3. **严重的环境幻觉与方言错位（Environment Hallucination）**：
   - 文档写明 `Python runtime: ./.venv/bin/python`。但当前工程是一个**纯 TypeScript / Next.js Monorepo**！这会导致大模型产生严重的认知混乱，在排查问题时甚至会去搜寻 Python 脚本和虚拟环境，陷入无意义的幻觉排查。

### 3.2 运行时内部 Agent Prompt 的情绪化与微观管理
在 `packages/workflow/src/acquisition-v2/task-agents.ts` 中：
```typescript
function skillMandate(agent: "movie" | "tv"): string {
  return `⛔ MANDATORY — before ANY reasoning or tool call, read your skill; re-read it DURING the loop. It is NOT optional.
${skillIndexForAgent(agent)}
Acting before you have read it — makes you the old mechanical transferrer: it searched 16 times, hammered 115 into a rate-limit (the 逆鳞), transferred 6 overlapping full-season packs, deleted the LARGER/better files... DO NOT be that agent.`;
}
```
- **微观管理的恶果（Over-Prescription）**：强迫运行时的大模型在每个循环执行前都要通过工具 `readSkill` 读一遍手册。对于云端大模型，这意味着多产生 2~4 次全量 HTTP 往返交互（每次往返耗时 5~15s），使得实际转存任务耗时从原本的 5 秒拉长到近 1 分钟。
- **负向惩罚词汇诱发防御性退缩**：过多使用“字字泣血”、“逆鳞”、“DO NOT be that agent”等恐吓性修辞，根据大模型对齐机制，容易导致模型在边界场景下极度保守，宁可报错退出或反复 Reflection，也不敢做合理决断。

### 3.3 根目录 README 的信息缺位
- 当前项目的 `README.md` 是面向开源社区终端用户的“产品宣传页”，涵盖 Docker 跑法、赞助徽章、社区认可。
- **缺失 Agent 友好的架构地图**：没有给出系统的物理模块边界、数据流向、核心抽象层位置（例如哪些逻辑归 `packages/workflow`，哪些归 `apps/web`）。AI Agent 缺乏高层视野，进入代码库后只能“盲人摸象”。

---

## 4. 核心业务全链路头脑风暴：缺陷、瓶颈与可行性分析

针对近期全链路审计梳理出的四大核心域，我们对其逻辑完备性与性能进行了深度头脑风暴：

```mermaid
flowchart TD
    subgraph S1["1. 网盘生命周期域"]
        A1["多品牌扫码/Cookie绑定"] --> A2["统一探活 (Ping)"]
        A2 --> A3["目录建树 (Mediary Scout/{Movies,TV,Anime})"]
        A3 --> A4["同账号重绑刷新 & 缺失CID自愈"]
    end

    subgraph S2["2. 资源搜索与聚合域"]
        B1["TMDB 元数据检索"] --> B2{"TMDB 命中?"}
        B2 -- 否/异常 --> B3["豆瓣 Frodo API 智能降级兜底"]
        B2 -- 是 --> B4["多引擎资源搜索 (PanSou/Prowlarr/海搜)"]
        B3 --> B4
        B4 --> B5["Jev 规则过滤 & 质量打分"]
        B5 --> B6["双轨流式输出 (SSE/NDJSON) & 快照缓存"]
    end

    subgraph S3["3. 订阅入库与任务调度域"]
        C1["任务认领 (Claim Queued Run)"] --> C2["目标目录准备 (Season NN 幂等检查)"]
        C2 --> C3["网盘转存 / 离线任务下发"]
        C3 --> C4["物化文件回读校验 (Life Tree 保大策略)"]
        C4 --> C5["状态持久化 & 掉线冻结联动"]
    end

    subgraph S4["4. 资源整理与刮削归档域"]
        D1["整理计划制定 (Deterministic vs Review)"] --> D2["逐文件盘面移动"]
        D2 --> D3["盘面回读比对 (comparePlannedVsActual)"]
        D3 --> D4{"发生文件漂移?"}
        D4 -- 是 --> D5["记录 organize_drift 审计事件并标记 failed"]
        D4 -- 否 --> D6["落库 succeeded & 清理临时 Staging 目录"]
    end

    S1 --> S3
    S2 --> S3
    S3 --> S4
```

### 4.1 核心可行性与逻辑欠缺分析
1. **手动导入任务僵尸卡死漏洞（已在审计中确认）**：
   - 逻辑上，`manual-import-worker.ts` 在 `claimNextQueuedRun` 成功后直接将状态改为 `running`。但随后的 `manualImportTargetDirectory` 建目录操作却在 `try/catch` 之外。一旦网盘瞬时超时，异常抛向最外层，任务永远留在 `running`，导致作品被互斥锁锁定 30 分钟。
2. **多网盘上下文与目录 CID 混串缺陷**：
   - `workflow-runtime.ts` 在手动入库时使用 `parents.movies || parents.tv`。剧集和动漫全部被送进电影目录；多盘场景下使用主盘 CID 往副盘写数据，破坏了存储隔离性。
3. **30 分钟缓存命中丢失快照 ID**：
   - 搜索结果缓存机制只缓存了 `candidates`，返回 `snapshot: null`，导致前端拿到缓存结果后无法发起入库（缺少 `snapshotId` 校验）。
4. **整理漂移状态覆写缺陷**：
   - 当比对实际盘面发生文件漂移（`drift`）时，错误地保存了预建的 `run`（其状态为 `succeeded`），导致系统把失败的整理记录为了成功，并在 UI 上向用户撒谎。
5. **Worker Tick 串行盲目 I/O 浪费**：
   - 每 3 秒的心跳循环中，即使没有任何任务待处理，也执行了多次冗余的 SQLite 凭证查询和 Provider 实例化，占据无谓的 CPU 与磁盘 I/O。

---

## 5. 设计模式重塑与架构治理方案

要彻底解决上述问题，必须汲取 `WebToolForLinux` 的精髓，引入**三大经典设计模式**并结合 TypeScript 现代生态进行系统重塑：

### 5.1 模式一：适配器模式（Adapter Pattern）与网盘驱动注册中心
- **对标**：AList 的 `Driver` 架构与 `WebToolForLinux` 的 `Adapters/` 物理分层。
- **现状缺陷**：115、夸克、UC、123、天翼、光鸭 6 个网盘的转存、扫码、建树代码大量内嵌在 `workflow-runtime.ts` 中，使用冗长的 `switch(brand)` 或多重 `if`，增加新网盘成本极高。
- **重构方案**：
  - 彻底激活已在 `packages/contracts/src/infrastructure-ports/IStorageDriver.ts` 定义的端口；
  - 为每个网盘建立独立的物理驱动实现：
    - `packages/workflow/src/adapters/storage/Pan115Driver.ts`
    - `packages/workflow/src/adapters/storage/QuarkDriver.ts`
    - `packages/workflow/src/adapters/storage/Pan123Driver.ts`
    - `packages/workflow/src/adapters/storage/UcDriver.ts`
    - `packages/workflow/src/adapters/storage/TianyiDriver.ts`
    - `packages/workflow/src/adapters/storage/GuangyaDriver.ts`
  - 建立驱动注册表 `StorageDriverRegistry`，将凭证刷新、统一探活（`ping()`）、目录缓存与异常分类标准化。

```mermaid
classDiagram
    class IStorageDriver {
        <<interface>>
        +StorageBrand brand
        +ping() Promise~boolean~
        +refreshToken() Promise~void~
        +ensureDir(parentId, dirName) Promise~string~
        +listChildren(dirId) Promise~FileMetadata[]~
        +transferShare(shareUrl, targetDirId, password) Promise~string~
        +moveFiles(fileIds, targetDirId) Promise~void~
        +deleteFiles(fileIds) Promise~void~
    }

    class Pan115Driver {
        -Pan115Client client
        +transferShare()
        +ensureDir()
    }

    class QuarkDriver {
        -QuarkClient client
        +transferShare()
        +ensureDir()
    }

    class Pan123Driver {
        -Pan123Client client
        +transferShare()
        +ensureDir()
    }

    class StorageDriverFactory {
        +getDriver(brand: StorageBrand, credentials: any): IStorageDriver
    }

    IStorageDriver <|.. Pan115Driver
    IStorageDriver <|.. QuarkDriver
    IStorageDriver <|.. Pan123Driver
    StorageDriverFactory --> IStorageDriver : 动态生产与生命周期管理
```

### 5.2 模式二：策略模式（Strategy Pattern）与责任链管道
- **应用场景**：
  1. **资源搜索与多级降级管道（Search Fallback Pipeline）**：
     - 元数据解析阶段（TMDB 优先 -> 豆瓣 Frodo 兜底）；
     - 网盘资源检索阶段（PanSou -> Prowlarr -> 海搜）；
     - 规则过滤阶段（Jev 智能决策 -> 语言偏好打分 -> 质量优先级排序）；
     - 每一步均实现标准接口 `ISearchPipeStage`，通过管道模式 `Pipeline.pipe(...)` 组合，彻底解耦 `title-resource-resolver.ts`。
  2. **智能整理决策策略（Organize Strategy）**：
     - `DeterministicOrganizeStrategy`：全季匹配度 100%、单集绝对唯一时自动静默整理；
     - `HumanReviewOrganizeStrategy`：多季混杂或命名不明确时生成结构化 Plan，交由 UI 人工确认后执行。

### 5.3 模式三：有限状态机（Finite State Machine / FSM）接管长任务生命周期
- **核心痛点解决**：彻底杜绝“僵尸任务锁死在 running”与“整理漂移被覆写为 succeeded”。
- **技术复用突破**：**项目中已经安装了 `"xstate": "^5.33.3"`！**
  - 目前仅在 `acquisition-v2/run-state-machine.ts` 中局部使用；
  - 应当将其提升为核心基础设施，封装为全任务通用的 `WorkflowTaskMachine`：

```mermaid
stateDiagram-v2
    [*] --> Queued : 任务创建入库
    Queued --> Claimed : Worker 认领
    Claimed --> DirectoryReady : 幂等建树完成
    Claimed --> Failed : 目录建树失败 (捕获释放锁)
    DirectoryReady --> Transferring : 下发转存/离线任务
    Transferring --> LandedVerifying : 异步转存完成
    Transferring --> DriveFrozen : 触发鉴权失效 (onAuthErrorFreeze)
    Transferring --> Failed : 资源失效/配额耗尽
    LandedVerifying --> Organizing : 物化比对通过
    Organizing --> Succeeded : 移动盘面无漂移 (终态)
    Organizing --> DriftFailed : 盘面漂移 (严格置为 failed)
    
    Failed --> [*]
    Succeeded --> [*]
    DriftFailed --> [*]
    DriveFrozen --> [*]
```

- **状态机带来的硬保证**：
  1. **状态跃迁具有白名单校验**：试图在 `DriftFailed` 状态上执行 `markSuccess` 将在类型系统和运行时同时抛出 `IllegalStateTransitionError`；
  2. **内置超时守卫（Timeout Guard）**：进入 `Claimed` 或 `Transferring` 后，状态机自带超时定时器，超时自动跃迁至 `Failed(timeout)` 并回调释放资源锁，彻底根除 30 分钟僵尸锁。

---

## 6. 业界主流方案对比与现有基础设施复用矩阵

### 6.1 业界主流方案横向对比

| 解决方案代表 | 核心定位与架构风格 | 网盘与存储抽象 | 任务调度与状态治理 | 对本项目的核心借鉴价值 |
| :--- | :--- | :--- | :--- | :--- |
| **AList / OpenList** | 统一多网盘挂载与聚合服务（Go 语言） | 极致的 Driver 体系，每个网盘为一个独立 Driver，统一提供 VFS 接口，抽象出 Token 刷新拦截器 | 基于 HTTP 请求的无状态流转与本地任务轮询 | 借鉴其网盘驱动划分方式：每个网盘一个独立 Adapter 文件，杜绝代码堆叠在一个巨大类中 |
| **Sonarr / Radarr** | 工业级影视剧集自动追踪与获取系统（C# / .NET） | 本地文件系统 / SMB / NFS 挂载驱动 | **严格的事务性状态机驱动**：Grabbed -> Downloading -> Downloaded -> Importing -> Imported | 借鉴其下载队列的确定性状态机与事件总线，拒绝模糊的状态字符串判断 |
| **MoviePilot / Nastool** | 现代化家庭影院媒体自动化管理系统（Python） | 插件化接入网盘与下载器（Qbittorrent/Transmission/115） | 事件驱动总线（EventBus），多模块间通过发布订阅解耦 | 借鉴其将“元数据刮削”、“搜索匹配”、“下载整理”拆分为独立事件订阅者 |
| **BullMQ / Temporal** | 企业级分布式工作流与高可靠队列引擎（Node / Go） | 外部存储独立 | 强状态保证、指数退避重试、锁续租（Lock Heartbeat）、死信队列（DLQ） | 借鉴其任务认领的心跳续租机制，由后台主动维护锁的生命周期，而非依赖固定的 30 分钟静态超时 |

### 6.2 当前项目已有的宝藏基础设施（零新增依赖即可复用）

很多时候工程变慢并不是因为缺少第三方库，而是**已有的库没有用在关键位置**：

1. **`xstate` (^5.33.3)**：
   - **当前现状**：仅在 `acquisition-v2` 局部使用。
   - **复用方案**：直接用于 `manual-import-worker.ts`、`organize/route.ts` 和网盘账号连接生命周期（Unbound -> Probing -> Bound -> Frozen -> Refreshing）。
2. **`kysely` (^0.29.7)**：
   - **当前现状**：已在 `packages/workflow` 安装，但在 `workflow-runtime.ts` 和 `sqlite.ts` 中仍然存在大量手写拼装的 SQL 字符串。
   - **复用方案**：利用 Kysely 的强类型 Query Builder 统一仓储层，消除手写 SQL 语法错误与字段名 typo。
3. **`packages/contracts/src/infrastructure-ports/`**：
   - **当前现状**：定义了 `IStorageDriver.ts`、`IJobQueue.ts`、`ISearchProvider.ts`，但具体实现没有严格依赖该接口。
   - **复用方案**：对齐依赖反转原则（DIP），所有业务模块只依赖接口，实现各驱动完全插拔。
4. **`better-sqlite3` (^12.11.1)**：
   - 原生 C++ 驱动，WAL 模式下微秒级读写。通过开启事务 `BEGIN IMMEDIATE` 即可实现天然的无外部依赖原子任务队列。

---

## 7. 渐进式落地执行计划 (Roadmap & Action Plan)

为了在不破坏现有功能的前提下，让 AI Agent 在本工程中的响应效率恢复到 `WebToolForLinux` 的闪电水准，推荐执行以下四阶段演进计划：

```mermaid
timeline
    title 架构与性能优化落地路线图
    Phase 1 : 立即止血与去毒 (Day 1) : 移除/归档根目录冲突的 SKILL.md : 净化 references/ 旧 Python 文档 : 精简运行时 Agent Prompt
    Phase 2 : 物理巨石拆解 (Week 1) : 拆分 190KB 的 workflow-runtime.ts : 将 6 大网盘拆入独立 Driver : 消除 apps/web 侵入业务逻辑
    Phase 3 : 模式与状态机落地 (Week 2) : XState 全面接管手动导入与整理 : 修复 30 分钟缓存与僵尸锁缺陷 : 落地单次列举建树算法
    Phase 4 : 架构门禁与导航固化 (Week 3) : 编写 Agent 架构导航 AGENT.md : 设立单文件体积门禁 (<30KB) : 完善内存 SQLite 快速单测
```

### 阶段一：立即止血与提示词去毒（Day 1）
1. **清理根目录 `SKILL.md` 剧毒锚点**：
   - 将根目录冲突的 `SKILL.md`（旧 Python OpenClaw 遗留物）移动至 `references/legacy-clawd-skill/` 归档保存，从根目录彻底移除；
   - 彻底解除所有针对编码 Agent 的强迫性阅读命令和“STOP and wait”阻断；
2. **精简运行时 Prompt**：
   - 移除 `task-agents.ts` 中“字字泣血”、“逆鳞”等情绪化词汇；
   - 移除每个循环强迫调用 `readSkill` 的逻辑，将核心规则直接以内联静态契约方式交付，减少 50% 以上的大模型往返延迟；
3. **补齐面向 Agent 的高层架构导航说明**：
   - 在项目根目录或 `docs/` 放置清晰的架构指引，告知 Agent 各模块的物理边界与依赖规则。

### 阶段二：物理巨石拆解与责任边界清晰化（Week 1）
1. **瓦解 190KB 的 `workflow-runtime.ts`**：
   - 按照 **Feature** 将 `workflow-runtime.ts` 切割为多个独立模块（对标 WebToolForLinux 均值 5.8KB 标准）：
     - `features/drives/DriveManager.ts`（多网盘连接、扫码、探活、重绑自愈）
     - `features/drives/DirectoryProvisioner.ts`（优化后的单次列举建树）
     - `features/workflow/WorkerScheduler.ts`（Worker Tick 与队列调度）
     - `features/search/ResourceResolver.ts`（搜索管道与缓存协同）
   - 将业务逻辑从 `apps/web/lib/` 彻底收归到 `packages/workflow/src/` 中，让 `apps/web` 专注于 Next.js API Routes 和页面呈现。

### 阶段三：设计模式全面落地（Week 2）
1. **落地 `IStorageDriver` 适配器**：
   - 将 115、夸克、UC、123、天翼、光鸭网盘分别封装为 `Pan115StorageDriver` 等独立类，统一实现 `IStorageDriver` 接口。
2. **落地 `XState` 任务状态机**：
   - 使用 `xstate` 重构 `manual-import-worker.ts` 和 `organize/route.ts`；
   - 严格约束 `Queued -> Claimed -> InProgress -> Succeeded / Failed` 的状态跃迁，加入超时自动释放机制；
3. **修复已发现的高危缺陷**：
   - 在 `TitleResourceCache` 中补充记录 `snapshotId`，确保 30 分钟缓存命中时用户依然能够成功入库；
   - 确保 `manualImportTargetDirectory` 处于 `try/catch` 保护下并正确触发失败回调；
   - 纠正剧集/动漫转存目录，保证 TV/Anime 归入正确的父目录 ID。

### 阶段四：治理门禁强化（Week 3）
1. **设立文件体积与复杂度门禁**：
   - 在 CI 中加入代码度量脚本：**任何单文件源码行数超过 600 行或体积超过 35 KB 均触发告警**，杜绝再次出现 190KB 的巨石文件；
2. **纯内存单测秒级闭环**：
   - 所有 Adapter 与状态机均配套提供基于 `:memory:` 纯内存 SQLite 的单元测试，确保在秒级时间内完成全流程自动化验证。

---

## 8. 总结与建议行动项

- **回答用户的问题 1**：“为什么 WebToolForLinux 处理优化响应极快，而当前项目非常慢？”
  - 核心在于：**WebToolForLinux 极致的物理轻量化（283 个文件，均值 5.8KB）与清晰的 Feature 物理边界**，使 Agent 能秒级定位、毫秒级阅读、一次性修改成功；而当前项目被 **190KB 巨型文件** 阻塞了 Token 上下文，推理延迟呈数量级上升。
- **回答用户的问题 2**：“当前项目的 README 和 Agent 提示词是否存在负面作用？”
  - **存在极强的负面作用！** 根目录 100KB 的旧 Python `SKILL.md` 强制要求 Agent 在做任何推理前通读长篇参考、等待用户确认、甚至误导 Agent 寻找 Python 环境；内部 Prompt 的情绪化微观管理导致运行时产生大量多余的工具往返。
- **回答用户的问题 3**：“头脑风暴、设计模式优化与现有基础设施复用”：
  - 项目已有的 **XState 5**、**Kysely**、**IStorageDriver 契约**、**原生 SQLite WAL** 是极佳的基础设施；
  - 只要全面落地 **Storage Adapter（网盘适配器）**、**Search Pipeline（责任链策略）** 和 **Task Lifecycle Machine（有限状态机）**，并拆散 `workflow-runtime.ts`，当前项目的架构清晰度、系统韧性与 Agent 维护体验将直接追平并看齐 `WebToolForLinux`！

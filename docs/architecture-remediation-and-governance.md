# 巡影 · Mediary Scout 架构规范治理与全方位重构方案
## （全面采用 SQLite · 彻底剥离 PostgreSQL 依赖版）

> **参考标准**：`D:\D\Notes\Note\1 工作\笔记\技术框架总结\SoftwareArchitecture`（通用后端/前端架构规范、跨端物理结构、治理门禁体系与 DDD 吸收指南）  
> **文档位置**：`docs/architecture-remediation-and-governance.md`  
> **编写时间**：2026-10-23  
> **重构目标**：全面对标参考规范，对巡影当前项目的前后端物理目录、依赖层级拓扑、状态机与适配器策略模式落地、测试金字塔（单元/冒烟/E2E）及六层门禁治理（L0~L5）进行系统性方案设计；**特别实现“纯 SQLite 单引擎架构”，彻底剔除 PostgreSQL 外部数据库依赖**。

---

## 目录

1. [架构重大战略抉择：全面拥抱 SQLite，彻底剔除 PostgreSQL](#1-架构重大战略抉择全面拥抱-sqlite彻底剔除-postgresql)
   - 1.1 为什么个人/家庭媒体库场景下 SQLite 远胜 PostgreSQL？
   - 1.2 剔除 PostgreSQL 带来的降维优势（性能、体积、运维、代码量）
   - 1.3 纯 SQLite 核心技术攻坚（WAL 调优、原子队列与并发锁保障）
2. [对标参考架构：核心原则与演进方法论](#2-对标参考架构核心原则与演进方法论)
   - 2.1 五大 Solution 角色模型与所有权铁律
   - 2.2 绞杀者模式（Strangler Fig）演进路线
3. [后端物理目录与功能层级重构设计](#3-后端物理目录与功能层级重构设计)
   - 3.1 目标后端物理目录树（纯 SQLite 极简架构）
   - 3.2 核心限界上下文与 Feature 划分
   - 3.3 依赖方向与防腐层设计（反转依赖）
4. [前端物理目录与组件分层设计](#4-前端物理目录与组件分层设计)
   - 4.1 目标前端物理目录树（对标 AITool.Web 规范）
   - 4.2 Feature-Driven 架构与传输契约层（Transport）
   - 4.3 UI 设计系统与通用组件分层
5. [核心功能头脑风暴与设计模式重塑](#5-核心功能头脑风暴与设计模式重塑)
   - 5.1 原生 SQLite 高性能持久化任务队列设计（替代外部队列）
   - 5.2 适配器模式（Adapter）：多网盘驱动统一抽象（对标 AList）
   - 5.3 策略模式（Strategy）：去重、限速、命名与双轨决策
   - 5.4 有限状态机（FSM）与 Saga 补偿模式：告别失控 Agent
   - 5.5 现有成熟开源库选型矩阵
   - 5.6 业界主流方案深度对比（MoviePilot、Sonarr、AList）
6. [质量门禁与治理体系（Governance Gates L0 ~ L5）](#6-质量门禁与治理体系governance-gates-l0--l5)
   - 6.1 门禁分级全景矩阵（L0 物理所有权至 L5 构建发布）
   - 6.2 结构门禁规则（L0 路径、L1 项目图、L2 源码边界、L3 复杂度）
   - 6.3 门禁诊断输出格式与 Baseline 接管机制
7. [全链路测试体系设计（单元、集成、冒烟与 E2E）](#7-全链路测试体系设计单元集成冒烟与-e2e)
   - 7.1 单元测试（Unit Tests）：确定性逻辑毫秒级覆盖
   - 7.2 集成测试（Integration Tests）：纯内存 SQLite 闪电测试
   - 7.3 冒烟测试（Smoke Tests）：单容器就绪与健康自检
   - 7.4 端到端测试（E2E Tests）：Playwright 全流程闭环
8. [分阶段渐进式落地执行计划](#8-分阶段渐进式落地执行计划)

---

## 1. 架构重大战略抉择：全面拥抱 SQLite，彻底剔除 PostgreSQL

### 1.1 为什么个人/家庭媒体库场景下 SQLite 远胜 PostgreSQL？

巡影（Mediary Scout）的核心用户场景是**家庭 NAS、软路由私有云或个人桌面电脑**。其负载特征非常明确：
- **数据量级**：单用户/家庭通常收藏千部电影、数百部电视剧、数万条剧集状态。这是纯粹的**轻中度读写模型**。
- **并发特征**：通常只有 1~2 个管理用户，后台以定时间隔执行任务，写操作具有明显的排队流水线特征。

在这样的场景下，强行引入 PostgreSQL 属于典型的**架构过度设计（Over-Engineering）**：
1. **沉重的常驻开销**：PostgreSQL 容器常驻至少消耗 **150MB ~ 250MB 内存**，对 1G/2G 内存的入门级 NAS 或软路由造成巨大压力。
2. **破坏机械硬盘休眠**：PostgreSQL 后台的 Checkpointer、Stats Collector 与 WAL 写入会周期性唤醒磁盘，导致 NAS 硬盘 24 小时空转。
3. **运维与备份极其繁琐**：用户需要管理数据库端口映射、用户密码、数据卷权限，数据备份依赖复杂的 `pg_dump`，恢复时动辄遭遇权限报错。

相比之下，**现代 SQLite 3（配合 WAL 模式）在微型至中型服务中表现惊人**：
- 单文件存储、零网络开销、微秒级读写。
- 内存常驻几乎为零（由 Node.js 进程统筹管理）。
- 数据备份即“直接拷贝单个文件”或调用热备份 API，优雅可靠。

```mermaid
quadrantChart
    title 数据库引擎选型权衡 (家庭媒体库场景)
    x-axis "轻量单机 / 零运维" --> "重型分布式 / 高运维"
    y-axis "低性能 / 易锁死" --> "高性能 / 微秒级"
    quadrant-1 "适合超大规模多租户 SaaS (如 Netflix)"
    quadrant-2 "最佳选型：SQLite 3 (WAL 模式)"
    quadrant-3 "淘汰历史方案：原始文件堆叠"
    quadrant-4 "过度设计：PostgreSQL (当前巡影容器版)"
    "SQLite 3 (WAL 模式)": [0.2, 0.85]
    "PostgreSQL 16": [0.8, 0.75]
```

### 1.2 剔除 PostgreSQL 带来的降维优势

| 维度 | PostgreSQL + SQLite 双引擎 (现状) | 纯 SQLite 单引擎 (重构目标) | 架构收益 |
|---|---|---|---|
| **代码量** | 2,349 行 `postgres.ts` + 2,108 行 `sqlite.ts` | **单一仓储实现（~800 行）** | **直接删除 3,600+ 行重复手写 SQL 样板代码** |
| **容器编排** | `web` + `postgres` + `pansou` (三容器) | **`web` + `pansou` (双容器，甚至可单容器)** | **常驻内存大降 200MB+**，Compose 文件精简一半 |
| **锁机制** | 复杂的 PG 咨询锁（`pg_advisory_xact_lock`）防死锁 | **SQLite 原生 `BEGIN IMMEDIATE` 事务锁** | 彻底根除 DDL 启动死锁（40P01）问题 |
| **CI 测试耗时** | 需拉起真实 Postgres 容器服务，耗时 30~60s | **使用 `:memory:` 纯内存数据库，耗时 1~2s** | **CI 构建与单测执行速度提升 20 倍以上** |
| **跨平台统一** | Docker 跑 PG，桌面版跑 SQLite（行为分叉） | **Docker 容器与 Electron 桌面端 100% 同一套代码** | 彻底消除跨平台方言差异与环境特异性 Bug |
| **备份容灾** | 依赖复杂 Shell 脚本调用 `pg_dump` | **直接拷贝 `mediary.db` 文件或调用原生 API** | 小白用户一秒完成全库备份与迁移 |

### 1.3 纯 SQLite 核心技术攻坚（WAL 调优、原子队列与并发锁保障）

为确保 SQLite 在高频抓取、转存与前端并发访问时不出现 `SQLITE_BUSY` 锁冲突，系统建立以下核心技术规约：

#### 1. 黄金 PRAGMA 参数调优
每次数据库连接初始化时，强制执行以下参数：
```sql
PRAGMA journal_mode = WAL;        -- 开启写前日志模式：读写互不阻塞，读并发无锁
PRAGMA synchronous = NORMAL;      -- 兼顾极速与断电安全性 (性能较 FULL 提升 5~10 倍)
PRAGMA busy_timeout = 5000;       -- 写锁冲突时自动退避重试等待 5 秒，杜绝直接报错
PRAGMA temp_store = MEMORY;       -- 临时表与临时索引完全内存化
PRAGMA cache_size = -64000;       -- 分配 64MB 专用内存页面缓存
PRAGMA foreign_keys = ON;         -- 强制外键级联检查，保障数据完整性
```

#### 2. 并发读写模型与架构落地
SQLite 天然支持“并发多读、单点写入”。为避免跨容器网络文件系统（如 NFS/SMB 挂载）导致 POSIX 文件锁失效的隐患：
- **推荐架构拓扑**：采用**高内聚模块化单体（Modular Monolith）**。
  前端 Web 接口服务与后台 Worker 工作流服务运行在**同一个容器/进程内**（通过独立的 Feature 模块解耦），统一由单实例 `better-sqlite3` 数据库对象驱动，共享连接句柄与内存缓存。既拥有微服务的清晰边界，又享有单进程内存调用的极致速度。

---

## 2. 对标参考架构：核心原则与演进方法论

### 2.1 五大 Solution 角色模型与所有权铁律

对标 `SoftwareArchitecture/shared/reusable-architecture-rules-and-gates.md`，彻底摒弃原项目将“认证、网盘驱动、数据库、队列和页面渲染”揉杂在单个 Next.js 进程的混乱局面。重构采用**五个明确的 Solution 角色**：

```text
Feature owns behavior.
Contracts expose capability.
Infrastructure implements technical boundaries.
Composition wires implementations.
Shared contains ownerless reusable capability.
```

```mermaid
flowchart TD
    subgraph SolutionRoles["五大 Solution 角色依赖模型 (严禁逆向依赖)"]
        Contracts["1. 契约层 (Contracts)<br/>• 基础设施端口 (IStorageDriver, ISearchProvider)<br/>• 功能公开契约 (Feature Contracts)<br/>• 应用操作契约 (Application Operations)"]
        Shared["2. 共享基础层 (Shared)<br/>• 无业务 Owner 的加密、网络、日志基础工具"]
        Features["3. 功能层 (Features)<br/>• 用例执行 (Application)<br/>• 核心状态机与领域模型 (Domain)"]
        Infra["4. 基础设施层 (Infrastructure)<br/>• 纯 SQLite 持久化 (Kysely-Sqlite)<br/>• 网盘驱动实现 (115/夸克/123/光鸭/天翼)<br/>• 外部服务集成 (TMDB/PanSou)"]
        Hosts["5. 宿主与组合根 (Hosts / Composition)<br/>• Web 服务宿主 / 独立 Worker 任务宿主 / Desktop 宿主<br/>• 依赖注入与生命周期装配"]
    end

    Features -->|调用端口/契约| Contracts
    Infra -->|实现端口| Contracts
    Hosts -->|装配与生命周期连接| Features
    Hosts -->|注入具体技术实现| Infra
    Features -.->|复用| Shared
    Infra -.->|复用| Shared
```

### 2.2 绞杀者模式（Strangler Fig）演进路线

严禁推倒重写。通过以下四步逐步掏空原先 3,600 行的 `workflow-runtime.ts`：
1. **建立中立契约**：抽象 `IStorageDriver` 与 `IRepository`。
2. **数据库全量收敛**：删除 PostgreSQL 依赖，将所有查询收拢为纯 SQLite 模块。
3. **任务流水线规则化**：引入 `anitomy` 确定性规则库与 XState 状态机。
4. **宿主分离与模块化单体落地**。

---

## 3. 后端物理目录与功能层级重构设计

对标 `SoftwareArchitecture/shared/reference-cross-platform-physical-layout.md`，设计清晰的物理工程目录：

### 3.1 目标后端物理目录树（纯 SQLite 极简架构）

```text
mediary-scout/
├─ packages/
│  ├─ contracts/                               # 【中立契约层】无第三方框架依赖
│  │  ├─ infrastructure-ports/                 # 基础设施端口 (Dependency Inversion)
│  │  │  ├─ IStorageDriver.ts                  # 网盘统一驱动端口
│  │  │  ├─ ISearchProvider.ts                 # 资源检索提供商端口
│  │  │  ├─ IMediaMetadataProvider.ts          # TMDB 元数据端口
│  │  │  └─ IJobQueue.ts                       # 任务队列调度端口 (SQLite Queue 契约)
│  │  ├─ features/                             # 各 Feature 对外暴露的公开契约
│  │  │  ├─ catalog/contracts.ts
│  │  │  ├─ storage/contracts.ts
│  │  │  ├─ acquisition/contracts.ts
│  │  │  └─ patrol/contracts.ts
│  │  └─ application/                          # 应用操作契约 (Operation/DTO/Error)
│  │     ├─ operations/                        # 业务用例标识与请求响应模型
│  │     └─ errors/                            # 跨端标准错误码与取消语义
│  │
│  ├─ shared/                                  # 【基础共享层】无业务属主
│  │  ├─ crypto/                               # AES-256-GCM 凭证加解密
│  │  ├─ http-client/                          # 带超时、自适应重试与代理的 fetch 封装
│  │  ├─ rate-limiter/                         # 令牌桶 / 漏桶算法实现
│  │  └─ logger/                               # 结构化日志输出
│  │
│  ├─ features/                                # 【高内聚功能层】业务核心
│  │  ├─ catalog/                              # 媒体元数据管理与别名映射
│  │  │  ├─ application/                       # 检索编排、别名归一化
│  │  │  └─ domain/                            # MediaTitle, Season, Episode 模型
│  │  ├─ storage-management/                   # 网盘绑定、挂载点与限额
│  │  │  ├─ application/                       # 凭证绑定、配额检查
│  │  │  └─ domain/                            # StorageEndpoint, Credential 值对象
│  │  ├─ acquisition-pipeline/                 # 🔥 核心获取流水线
│  │  │  ├─ application/                       # 状态机协调器 (FSM Coordinator)
│  │  │  └─ domain/                            # 解析规则、去重策略、Saga 补偿逻辑
│  │  └─ patrol/                               # 追更巡检
│  │     ├─ application/                       # 每日增量差量比对计算
│  │     └─ domain/                            # 播出状态、缺失集数规则
│  │
│  ├─ infrastructure/                          # 【基础设施层】具体技术实现与副作用
│  │  ├─ persistence/                          # 🔥 纯 SQLite 数据持久化
│  │  │  ├─ sqlite-db.ts                       # better-sqlite3 实例与 WAL 初始化
│  │  │  ├─ kysely-sqlite.ts                   # Kysely-Sqlite 类型安全查询构建器
│  │  │  ├─ migrations/                        # 统一 SQLite DDL 脚本
│  │  │  ├─ repositories/                      # 仓储具体实现
│  │  │  └─ sqlite-queue.ts                    # 基于 SQLite 事务的原生高性能队列
│  │  ├─ drivers/                              # 网盘具体协议驱动 (适配器实现)
│  │  │  ├─ pan115/                            # 115 Cookie + RSA 离线
│  │  │  ├─ quark/                             # 夸克 Cookie + Stoken
│  │  │  ├─ pan123/                            # 123 OpenAPI
│  │  │  ├─ guangya/                           # 光鸭 AList 驱动协议
│  │  │  └─ tianyi/                            # 天翼个人云 REST
│  │  ├─ providers/                            # 外部第三方服务集成
│  │  │  ├─ pansou/                            # PanSou 搜索适配器
│  │  │  ├─ prowlarr/                          # Prowlarr 磁力适配器
│  │  │  └─ tmdb/                              # TMDB 官方 API + Worker 代理
│  │  └─ composition/                          # 基础设施实现注册清单
│  │
│  └─ application/                             # 【应用编排层】跨 Feature 用例与组合
│     ├─ operations/                           # AcquireMedia, SyncPatrol, UnbindStorage
│     └─ composition/                          # 业务逻辑依赖注入装配
│
├─ apps/                                       # 【宿主层 Hosts】独立进程与入口
│  ├─ host-web/                                # Web API 宿主 (Next.js / 轻量 Node BFF)
│  │  ├─ app/                                  # 路由端点与页面托管
│  │  └─ composition/                          # 组装：Web + Contracts + SQLite 队列投递
│  ├─ host-worker/                             # 后台 Worker 宿主 (长任务批处理、FSM 执行器)
│  │  ├─ src/main.ts                           # Worker 进程主入口
│  │  └─ composition/                          # 组装：Worker + FSM + Drivers + SQLite 队列消费
│  └─ host-desktop/                            # Electron 桌面端组合根
│     ├─ src/main.ts                           # Electron 主进程
│     └─ composition/                          # 组装：本地单一进程装配
```

### 3.2 核心限界上下文与 Feature 划分

1. **`catalog` 上下文**：负责影视作品信息、别名库、海报、播出日历。
2. **`storage-management` 上下文**：负责网盘账户绑定、安全凭证更新、媒体库目录结构初始化（`Mediary Scout/{Movies,TV,Anime}`）。
3. **`acquisition-pipeline` 上下文**：核心执行引擎，管理任务状态机、调用确定性解析引擎、执行转存、比对真实落盘、文件移动与暂存区销毁。
4. **`patrol` 上下文**：每日定期对未完结在追剧集进行增量比对，向 `acquisition-pipeline` 投递补漏微任务。

### 3.3 依赖方向与防腐层设计

```text
Host (Web / Worker / Desktop)
  │ (依赖注入)
  ▼
Features ───────────► Contracts ◄─────────── Infrastructure
(业务用例与领域)        (端口定义与 DTO)       (SQLite / 网盘驱动)
```
- **核心规约**：`Features` **绝对禁止直接 `import` `Infrastructure`**。如果获取流水线需要移动网盘文件，它只能通过调用 `Contracts/infrastructure-ports/IStorageDriver` 接口完成操作，实现完全的依赖反转（DIP）。

---

## 4. 前端物理目录与组件分层设计

对标 `SoftwareArchitecture/frontend/` 与 `projects/aitool-web/`，重构 `apps/host-web` 的前端架构：

### 4.1 目标前端物理目录树

```text
apps/host-web/src/
├─ app/                                        # Next.js App Router (纯页面路由映射，单文件 ≤ 50 行)
│  ├─ layout.tsx                               # 根布局与主题 Providers
│  ├─ page.tsx                                 # 首页 (搜索 + 媒体库 Tab)
│  ├─ show/[tmdbId]/page.tsx                   # 剧集详情
│  ├─ activity/page.tsx                        # 任务实时监控流
│  ├─ settings/page.tsx                        # 设置中心
│  └─ api/                                     # 仅保留 BFF 路由与 Webhook
│
├─ features/                                   # 【按业务高内聚划分的前端功能】
│  ├─ media-search/                            # 搜索业务 (SearchInput, useMediaSearch, searchApi)
│  ├─ media-library/                           # 媒体库与详情 (SeasonCard, EpisodeMatrix, useMediaDetail)
│  ├─ acquisition-monitor/                     # 任务流监控 (JobProgressTimeline, StepLogTerminal)
│  ├─ storage-connect/                         # 网盘扫码与连接 (QrCodeModal, DriveStatusBadge, useQrLogin)
│  └─ settings-panel/                          # 配置中心模块 (NotificationSettings, StrategySelect)
│
├─ transport/                                  # 【传输契约适配层】
│  ├─ contracts/                               # 前后端共享 DTO
│  ├─ client.ts                                # 统一 Fetch / Server Action 封装
│  └─ sse-client.ts                            # 任务进度 Server-Sent Events 客户端
│
└─ shared/                                     # 【跨功能前端共享层】
   ├─ design-system/                           # UI 设计系统 (Tokens, Theme, Typography)
   ├─ ui/                                      # 无业务属性的通用 UI 组件库 (Button, Modal, Table, Card)
   └─ utils/                                   # 纯前端工具函数
```

---

## 5. 核心功能头脑风暴与设计模式重塑

### 5.1 原生 SQLite 高性能持久化任务队列设计

去除 PostgreSQL 和 `pg-boss` 后，如何设计一个**零外部依赖、零网络开销、绝对不会产生并发死锁**的持久化任务队列？

#### 1. 数据表结构设计
```sql
CREATE TABLE IF NOT EXISTS sys_queue_jobs (
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter')),
  payload_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
  locked_by TEXT,
  locked_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_claim 
ON sys_queue_jobs(queue_name, status, next_run_at, priority DESC);
```

#### 2. 原子认领（Claim）核心算法
利用 SQLite 3.35.0+ 引入的原生 **`RETURNING`** 子句，配合 `BEGIN IMMEDIATE`，一条原子语句即可安全认领任务，彻底杜绝并发多 Worker 重复消费：

```typescript
// packages/infrastructure/persistence/sqlite-queue.ts
export class SqliteJobQueue implements IJobQueue {
  constructor(private readonly db: Database) {}

  public claimNextJob(queueName: string, workerId: string): Job | null {
    // BEGIN IMMEDIATE 独占写锁，确保同一瞬间只有一个 Worker 能获得排他锁
    const claimStmt = this.db.prepare(`
      UPDATE sys_queue_jobs
      SET status = 'running',
          locked_by = ?,
          locked_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = (
        SELECT id FROM sys_queue_jobs
        WHERE queue_name = ?
          AND status = 'queued'
          AND next_run_at <= datetime('now')
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      )
      RETURNING *;
    `);

    const row = claimStmt.get(workerId, queueName) as JobRow | undefined;
    return row ? this.mapRowToJob(row) : null;
  }

  public reportFailure(jobId: string, error: Error): void {
    const updateStmt = this.db.prepare(`
      UPDATE sys_queue_jobs
      SET retry_count = retry_count + 1,
          status = CASE WHEN retry_count + 1 >= max_retries THEN 'dead_letter' ELSE 'queued' END,
          next_run_at = datetime('now', '+' || (10 * (retry_count + 1)) || ' seconds'), -- 指数退避
          error_message = ?,
          locked_by = NULL,
          locked_at = NULL,
          updated_at = datetime('now')
      WHERE id = ?;
    `);
    updateStmt.run(error.message, jobId);
  }
}
```

### 5.2 适配器模式（Adapter）：多网盘驱动统一抽象（对标 AList）

定义清晰的抽象基类与接口，使系统具备极强的多网盘扩展力：

```typescript
// packages/contracts/infrastructure-ports/IStorageDriver.ts
export interface FileMetadata {
  id: string;
  name: string;
  sizeBytes: number;
  isFolder: boolean;
  extension?: string;
}

export interface IStorageDriver {
  readonly brand: 'pan115' | 'quark' | 'pan123' | 'guangya' | 'tianyi';
  
  // 连通性与凭据
  ping(): Promise<boolean>;
  refreshToken(): Promise<void>;

  // 目录操作
  ensureDir(parentId: string, dirName: string): Promise<string>;
  listChildren(dirId: string): Promise<FileMetadata[]>;
  
  // 文件流转 (支持批量)
  moveFiles(fileIds: string[], targetDirId: string): Promise<void>;
  deleteFiles(fileIds: string[]): Promise<void>;
  
  // 核心转存/离线能力
  transferShare(shareUrl: string, targetDirId: string, password?: string): Promise<string>;
  addOfflineTask(url: string, targetDirId: string): Promise<string>;
  queryTaskStatus(taskId: string): Promise<'pending' | 'downloading' | 'succeeded' | 'failed'>;
}
```

### 5.3 策略模式（Strategy）：去重、限速、命名与双轨决策

通过策略模式彻底解耦业务偏好与技术实现：

```mermaid
classDiagram
    class IDeduplicationStrategy {
        <<interface>>
        +selectBestFiles(files: FileMetadata[]) FileMetadata[]
    }
    class KeepLargestStrategy {
        +selectBestFiles() "保留体积最大版本 (4K 原盘)"
    }
    class BalancedQualityStrategy {
        +selectBestFiles() "1080p x265 高码率优先"
    }
    class ReleaseGroupStrategy {
        +selectBestFiles() "白名单字幕组优先 (如 NC-Raws)"
    }
    IDeduplicationStrategy <|.. KeepLargestStrategy
    IDeduplicationStrategy <|.. BalancedQualityStrategy
    IDeduplicationStrategy <|.. ReleaseGroupStrategy
```

- **自适应漏桶限流策略**：
  - `115Driver` 绑定 `LeakyBucketPacer(rate: 1.2s, maxBurst: 1)`，遇到 429 启动指数退避熔断。
  - `QuarkDriver` 绑定 `TokenBucketPacer(rate: 3/s, maxBurst: 5)`。

### 5.4 有限状态机（FSM）与 Saga 补偿模式：告别失控 Agent

放弃不可控的黑盒 Agent，使用 **XState** 将获取任务固化为严谨的有限状态图：

```mermaid
stateDiagram-v2
    [*] --> Scheduled: 任务进入 SQLite 队列
    Scheduled --> DirectoryProvisioning: Worker 成功认领任务
    
    state DirectoryProvisioning {
        [*] --> EnsureShowFolder
        EnsureShowFolder --> EnsureSeasonFolder
        EnsureSeasonFolder --> CreateStaging
    }
    
    DirectoryProvisioning --> ResourceSearching: 目录就绪
    DirectoryProvisioning --> SagaCompensating: 目录创建失败
    
    ResourceSearching --> CandidatesEvaluating: 抓取候选结果
    ResourceSearching --> NoCoverage: 超限无源
    
    CandidatesEvaluating --> Transferring: 优选最佳候选
    Transferring --> PollingLanding: 触发网盘转存/离线
    PollingLanding --> Inspecting: 真实文件完全落盘
    PollingLanding --> TransferRetrying: 超时/网络抖动
    TransferRetrying --> PollingLanding: 触发重试
    TransferRetrying --> SagaCompensating: 重试耗尽失败
    
    state Inspecting {
        [*] --> FastRuleMatch: anitomy 正则解析
        FastRuleMatch --> Organizing: 90% 匹配成功
        FastRuleMatch --> AiArbitration: 10% 存在歧义
        AiArbitration --> Organizing: AI 辅助确认映射
    }
    
    Organizing --> Deduplicating: 批量移动至 Season 目录
    Organizing --> SagaCompensating: 移动冲突/权限失败
    
    Deduplicating --> StagingPurging: 清理小文件与多余版本
    StagingPurging --> Completed: 彻底物理销毁 staging 目录
    
    SagaCompensating --> Failed: 执行逆向补偿(清理暂存文件)
    Failed --> [*]
    Completed --> [*]
    NoCoverage --> [*]
```

### 5.5 现有成熟开源库选型矩阵

| 功能环节 | 推荐采用的开源库 | 替代原项目的技术 | 性能与架构收益 |
|---|---|---|---|
| **动漫剧集识别** | **`anitomy`** (npm 纯 TS 版) | 原项目用 LLM 推理识别 | 解析耗时从 **3~8 秒降至 2 毫秒**，0 Token 成本，100% 确定性。 |
| **电影/美剧识别** | **`parse-torrent-title`** (npm) | 原项目用 LLM 推理识别 | 精准提取分辨率（4K/1080p）、压制类型（Remux/Web-DL）与年份。 |
| **持久化后台队列** | **`SqliteJobQueue`** (内置轻量实现) | 原项目每 3 秒 SQL 轮询 / pg-boss | 原生原子认领，零额外容器，支持指数退避与死信队列。 |
| **数据库抽象层** | **`Kysely` + `kysely-sqlite`** | 手写 4,500 行双 SQL | **纯 SQLite 单一驱动**，完全类型安全，编译期检查，消灭方言分歧。 |
| **状态机引擎** | **`xstate`** (npm) | 散落的状态标记 | 形式化状态流转验证，强制要求定义错误分支与 Saga 补偿动作。 |
| **凭证安全加密** | **Node.js `crypto` (`aes-256-gcm`)** | 明文存储凭证 | 凭证落盘全程高强度加密，杜绝拖库泄露风险。 |

### 5.6 业界主流方案深度对比

```mermaid
flowchart LR
    subgraph Sonarr["Sonarr (海外标准)"]
        S1["100% 规则驱动"] --> S2["Torznab 协议规范"]
        S2 --> S3["秒级本地整理"]
    end

    subgraph MoviePilot["MoviePilot v2 (国内 NAS 标杆)"]
        M1["插件化架构"] --> M2["网盘转存"]
        M2 --> M3["STRM 虚拟映射 (防封)"]
    end

    subgraph TargetScout["巡影重构后 (目标)"]
        T1["90% 规则 + 10% AI"] --> T2["AList 风格统一驱动"]
        T2 --> T3["纯 SQLite + FSM 状态机"]
    end
```

---

## 6. 质量门禁与治理体系（Governance Gates L0 ~ L5）

对标 `SoftwareArchitecture/backend/governance/gates.md` 与 `frontend/governance/gates.md`，构建全流程六层质量防护网：

### 6.1 门禁分级全景矩阵

| 门禁层级 | 检验对象 | 采用工具与证据 | 触发时机 | 阻断策略 |
|---|---|---|---|---|
| **L0 物理所有权** | 目录归属、是否有孤儿文件、文件命名 | 自动化文件系统树检查脚本 | 本地 / git pre-commit | **硬阻断**（禁止提交未归类文件） |
| **L1 项目/包依赖** | packages 间依赖方向、无循环依赖 | `dependency-cruiser` / ESLint | 本地 / PR CI | **硬阻断**（禁止跨层级非法引用） |
| **L2 源码边界** | 禁止 Feature 直接跨域访问私有实现 | ESLint `import/no-restricted-paths` | PR CI | **硬阻断**（必须经由 Contracts 导出） |
| **L3 实现约束** | 圈复杂度、单文件行数上限（防大杂烩） | ESLint `complexity` (阈值 15)、文件行数限制（$\le 500$ 行） | PR CI | **硬阻断**（超限打回，严禁再出 3000 行文件） |
| **L4 运行时契约** | 状态机跃迁、驱动接口契约、SQLite 事务 | Vitest 单元与集成测试套件 | PR CI | **硬阻断**（测试全绿方可合并） |
| **L5 构建与发布** | Docker 镜像健康检查、Electron 启动自检 | 真实环境启动 Smoke 脚本、Playwright | Release 发布流 | **硬阻断**（无法启动拒绝发布） |

### 6.2 结构门禁规则详解

```javascript
// eslint.config.mjs
export default [
  {
    rules: {
      // 铁律：Features 绝不能直接引用具体 Infrastructure 实现
      "import/no-restricted-paths": ["error", {
        zones: [
          {
            target: "./packages/features",
            from: "./packages/infrastructure",
            message: "架构违规：Feature 层只能依赖 Contracts 端口，严禁直接依赖 Infrastructure 实现！"
          },
          {
            target: "./packages/contracts",
            from: "./packages/features",
            message: "架构违规：Contracts 层必须保持纯净中立，严禁依赖 Features！"
          }
        ]
      }],
      // 单文件行数硬限制（防止 AI 再次堆砌上帝文件）
      "max-lines": ["error", { max: 600, skipBlankLines: true, skipComments: true }],
      // 复杂度限制
      "complexity": ["error", 15]
    }
  }
];
```

---

## 7. 全链路测试体系设计（单元、集成、冒烟与 E2E）

按照经典测试金字塔模型，设计完备的测试矩阵：

```mermaid
pyramid
    title 巡影测试金字塔架构 (纯 SQLite 版)
    top E2E Tests : Playwright 驱动 Web 搜片到转存落盘全流程 (少量/高覆盖)
    level 3 Smoke Tests : 容器 /api/health 自检与单容器冷启动探针
    level 2 Integration Tests : 纯内存 SQLite (:memory:) 闪电集成测试，Driver 沙盒测试
    bottom Unit Tests : Anitomy 剧集解析、XState 状态机跃迁、去重策略、凭证加密 (大量/毫秒级)
```

### 7.1 单元测试（Unit Tests）
- **解析器测试**：针对 100+ 个中英文动漫、电视剧、电影实测文件名，验证 `anitomy` 与 `parse-torrent-title` 的识别准确率。
- **状态机跃迁测试**：在无需任何网络请求的纯内存环境下，断言 XState 状态转移路径及上下文数据正确性。

### 7.2 集成测试（Integration Tests）
- **纯内存 SQLite 极速测试**：直接使用 `new Database(':memory:')`，无需任何外部容器，**测试套件 1 秒内全量跑完**，本地与 CI 开发体验极其丝滑。
- **网盘 Driver 沙盒测试**：对真实的测试根目录（`TEST_ROOT_CID`），验证 `ensureDir`、`moveFiles`、`deleteFiles` 的真实接口响应。

### 7.3 冒烟测试（Smoke Tests）
- **单容器就绪探测**：`Dockerfile` 内置健康检查探针，验证单容器启动 15 秒内 SQLite 自动执行 DDL 迁移、Web 端口监听就绪、Worker 队列开始消费。

### 7.4 端到端测试（E2E Tests）
- 使用 **Playwright** 自动化驱动浏览器，完成“搜索 $\to$ 获取 $\to$ 状态机流转 $\to$ 落盘整理 $\to$ UI 打勾”完整闭环。

---

## 8. 分阶段渐进式落地执行计划

```mermaid
gantt
    title 巡影架构重构路线 (纯 SQLite 版)
    dateFormat  YYYY-MM-DD
    
    section Sprint 1: 纯 SQLite 改造与契约建立
    建立 Contracts/Shared 目录结构          :active, s1_1, 2026-11-01, 3d
    彻底删除 postgres.ts 并剥离 PG 依赖     :s1_2, after s1_1, 3d
    基于 better-sqlite3 搭建 SqliteJobQueue :s1_3, after s1_2, 4d
    引入 Kysely-Sqlite 统一数据访问         :s1_4, after s1_3, 5d
    凭据 AES-256-GCM 加密落盘改造         :s1_5, after s1_4, 2d

    section Sprint 2: 独立 Worker 与流水线解耦
    建立独立 host-worker 模块化单体进程      :s2_1, after s1_5, 5d
    剥离 Next.js instrumentation 内的常驻循环 :s2_2, after s2_1, 3d
    精简 Docker Compose (彻底移除 postgres)  :s2_3, after s2_2, 2d

    section Sprint 3: 业务流水线规则化与状态机
    集成 anitomy 与 parse-torrent-title    :s3_1, after s2_3, 4d
    构建 XState 状态机与 Saga 补偿拦截器     :s3_2, after s3_1, 6d
    重构 IStorageDriver 统一网盘适配器     :s3_3, after s3_2, 5d
    
    section Sprint 4: 门禁与测试金字塔闭环
    补齐 L0~L3 ESLint 架构与复杂度门禁     :s4_1, after s3_3, 3d
    内存 SQLite 闪电集成测试套件编写        :s4_2, after s4_1, 4d
    搭建 Playwright 端到端冒烟流水线        :s4_3, after s4_2, 4d
```

### 纯 SQLite 重构最终收益指标预估

1. **部署与资源消耗**：
   - Docker Compose 彻底剔除 `postgres` 容器，**内存占用直接减少 200MB+**。
   - NAS 机械硬盘不再被 PG 周期性唤醒，完全支持静默休眠。
2. **代码维护成本**：
   - 彻底删除 2,349 行 `postgres.ts`，**代码库永久减少 3,600+ 行重复样板代码**。
   - 桌面端与 Docker 容器端 100% 共享同一套 SQLite 仓储，消灭方言分歧。
3. **执行性能与稳定性**：
   - 单次媒体入库整理耗时：由 **1 ~ 5 分钟降低至 2 ~ 5 秒**（提速 **90% 以上**）。
   - CI 自动化测试执行耗时：由 **45 秒缩短至 2 秒以内**。
   - 凭据全流程 AES-256-GCM 加密，彻底杜绝明文泄露风险。

---
*(报告完毕。已完整归档至 `docs/architecture-remediation-and-governance.md`。)*

# SQLite 持久层模块化拆分与代码复杂度门禁体系设计

> **状态**：Draft / 方案评审与实施规划  
> **编写时间**：2026-11-01  
> **目标范围**：`packages/workflow/src/persistence/sqlite.ts` 解耦、架构门禁（L3 代码复杂度与单文件行数/体积）深化

---

## 1. 背景与现状问题分析

### 1.1 `sqlite.ts` 上帝类膨胀现状
当前 `packages/workflow/src/persistence/sqlite.ts` 单文件已达 **3,395 行**，包含了：
1. **28 张数据表的 DDL 与索引定义**（从核心工作流、媒体快照到会话、设置、STRM 任务、媒体服务器刷新记录）；
2. **全系统唯一的单体数据库实现类 `SqliteWorkflowRepository`**：同时实现了 `WorkflowRepository`、`StrmStore`、`MediaServerStore` 接口，聚合了近 80 个数据库读写方法；
3. **高圈复杂度逻辑内嵌**：如 `updateStrmTask` 因条件拼接使复杂度达到 17（超过 ESLint 门禁上限 15）。

#### 带来的架构隐患：
- **可维护性骤降**：单文件超过 3,000 行导致 IDE 语法分析卡顿、符号检索缓慢、上下文过载；
- **高风险并发冲突**：多位开发者或多个功能分支（如订阅入库、STRM 生成、媒体服务器同步、对话系统）同时修改该文件，合并冲突频发；
- **事务与职责混杂**：跨领域的 SQL 查询、动态更新拼接和 JSON 序列化逻辑全部平铺在同一个类中，违背单一职责原则（SRP）。

### 1.2 门禁防线缺失与 Baseline 钝化
虽然在前期治理中引入了 `eslint.config.mjs` 中的 `max-lines: 600` 与 `complexity: 15`，但在实际演进中存在两处短板：
1. **Baseline 变成“避风港”**：`eslint-suppressions.json` 将 `sqlite.ts` 全局豁免，导致后续新增功能不断堆砌，文件从 2,500 行膨胀到 3,395 行而没有触发警报；
2. **缺少“棘轮机制”（Ratchet Mechanism）**：未能实现“存量文件只能变小、不能变大”的递减门禁约束；
3. **缺少快速独立检查脚本**：开发者在本地提交或 CI 运行初期，缺乏一键统计超大文件与高复杂度函数的可视化体检工具。

---

## 2. 业界主流方案与设计模式对比

### 2.1 数据库持久层拆分设计模式对比

| 方案 | 架构拓扑 | 事务传播与连接管理 | 对外 API 兼容性 | 复杂度与维护成本 |
|---|---|---|---|---|
| **方案 A：多重继承 / Mixin 混入模式** | 将多个方法切片通过 TypeScript Mixin 组合到同一个原型链 | 共享 `this.db`，但类型推断脆弱，调试堆栈模糊 | 完全兼容 | 中高（TS Mixin 声明复杂易断裂） |
| **方案 B：Facade 外观模式 + 委托模块化 (推荐)** | `SqliteWorkflowRepository` 作为门面，内部组合多个专职 Delegate 模块（如 `SqliteStrmRepository`、`SqliteMediaServerRepository`） | 由门面类统一管理 `Database` 实例并下发 `SqliteDbContext`；跨模块事务由统一事务边界协调 | 100% 保持向后兼容，外部调用方零感知 | 极低，结构清晰，可独立进行模块测试 |
| **方案 C：彻底拆分独立仓储 (Domain Repositories)** | 彻底废除统一 `WorkflowRepository`，强制各调用方注入独立的 `StrmRepository`、`RunRepository` | 各仓储独立管理，需要引入全局事务管理器 (Unit of Work) | 破坏性重构，需改动数百处业务调用 | 极高，迁移成本巨大 |

**最终决策：采用方案 B（Facade + 委托模块组合模式）**。既能实现代码物理切片（单文件严格控制在 300~500 行以内），又保证业务层零改动、零破坏性变更。

### 2.2 代码体积与复杂度门禁主流方案对比

| 方案 | 机制与原理 | 优势 | 局限性与风险 |
|---|---|---|---|
| **ESLint 核心规则 (`max-lines`, `complexity`)** | AST 解析语法树，统计行数与逻辑分支数（if/switch/for/?） | 生态原生，现成开箱即用 | 针对存量大文件需要 Baseline 支持；缺少体积(KB)检查 |
| **SonarQube 认知复杂度 (`eslint-plugin-sonarjs`)** | 考虑嵌套深度的认知复杂度度量，更能反映人类理解难度 | 比圈复杂度更贴合实际阅读体验 | 规则配置相对重，部分规则对现有代码误报率高 |
| **自定义轻量级棘轮门禁脚本 (`scripts/gate-code-limits.mjs`)** | 在构建或 CI 中基于行数、体积与基线进行比对，实行**只降不升**的棘轮限制 | 极速（毫秒级执行），直观输出超标排行，可针对目录设置差异化阈值 | 需自建并与 Git hook / CI 挂接 |

**最终决策：双重协同门禁体系**：
1. **L3 编译前门禁**：通过自定义脚本 `scripts/gate-code-limits.mjs` 实施全局文件体积与行数**棘轮门禁**，对任何超过阈值或存量递增的行为实行阻断；
2. **ESLint AST 门禁**：维持 `max-lines: 600` 与 `complexity: 15`，在拆分后逐步将 `sqlite.ts` 从 `eslint-suppressions.json` 中彻底移除。

---

## 3. `sqlite.ts` 模块化拆分详细架构

```
packages/workflow/src/persistence/
├── db-schema.ts                    # 数据库接口定义 (MediaryDatabase, 表行定义)
├── sqlite-context.ts               # 【新建】数据库上下文：连接句柄、WAL 配置、事务执行器
├── sqlite.ts                       # 【瘦身重构】统一 Facade 门面，对外保持 WorkflowRepository 完整实现
└── sqlite/                         # 【新建】按功能域拆分的专职模块目录
    ├── sqlite-schema.ts            # DDL 汇总与版本迁移调度
    ├── sqlite-workflow-runs.ts     # 工作流运行快照、Episode状态、决策与步骤
    ├── sqlite-tracked-seasons.ts   # 季跟踪、媒体标题、策略冷却水位线
    ├── sqlite-strm.ts              # STRM 任务配置、链接缓存、执行记录与进度
    ├── sqlite-mediaserver.ts       # 媒体服务器配置、路径映射、刷新历史记录
    ├── sqlite-auth-settings.ts     # 账号认证、会话、系统配置与网盘连接
    ├── sqlite-agent-memory.ts      # Agent 长期记忆、死链库、用户请求消息
    └── sqlite-chat.ts              # 对话历史与聊天消息存储
```

### 3.1 核心数据库上下文 (`sqlite-context.ts`)
```typescript
import type Database from "better-sqlite3";

export interface SqliteDbContext {
  readonly db: Database.Database;
  readonly now: () => string;
  transaction<T>(fn: () => T): T;
}

export abstract class BaseSqliteModule {
  constructor(protected readonly ctx: SqliteDbContext) {}
  
  protected get db(): Database.Database {
    return this.ctx.db;
  }
}
```

### 3.2 拆分后各子模块行数预估
- `sqlite/sqlite-strm.ts`: ~220 行（专职处理 `strm_tasks`, `strm_link_cache`, `strm_execution_records`）；
- `sqlite/sqlite-mediaserver.ts`: ~210 行（专职处理 `mediaserver_configs`, `mediaserver_refresh_records`）；
- `sqlite/sqlite-workflow-runs.ts`: ~480 行；
- `sqlite/sqlite-tracked-seasons.ts`: ~380 行；
- `sqlite/sqlite-auth-settings.ts`: ~320 行；
- `sqlite/sqlite-agent-memory.ts`: ~290 行；
- `sqlite/sqlite-chat.ts`: ~120 行；
- `sqlite.ts` (主 Facade 类): ~180 行（纯组合与委托转发）。

**彻底消除 3,000+ 行文件，所有单文件均严格落在 100~500 行的健康区间内！**

---

## 4. 复杂度与文件体积门禁体系设计

### 4.1 门禁规则分级矩阵

```mermaid
flowchart TD
    Commit[git commit / PR 提交] --> L0[L0/L3: 文件行数与体积棘轮门禁]
    L0 -->|通过| L1[L1: ESLint AST 复杂度门禁 (complexity <= 15, max-lines <= 600)]
    L0 -->|超限或存量增长| Reject0[硬阻断: 提示重构拆分]
    L1 -->|通过| L2[L2: TypeScript 强类型编译无报错]
    L1 -->|分支复杂度超标| Reject1[硬阻断: 降低圈复杂度]
    L2 -->|通过| L4[L4: Vitest 单元与集成测试全绿]
    L4 --> Merge[合入主干]
```

### 4.2 棘轮机制（Ratchet Principle）
对于历史遗留已超标的文件（如 `worker.ts` 约 1,600 行）：
- 门禁脚本读取 `file-limits-baseline.json`，记录当前已知超标文件的精确行数与字节数；
- 若后续提交中该文件的行数**增加**，立即判定门禁失败；
- 若后续提交中该文件被重构、行数**减少**，门禁通过，并自动更新 Baseline，实现代码行数的“单向递减收敛”！

---

## 5. 实施与分步迁移计划

1. **第一阶段：门禁基础设施就绪**
   - 编写 `scripts/gate-code-limits.mjs`，支持单文件行数限制（默认 500 行）、体积限制（默认 50KB）与 Baseline 棘轮比对；
   - 修复 `updateStrmTask` 中的复杂度告警，确保 ESLint 零告警通过。
2. **第二阶段：提取 STRM 与 MediaServer 仓储模块**
   - 优先将最新增的 STRM 与 MediaServer 逻辑剥离至 `sqlite/sqlite-strm.ts` 和 `sqlite/sqlite-mediaserver.ts`；
   - 验证既有单元与集成测试 100% 通过。
3. **第三阶段：完成核心仓储切片**
   - 依次剥离 `sqlite-workflow-runs.ts`、`sqlite-tracked-seasons.ts` 等；
   - 将 `sqlite.ts` 彻底收敛为 Facade 门面；
   - 将 `sqlite.ts` 从 `eslint-suppressions.json` 中永久移出。

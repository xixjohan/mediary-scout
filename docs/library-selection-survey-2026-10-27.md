# 可复用开源库选型调研报告（TypeScript 单体 · Next.js 16 + Node + SQLite · 单用户自部署）

> **文档位置**：`docs/library-selection-survey-2026-10-27.md`
> **编写时间**：2026-10-27
> **用途**：为巡影（Mediary Scout）即将进行的四项重构（资源提供商抽象、显式状态机、任务编排与重试、结构化日志）提供库级选型依据。
> **数据说明**：所有 star 数、版本号、推送时间均为 2026-10-27 当天通过 GitHub API / npm registry API 实测；npm 周下载量取自 npm downloads API，**返回窗口为 2026-06-25 ~ 2026-07-01**（该 API 返回窗口明显滞后，仅作量级参考，并已注明来源）。查不到的数据一律标注「未查证」。本文是 `docs/refactoring-architecture-and-design-patterns.md` 第 4 节的库级细化补充，结论不冲突。

---

## 0. 总览：一句话结论表

| 重构方向 | 推荐 | 明确不推荐 | 一句话理由 |
|---|---|---|---|
| A 状态机 | **手写 discriminated union + transition table + ts-pattern**；轻量库备选 robot3 | XState v5、js-state-machine、@zag-js/* | 订阅/入库是线性流程，手写范式零依赖且编译期穷尽；XState 能力过剩、js-state-machine 已停更 |
| B 适配器注册 | **朴素 registry map + factory** | tsyringe、inversify | 「接口 + Record<key, impl> + 工厂函数」在本规模是净收益；DI 容器需要装饰器/反射元数据，净负担 |
| C 任务队列 | **自建轻量 SQLite 队列表**（参考 sqliteq/plainjob/goqite 设计）；croner 做定时 | BullMQ、Agenda、node-resque、Temporal/Cadence/Inngest | 无 Redis 约束下现成 SQLite 队列全部处于 0.x 或个位数 star；pg-boss+PGlite 是唯一成熟的「无外部服务」选项但要引入第二份存储 |
| D 重试与弹性 | **p-retry**（重试）+ **cockatiel**（断路器/超时/组合策略） | async-retry、opossum | p-retry/cockatiel 均 MIT、Node>=22、活跃维护；async-retry 冻结在 2021，opossum 生态位被 cockatiel 取代 |
| E 结构化日志 | **pino**（性能/生态）或 **tslog**（零依赖+漂亮输出） | winston（除非要现成 DB sink） | 单用户场景 pino/tslog 都远够用；「日志落库」没有成熟库，自写 logs 表 + FTS5 是几十行代码 |
| F 链接解析 | **parse-torrent**（含 magnet-uri） | ed2k-link 系、PT 站 API 客户端（不存在） | magnet/.torrent/infoHash 一个库全覆盖；ed2k 格式简单建议手写正则；PT 站 API 无通用客户端，按站写 adapter |

---

## A. 状态机（订阅 / 入库任务长流程建模）

### A.1 XState v5（`xstate`）

| 项 | 数据 |
|---|---|
| 版本 | `xstate@5.33.3`（npm 显示 10 天前发布） |
| Star | **30,362**（GitHub `statelyai/xstate`，2026-10-26 仍有推送，非常活跃） |
| 周下载 | **4,436,665**（npm downloads API，窗口 2026-06-25~07-01） |
| 许可证 | MIT |
| 运行时依赖 | **0**（npm 明示 0 Dependencies） |
| 体积 | npm tarball 解包 2.3MB（含多入口 `./actors` `./graph` 等与 development 构建；实际运行时经 tree-shaking 后远小于此，**gzip 后精确值未查证**） |
| API 形态 | v5：`setup({ types, actions, guards, actors })` + `createMachine` + `createActor(machine).start()/.send()`；`fromPromise`/`fromCallback`/`fromTransition` 把外部 IO 建模为 actor |

**评估**：
- **actor 模型对 Node 单体是否过重？运行时不过重，认知过重。** 运行时层面它零依赖、纯 TS、Node 下 `createActor` 同步驱动即可，没有额外进程/序列化成本——Stately 官方也把它定位为「frontend and backend application logic」。真正的成本在：(1) statechart 概念（层级/并行/历史/actor 编排）学习曲线陡；(2) 落库时 actor 引用不可直接 JSON 序列化，需要自己定义 persisted snapshot 的还原逻辑；(3) 单测要理解 actor 语义。
- 对「下载中→转存中→整理中→已完成/失败→重试」这种**线性 + 少量分支**的流程，XState 提供的能力（并行区域、actor 间通信、可视化）大部分用不上。**推荐仅当未来流程出现真正的多分支/补偿（Saga）需求再引入。**

### A.2 Robot（`robot3`）

| 项 | 数据 |
|---|---|
| 版本 | `robot3@1.4.0` |
| Star | **2,203**（`matthewp/robot`，2026-10-05 推送，活跃） |
| 周下载 | **981,370** |
| 许可证 | BSD-2-Clause |
| 运行时依赖 | 0（devDeps 仅 rollup/terser） |
| 体积 | 解包 **29KB / 8 文件**（自带 bundlesize 检查） |
| API 形态 | 函数式不可变 FSM：`createMachine({ off: state(transition('toggle','on')), ... })` + `interpret(machine, cb)`；自带 `./debug`、`./logging` 子入口；TS 类型随包提供 |

**评估**：单文件、零依赖、不可变数据、TS 友好，是「比 XState 轻一个数量级」的成熟选择（WebComponents 社区出身，Node 完全可用）。**不适合**需要层级状态图/并行状态的复杂流程。适合作为「想用库但不想上 XState」时的首选。

### A.3 @zag-js/state-machine

- **`@zag-js/state-machine` 在 npm 上不存在（API 返回 404 "package not found"）**。Zag 的机器实现位于 `@zag-js/core@1.47.0`（MIT，unpacked 69KB，依赖 `@zag-js/utils` + `@zag-js/dom-query`），自我描述为 *"A minimal implementation of xstate fsm for **UI machines**"*，仓库 `chakra-ui/zag`。
- **结论：不推荐。** 它是为 headless UI 组件（多框架适配的交互状态机）设计的，DOM 查询依赖和 API 形态都面向组件行为，不适合 Node 后端流程建模。

### A.4 js-state-machine（`javascript-state-machine`）

| 项 | 数据 |
|---|---|
| 版本 | `javascript-state-machine@3.1.0`，**npm 最后发布时间为 2018 年**（registry 时间戳实测） |
| Star | **8,749**（`jakesgordon/javascript-state-machine`，MIT；GitHub 最后推送 2025-06-01） |
| 周下载 | **193,745** |
| 类型 | 纯 JS，无 TS 类型定义 |

**结论：不推荐新项目使用。** star 高但 npm 包停在 2018、纯 JS 无类型，对新 TS 代码库是负资产。

### A.5 手写范式（exhaustive state union + transition table）+ ts-pattern

- **没有垄断性的「手写范式范例库」**——这正是社区主流做法，范式本身成熟：
  ```ts
  type IngestState =
    | { status: 'idle' } | { status: 'downloading'; progress: number }
    | { status: 'transferring' } | { status: 'organizing' }
    | { status: 'completed' } | { status: 'failed'; error: string; retries: number };

  type IngestEvent = { type: 'START' } | { type: 'PROGRESS'; p: number } | { type: 'RETRY' } | ...;

  // 编译期穷尽的转移表
  const transitions: Record<IngestState['status'], Partial<Record<IngestEvent['type'], IngestState['status']>>> = { ... };
  ```
  配合 `never` 兜底 switch 或下面的 ts-pattern 实现 exhaustiveness 检查。
- **ts-pattern**（`ts-pattern@5.9.2`，MIT，**15,202 stars**，2026-10-14 推送，周下载 **5,436,186**，unpacked 459KB，零运行时依赖）：TS 穷尽模式匹配库，`match(state).with({ status: 'downloading' }, ...).exhaustive()` 可在编译期保证所有状态都被处理。
- **结论（本项推荐）**：手写 union + transition table + ts-pattern 做穷尽检查。理由：零运行时风险、与 SQLite 行上的 `status` 字段天然映射（持久化就是存当前 state）、可测试性最好（纯函数 `reduce(state, event)`）、团队阅读成本最低。状态转移本身也应落库为事件流（`ingest_events` 表），与 C 的队列共享同一套持久化机制。

---

## B. 依赖注入 / 适配器注册（搜索提供商、网盘存储多实现）

需求本质：**接口 + 多实现 + 运行时按 key 选择**。这正是策略/适配器注册表，不需要完整 IoC 容器。

### B.1 朴素 registry map + factory（零依赖）——✅ 推荐

```ts
export interface SearchProvider { key: string; search(q: string): Promise<Result[]>; }
const registry = new Map<string, SearchProvider>();
export const register = (p: SearchProvider) => registry.set(p.key, p);
export const getSearchProvider = (key = process.env.MEDIA_TRACK_SEARCH_PROVIDER!) => {
  const p = registry.get(key);
  if (!p) throw new Error(`unknown search provider: ${key}`);
  return p;
};
```

- **优点**：零依赖、完全类型安全（key 可用 `as const` 字面量联合收紧）、与 Next.js 无任何构建配置摩擦（无需装饰器/`emitDecoratorMetadata`）、测试直接塞 fake 实现。
- **适用边界**：实现数 ≤ 10、无循环依赖、无生命周期管理需求时是净收益。本项目（单用户单体、两个 provider 维度）完全在此边界内。

### B.2 tsyringe ——❌ 不推荐

`tsyringe@4.10.0`，MIT，**6,014 stars**（microsoft 维护，2026-10-16 推送），周下载 **8,283,772**，运行时依赖仅 `tslib`，unpacked 148KB。
**需要** `reflect-metadata` + `experimentalDecorators` + `emitDecoratorMetadata`（TS 编译器配置侵入，Next.js/SWC 下需确认支持）。
**不推荐理由**：装饰器 + 反射元数据换来的是构造注入语法糖；本项目没有跨模块依赖图需要容器来编排，属于过度设计。注意其周下载量高主要来自企业/Nest 生态外溢，不代表适合此场景。

### B.3 inversify ——❌ 不推荐

`inversify@8.2.3`，MIT，**12,061 stars**（老 repo `inversify/InversifyJS` 已标注迁移至 `inversify/monorepo`，老 repo 最后推送 2025-11-19），npm 页面周下载 **919,231**（来源：npm 页面搜索快照），依赖 `@inversifyjs/core` 等分包 + reflect-metadata。
**不推荐理由**：API 最重（`container.bind<Foo>(TYPES.Foo).to(FooImpl)`），同样依赖反射元数据；对单体的复杂度是净增加。

### B.4 typed-inject ——△ 可选（无特殊理由不用）

`typed-inject@5.0.0`，**Apache-2.0**，**631 stars**（`nicojs/typed-inject`，2026-01-01 推送，npm 最后发布 2024-12），周下载 **1,109,726**，**零运行时依赖**，**无需装饰器/反射元数据**，靠类型 token 推断实现类型安全注入。
**评价**：技术上是三者中对 TS 最干净的，但社区小、发布频率低。若团队就是想要「容器 + 类型安全」且不愿开 reflect-metadata，它是唯一候选；否则 B.1 足够。

### B.5 awilix ——△ 次选

`awilix`（npm 具体版本未单独查证），MIT，**4,246 stars**（`jeffijoe/awilix`，2026-10-12 推送），周下载 **504,576**。特色：对象字面量注册（`asFunction`/`asClass`/`asValue`）+ 可选 proxy 模式，不必用装饰器，比 tsyringe/inversify 轻。
**评价**：如果坚持要容器，awilix 是本场景最轻的成熟选项；但依然解决的是本项目不存在的问题。

---

## C. 任务队列 / 工作流编排（长耗时外部 IO：网盘 API、LLM 调用）

**硬约束**：单机自部署、无 Redis、SQLite 为主存储、单用户（并发量极小、量级 ~每天几十~几百任务）。

### C.1 BullMQ ——❌ 不推荐（缺 Redis）

`bullmq@6.5.0`，MIT，**9,548 stars**（`taskforcesh/bullmq`，2026-10-27 当天仍有推送），周下载 **6,325,389**，unpacked 3.4MB。
- 主后端是 Redis（`peerDependencies`: redis / ioredis 必选其一）。
- **v6 起新增 PostgreSQL 后端**（docs.bullmq.io 有 "PostgreSQL backend" 专页；registry `peerDependencies` 含可选 `pg`）——但仍然需要一个 PostgreSQL 服务器，对「只有 SQLite」的自部署用户是新增组件。
- 功能确实最强（延迟/优先级/去重/流/速率限制/可观测），但**与无 Redis 约束冲突**。

### C.2 pg-boss ——△ 条件推荐（接受 PGlite 双存储时）

`pg-boss@12.38.0`，MIT，**4,097 stars**（`timgit/pg-boss`，2026-10-27 仍有推送），周下载 **780,098**，要求 Node ≥ 22.12，依赖 `pg`、`cron-parser`、`rrule-temporal`、`serialize-error`。
- 基于 Postgres `SKIP LOCKED`；重试指数退避、死信队列 redrive、cron/RRULE 调度、LISTEN/NOTIFY 低延迟、可在一个 SQL 事务里创建任务、Drizzle/Knex/Kysely/Prisma 适配器、OpenTelemetry、**官方 `@pg-boss/dashboard` Web 面板**。
- **README 明确支持嵌入式 PGlite（进程内 WASM Postgres，"running entirely in-process"，无需任何数据库服务器）**；同时支持 CockroachDB/Citus 等 PG 兼容库。
- **结论**：如果愿意接受「主业务 SQLite + 队列用 PGlite（另一份存储、另一套备份）」的双存储模型，pg-boss + PGlite 是**单机无外部服务场景下最成熟的队列**，且自带监控面板（正好服务重构方向 4 的可观测性）。若坚持单一 SQLite 文件，则不选。

### C.3 Agenda ——❌ 不推荐（无 SQLite 后端）

`agenda@6.2.6`，MIT（README 确认），**9,713 stars**（`agenda/agenda`，2026-07-21 推送），周下载 **162,249**，依赖 debug/luxon/date.js/cron-parser/human-interval。
- v6 为 TypeScript 完全重写、ESM-only、**可插拔后端**：MongoDB 默认，另有 PostgreSQL、Redis 通知通道（或自定义 `AgendaBackend`）；支持优先级/并发/延迟/cron/人性化间隔、fork 沙箱执行、`touch(progress)`、持久化任务日志、`agendash` 面板、`agenda-rest`。
- **结论：不推荐**——后端枚举里没有 SQLite，为它引入 Mongo/PG/Redis 都不符合约束。（理论可自写 SQLite backend，但那是自建队列 + Agenda 复杂度，双输。）

### C.4 node-resque ——❌ 不推荐

`node-resque@9.7.1`，Apache-2.0，**1,414 stars**（`actionhero/node-resque`，2026-10-21 推送），周下载 **19,363**，依赖 `ioredis`。Redis 后端直接出局；功能（优先级/延迟/锁）也无相对优势。

### C.5 纯 SQLite 队列库现状（重点调研）

| 库 | 版本/star/维护 | 依赖 | 能力 | 周下载 | 结论 |
|---|---|---|---|---|---|
| **liteque**（`karakeep-app/liteque`，Hoarding/Karakeep 团队） | `0.10.0`；**80 stars**；2026-10-10 推送 | `zod`、`async-mutex`、`drizzle-orm`；peer `better-sqlite3` | zod schema 校验、并发控制、轮询、超时、重试、失败保留策略、TS 类型安全 | **1,840** | **契合度最高的现成实现**；风险：0.x 版本号 + 拖入 drizzle-orm（重） |
| **plainjob**（`justplainstuff/plainjob`） | `0.0.14`；**99 stars**；2026-10-26 推送 | 仅 `cron-parser` | better-sqlite3/bun:sqlite 双驱动、原子 claim、cron、延迟、超时重排队、自动清理、标称 15k jobs/s | **255** | **最轻**；风险：0.0.x，个人项目 |
| **@minnzen/sqliteq**（`Minnzen/sqliteq`） | `0.2.0`；**6 stars**；2026-04 后停更 | **零依赖** | 原子 claim、visibility timeout、fencing token、优先级、延迟、死信（设计对标 Go 的 goqite） | **5** | 设计最好但太新、几乎无采用 |
| **@walq/core**（`unsady/walq`） | `1.2.2`；**2 stars**；2026-10-05 推送 | `cron-parser` | lease 租约、崩溃重取、自动续租、重试退避、有界清理 | **0** | 太新，仅参考 |
| node-persistent-queue | `1.0.5`；**约 3 年未发布** | — | 简单 SQLite 队列 | 未查证 | ❌ 停更，不用 |

**结论（本项主推荐）**：**自建轻量 SQLite 队列表**。理由：
1. 所有现成库都处于 0.x 或个位数 star，单用户自部署项目引入它们的供应链风险 > 收益；
2. 核心需求（持久化、并发上限、重试、退避、可观测）用一张表 + 一个 worker 循环即可覆盖：`jobs(id, type, payload_json, status, attempts, run_at, lease_until, last_error, created_at, updated_at)`，`BEGIN IMMEDIATE` 事务内原子 claim（`UPDATE ... WHERE id IN (SELECT ... WHERE status='pending' AND run_at<=now LIMIT n) RETURNING`）+ lease 超时重取 + 指数退避 `run_at`。WAL 模式下单写者足够；
3. 设计蓝本直接借鉴 sqliteq / plainjob / goqite 的公开设计（claim + visibility timeout + fencing），无需从零发明；
4. 与 A 的手写 FSM 共享同一张 SQLite 库：任务状态就是 FSM 的持久化投影，队列负责调度、FSM 负责合法性。
配套 **croner**（`Hexagon/croner`，MIT，**2,609 stars**，2026-10-26 推送，周下载 **7,328,098**，零依赖）做进程内定时触发（订阅刷新、失败重扫），不要为此引入 node-schedule（已不活跃，未查证具体数据）。

### C.6 Temporal / Cadence / Inngest ——❌ 均不适合单机自部署

- **Temporal**（MIT）：自托管需要 PostgreSQL 13+/MySQL/Cassandra 之一做持久化，外加 Elasticsearch/OpenSearch 做 visibility（SQLite 明确「仅限开发测试」）；部署形态是 docker-compose 多服务 / Helm / systemd 多进程，`server start-dev` 官方声明不适合生产。对单用户 NAS/桌面部署是数量级过重。
- **Cadence**：与 Temporal 同宗（Uber 出品），服务端集群模型，更重。不推荐。
- **Inngest**：自托管提供单节点模式（`inngest start`，默认 SQLite 持久化 + 内置内存 Redis 快照），表面最轻；但它本质是一个**独立常驻服务进程 + 自有 UI + 事件驱动执行模型**，应用需注册 serve endpoint，其核心价值（跨服务持久执行、fan-out）在单体中用不到。为它改架构得不偿失。不推荐。
- **共性原因**：三者解决的是「多服务、长周期（天/周）、可恢复的工作流」；本项目是「单进程、分钟级、失败重试」的批处理，队列 + FSM 已覆盖。

---

## D. 重试与弹性（网盘 API、LLM 调用）

### D.1 p-retry ——✅ 推荐（单次调用重试）

`p-retry@8.0.1`，MIT，**1,037 stars**（`sindresorhus/p-retry`，2026-09-18 推送），周下载 **38,236,350**，ESM-only，Node ≥ 22，运行时依赖仅 `is-network-error`，解包 26KB。
- API：`pRetry(fn, { retries, factor, minTimeout, maxTimeout, onFailedAttempt, shouldRetry })`；支持按错误类型决定是否重试。
- **适合**：把一次外部调用（网盘 API、LLM）包上重试与指数退避；与队列层职责分离（队列管任务级重试，p-retry 管调用级重试，**注意避免双重重试叠加**，建议调用级重试次数 ≤2、任务级退避更长）。

### D.2 cockatiel ——✅ 推荐（断路器 / 组合策略）

`cockatiel@4.0.0`，MIT，**1,830 stars**（`connor4312/cockatiel`，2026-10-26 推送），周下载 **1,628,342**，Node ≥ 22，解包 262KB。
- API（.NET Polly 风格）：`retry(handleAll, { maxAttempts, backoff })`、`circuitBreaker(handleAll, { halfOpenAfter, breaker })`、`timeout`、`bulkhead`、`fallback`、`wrap(policyA, policyB)` 组合执行。
- **适合**：给「打某网盘/某 LLM 供应商」加断路器（连续失败 N 次熔断 10s，防止风暴式重试打爆对方或被风控）；超时与舱壁隔离。
- **不适合**：只想要最简单的 `retry(fn, 3)` 时（那是 p-retry 的活）。

### D.3 async-retry ——❌ 不推荐

`async-retry@1.3.3`，MIT，**1,918 stars**，周下载 **25,592,363**；npm 最后发布 2021-08，GitHub 最后推送 2023-07-19，此后基本冻结。API（`retry(fn, { retries, bail })`）稳定可用，但新项目没有选它的理由。

### D.4 opossum ——❌ 不推荐

`opossum`（nodeshift），Apache-2.0，**1,691 stars**，2026-08-21 仍有推送。经典断路器（Hystrix 风格、事件驱动、Prometheus 集成），但纯 JS + `@types/opossum`、API 偏老；**生态位已被 cockatiel（TS 原生、可组合）取代**。

---

## E. 结构化日志 + 日志查询面板

### E.1 pino ——✅ 推荐（性能/生态向）

`pino@10.4.0`，MIT，**18,268 stars**（`pinojs/pino`，2026-10-06 推送），周下载 **36,590,396**，CommonJS，unpacked 705KB，运行时依赖 10 个（sonic-boom、thread-stream、pino-std-serializers 等）。
- 极快 JSON 日志（异步 worker transport）、`pino.child({ scope })` 绑定上下文学、redaction 脱敏、`pino-pretty` 开发美化。
- **适合**：Node 服务端主力日志器；「落库」可经 worker transport 或自写 sink 完成（见 E.4）。

### E.2 winston ——△ 次选

`winston@3.19.0`，MIT，**24,527 stars**（`winstonjs/winston`，2026-07-20 推送），周下载 **24,154,168**，依赖 10 个（logform、triple-beam、winston-transport 等），unpacked 274KB。
- 传输器生态最全（文件/Console/HTTP/各类云/DB），levels 自定义灵活。
- **不适合本项默认场景**：比 pino 慢且重；其「DB sink 多」的优势在 SQLite 场景并不成立（没有现成 SQLite transport，见 E.4）。仅当明确要 winston 生态某个 sink 时选。

### E.3 tslog ——✅ 推荐（零依赖/开发体验向）

`tslog@5.4.0`，MIT，**1,751 stars**（`fullstack-build/tslog`，2026-10-27 当天仍有推送），周下载 **2,317,497**，**零运行时依赖**，unpacked 994KB，Node ≥ 22。
- TS 原生（类型化 meta）、pretty 终端输出 + JSON 输出双模、子路径导出 `./lite`、`./slim`、`./otel`、`./presets/pino`（可输出 pino 格式 JSON）、`./transports/file|http|ringbuffer`。
- **适合**：想要漂亮可读开发日志 + 结构化 JSON 落盘、又不想引 10 个依赖的团队。`./presets/pino` 让日志保持 pino 行格式，未来可无缝接 pino 生态工具（jq 等）。

### E.4 「日志落库 + 前端查询」：没有成熟库，建议自写

- **调研结论**：npm 上**没有成熟维护的 SQLite/Postgres 日志 sink 库**。pino 官方 transport 列表里只有 `pino-pg`（Postgres，陈旧）、`pino-mysql` 等 legacy transport；`solid_log` 是 Rails 生态，不适用 TS。本项通常自己写，而且确实应该自己写——单用户量级（日几百~几千条）自写成本极低：
  ```sql
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,            -- epoch ms
    level INTEGER NOT NULL,         -- 30/40/50 pino 级
    scope TEXT,                     -- e.g. 'ingest', 'provider:quark'
    msg TEXT NOT NULL,
    data TEXT,                      -- JSON
    request_id TEXT
  );
  CREATE INDEX idx_logs_ts ON logs(ts);
  CREATE VIRTUAL TABLE logs_fts USING fts5(msg, scope, content='logs', content_rowid='id');
  ```
  - 写入：pino transport / tslog sink 里批量 `INSERT`（每 100 条或 1s flush，失败丢弃不阻塞主流程）；
  - 查询：`json_extract(data,'$.jobId')` 做结构化过滤 + FTS5 全文搜索 + 按 `level`/`scope`/时间范围过滤；
  - 面板：Next.js 一个受管理员路由渲染表格即可（分页 + 过滤器），无需引入任何前端日志库；
  - 保留策略：`DELETE WHERE ts < now - 30d` 定时清理（配 croner）。
- 参考实现范式（查询写法）可借鉴 centrallogging 的 SQLite 日志查询指南（json_extract 聚合错误、按 requestId 串请求等）：https://centrallogging.com/guides/sqlite-structured-logging-pino-nodejs

---

## F. 分享链接 / 磁力解析（网盘分享链接、magnet、ed2k、PT 站 API）

### F.1 magnet URI / .torrent / infoHash

| 库 | 版本 | Star | 周下载 | 许可证 | 体积 | API | 结论 |
|---|---|---|---|---|---|---|---|
| **parse-torrent**（`webtorrent/parse-torrent`） | `11.0.24` | **463**（2026-10-22 推送） | **39,473** | MIT | 解包 30KB | `parseTorrent('magnet:?...')` → `{ infoHash, name, announce[], files[], length }`；兼容 magnet / .torrent 文件 / infoHash 字符串 | ✅ **推荐**：一个入口统一三种标识；依赖 bencode、get-stdin、magnet-uri、uint8-util、queue-microtask、cross-fetch-ponyfill |
| **magnet-uri**（`webtorrent/magnet-uri`） | `7.0.10` | **237**（2026-10-22 推送） | **40,314** | MIT | 解包 16KB | `decode('magnet:?xt=urn:btih:...')` → `{ infoHash, name, trackers[] }` | ✅ 推荐（仅需 magnet 时；parse-torrent 内部即用它） |

- btih 解析、tracker 提取、display name 均由上述覆盖；Base32 btih 归一化由 `thirty-two` 处理。

### F.2 ed2k 链接

- `ed2k-link`（`lightrabbit/ed2k-link`）：**最后发布 2015 年**，MIT——停更。
- `@viegg/ed2k-link@0.0.2`：上述的 fork（`iwestlin/ed2k-link`），2024-02 发布，**周下载 0**，MIT。
- **结论：❌ 都不用。** ed2k 链接格式简单固定（`ed2k://|file|<name>|<size>|<md4-ish hash>|/` 及 `sources`/`h=` 扩展），一个正则 + `decodeURIComponent` 约 20 行即可，自写比引入零下载量的包更稳。

### F.3 PT / BT 站点 API 客户端

- **npm 上没有成熟维护的 TS 客户端库**（多轮检索未发现；生态里的参考实现多为其他语言：pt_mate（Flutter）、FlexGet（Python）、autobrr（Go）等）。
- 原因：各站 API 互不兼容（NexusPHP 系 / Unit3D 系 / Gazelle 系 / M-Team 私有 API），且普遍需要 passkey/API key 鉴权与反爬博弈。
- **结论：按站自写 adapter**，正好纳入重构方向 1 的「搜索提供商适配器」——每个站点一个实现类（搜索、详情、下载链接换取），registry 注册。可参考 NexisPHP 类站点的公开接口文档与各站 `api.php`/`ajax.php` 行为自行封装。

### F.4 网盘分享链接解析

- 同样**没有通用库**：夸克/阿里云盘/115/天翼/迅雷的分享链接格式与转存 API 各不相同（且经常变动）。
- **结论：自写**「分享链接识别（正则分发）+ 各网盘 API 客户端」两层，归入存储适配器。项目内已有的 115 RSA、天翼目录 ID 等坑位知识（见 `docs/115-api-safety-notes.md`）继续沉淀在各自 adapter 内。

---

## 附：数据来源清单

**npm registry / downloads API（api.npmjs.org、registry.npmjs.org）**：xstate、robot3、javascript-state-machine、@zag-js/core、tsyringe、inversify、typed-inject、awilix、bullmq、pg-boss、agenda、node-resque、liteque、plainjob、@minnzen/sqliteq、@walq/core、croner、p-retry、cockatiel、async-retry、pino、winston、tslog、ts-pattern、parse-torrent、magnet-uri、@viegg/ed2k-link、ed2k-link、opossum（版本/许可证/解包体积/依赖/周下载，周下载窗口 2026-06-25~2026-07-01）
**GitHub API（api.github.com）**：statelyai/xstate、matthewp/robot、jakesgordon/javascript-state-machine、microsoft/tsyringe、inversify/InversifyJS、nicojs/typed-inject、taskforcesh/bullmq、timgit/pg-boss、agenda/agenda、actionhero/node-resque、sindresorhus/p-retry、connor4312/cockatiel、vercel/async-retry、pinojs/pino、winstonjs/winston、fullstack-build/tslog、karakeep-app/liteque、Minnzen/sqliteq、justplainstuff/plainjob、unsady/walq、gvergnaud/ts-pattern、jeffijoe/awilix、Hexagon/croner、nodeshift/opossum（star 数/许可证/最近推送，2026-10-27 实测）

**关键页面**：
- XState：https://github.com/statelyai/xstate ・ https://www.npmjs.com/package/xstate ・ https://stately.ai/docs
- Robot：https://github.com/matthewp/robot ・ https://www.npmjs.com/package/robot3
- Zag：https://github.com/chakra-ui/zag ・ https://www.npmjs.com/package/@zag-js/core
- js-state-machine：https://github.com/jakesgordon/javascript-state-machine ・ https://www.npmjs.com/package/javascript-state-machine
- ts-pattern：https://github.com/gvergnaud/ts-pattern ・ https://www.npmjs.com/package/ts-pattern
- tsyringe：https://github.com/microsoft/tsyringe ・ https://www.npmjs.com/package/tsyringe
- inversify：https://github.com/inversify/InversifyJS ・ https://www.npmjs.com/package/inversify
- typed-inject：https://github.com/nicojs/typed-inject ・ https://www.npmjs.com/package/typed-inject
- awilix：https://github.com/jeffijoe/awilix ・ https://www.npmjs.com/package/awilix
- BullMQ：https://github.com/taskforcesh/bullmq ・ https://docs.bullmq.io/guide/postgresql
- pg-boss：https://github.com/timgit/pg-boss ・ https://pgboss.io/database-backends ・ https://www.npmjs.com/package/@pg-boss/dashboard
- Agenda：https://github.com/agenda/agenda ・ https://www.npmjs.com/package/agenda
- node-resque：https://github.com/actionhero/node-resque ・ https://www.npmjs.com/package/node-resque
- liteque：https://github.com/karakeep-app/liteque ・ https://www.npmjs.com/package/liteque
- plainjob：https://github.com/justplainstuff/plainjob ・ https://www.npmjs.com/package/plainjob
- sqliteq：https://github.com/Minnzen/sqliteq ・ https://www.npmjs.com/package/@minnzen/sqliteq
- walq：https://github.com/unsady/walq ・ https://www.npmjs.com/package/@walq/core
- croner：https://github.com/Hexagon/croner ・ https://www.npmjs.com/package/croner
- p-retry：https://github.com/sindresorhus/p-retry ・ https://www.npmjs.com/package/p-retry
- cockatiel：https://github.com/connor4312/cockatiel ・ https://www.npmjs.com/package/cockatiel
- async-retry：https://github.com/vercel/async-retry ・ https://www.npmjs.com/package/async-retry
- opossum：https://github.com/nodeshift/opossum ・ https://www.npmjs.com/package/opossum
- pino：https://github.com/pinojs/pino ・ https://www.npmjs.com/package/pino
- winston：https://github.com/winstonjs/winston ・ https://www.npmjs.com/package/winston
- tslog：https://github.com/fullstack-build/tslog ・ https://www.npmjs.com/package/tslog
- parse-torrent：https://github.com/webtorrent/parse-torrent ・ https://www.npmjs.com/package/parse-torrent
- magnet-uri：https://github.com/webtorrent/magnet-uri ・ https://www.npmjs.com/package/magnet-uri
- ed2k-link：https://github.com/lightrabbit/ed2k-link ・ https://www.npmjs.com/package/@viegg/ed2k-link
- Inngest 自托管：https://www.inngest.com/docs/self-hosting
- Temporal 自托管要求：https://specific.dev/blog/self-hosting-temporal
- SQLite 日志查询范式：https://centrallogging.com/guides/sqlite-structured-logging-pino-nodejs

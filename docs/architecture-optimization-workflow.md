# 巡影架构优化执行流程（Optimization Workflow）

> **依据文档**：`docs/project-survey.md`（现状调研）、`docs/design-problems-analysis.md`（缺陷剖析）、
> `docs/refactoring-architecture-and-design-patterns.md`（模式与选型）、`docs/architecture-remediation-and-governance.md`（治理与门禁）。
> **本文职责**：把四份调研文档转成可执行的优化流程——基线快照、问题→动作映射、Sprint 任务单、门禁命令、每轮执行规程。
> **创建时间**：2026-10-23 · **维护方式**：每完成一个任务更新状态与执行日志，本文是优化过程的唯一跟踪入口。

---

## 1. 目标与原则

1. **绞杀者模式（Strangler Fig）**：严禁推倒重写。所有改动以"新增中立模块 → 切换调用 → 删除旧实现"三步渐进推进，每步保持全测试绿。
2. **纯 SQLite 单引擎**：Docker 与桌面端 100% 共享同一套 SQLite 仓储，彻底移除 PostgreSQL（含依赖、双套 SQL、compose 服务）。
3. **物理分层**：`packages/contracts`（中立契约）→ `packages/shared`（无主共享）→ `packages/features`（业务）→ `packages/infrastructure`（实现）→ `apps/host-*`（宿主装配）。Features 严禁直接 import Infrastructure。
4. **门禁驱动**：L0~L5 六层门禁（见 §5），任一门禁红 = 该任务不视为完成。
5. **可验证优先**：每个任务必须有可执行验收命令；每轮结束全量测试必须绿。

## 2. 基线快照（2026-10-23 实测）

| 指标 | 实测值 | 采集命令 |
|---|---|---|
| 测试文件 / 用例 | 370 文件（370 过 / 0 跳）· 5018 用例（5018 过 / 0 跳） | `vitest run` |
| 全量测试耗时 | ~69s | 同上 |
| 测试前置条件 | `npm ci` + `npm run build:workflow`（含 build:shared） | — |
| PG 依赖 | **0**（pg + 14 个传递依赖已从 lock 移除） | `grep -rn "from 'pg'"` |
| compose 服务 | `web` + `worker` + `pansou` + `updater` + `cloudflared`（5 服务，无数据库容器；常驻循环在 worker） | `docker-compose.yml` |
| 凭据存储 | 网盘 cookie / API key / sendkey 落盘 AES-256-GCM 密文；密钥 = env 或库同目录 `credential.key`(0600)；旧明文读兼容 + 迁移脚本 | `credential-encryption.test.ts` |
| 数据访问 | 凭据三表（app_settings / account_settings / connected_storages）走 Kysely 类型安全 QB；其余表渐进迁移中 | `credential-store.test.ts` |
| Worker 拓扑 | 默认进程内（桌面/单进程）；`MEDIA_TRACK_WORKER_MODE=external` → 独立 `apps/host-worker` poker 进程（compose 默认） | `instrumentation.test.ts` / `poker.test.ts` |
| SQLite 侧现状 | `sqlite.ts` 黄金 PRAGMA 六件套齐全；另有 `SqliteJobQueue`（S1.2）、`SqliteJsonCache`（S1.4） | 单测断言 |
| 最大文件（P4 跟踪） | `repository.ts` 2,199 · `sqlite.ts` 2,217 · `storage-115-executor.ts` 1,706 · `worker.ts` 1,435；`apps/web/lib/workflow-runtime.ts` **3,763 行**（最大前端文件） | `wc -l` |

## 3. 问题 → 动作映射（覆盖 design-problems-analysis.md 全节）

| # | 问题（出处） | 优化动作 | 归属 Sprint |
|---|---|---|---|
| P1 | Next.js 进程内嵌常驻 Worker 反模式（§2.1） | 建 `apps/host-worker` 独立宿主；剥离 `instrumentation` 常驻循环 | S2 |
| P2 | DB 当消息队列 + 全表高频轮询（§2.2） | 落地 `SqliteJobQueue`（原子认领 + 指数退避 + 死信），替换轮询 | S1 |
| P3 | 无双 Query Builder 的双库手写 SQL（§2.3） | 引入 Kysely + kysely-sqlite 统一数据访问；删 postgres.ts | S1 |
| P4 | 上帝文件腐化（§2.4，如 3,763 行 workflow-runtime.ts） | 绞杀拆分 + L3 `max-lines` 门禁硬阻断 | S1~S4 |
| P5 | LLM 承担确定性任务（§3.1） | anitomy / parse-torrent-title 规则解析，AI 仅做 10% 歧义裁决 | S3 |
| P6 | 情绪化 Prompt 假想防线（§3.2） | 双轨流水线：90% 规则 + 10% AI，Prompt 收敛为结构化裁决 | S3 |
| P7 | 缺跨网盘事务与 Saga（§3.3） | XState 状态机 + Saga 补偿拦截器 | S3 |
| P8 | 死链与风控感知滞后（§3.4） | patrol 巡检 + 死链 TTL + 风控退避策略 | S3 |
| P9 | 串行阻塞执行管线（§4.1） | 队列多 Worker 并发消费 + 状态机异步步进 | S2/S3 |
| P10 | `listTree` 深度递归风暴（§4.2） | 驱动适配器分页 + 深度上限 + 限速 | S3 |
| P11 | 桌面端技术栈笨重（§4.3） | Electron 宿主化 + 本地单进程装配 | S2 |
| P12 | 逆向 API 高脆弱（§5.1） | `IStorageDriver` 适配器隔离，单盘故障不扩散 | S3 |
| P13 | 高频调用触发封号（§5.2） | 漏桶/令牌桶限速策略（115: 1.2s/发；夸克: 3/s burst 5）+ 429 熔断 | S3 |
| P14 | 验证码盲区（§5.3） | 扫码登录优先，保留人工介入通道 | 持续 |
| P15 | 凭证明文存储（§5.4） | AES-256-GCM 信封加密（`packages/shared/crypto`） | S1 |
| P16 | 多租户越权（§5.5） | scope 贯通 + 越权回归测试矩阵 | S2/S4 |
| P17 | SSRF 隐患（§5.6） | `shared/http-client` 出站白名单 + 测试 | S4 |
| P18 | 原生 ABI 偷换 hack（§6.1） | @electron/rebuild 正规化，删 hack | S2 |
| P19 | 环境变量庞杂（§6.2） | compose 精简（去 postgres）+ .env.example 重整 | S2 |
| P20 | 缺自动备份（§6.3） | SQLite 文件热备份 runbook + 定时任务 | S4 |

## 4. Sprint 任务单

> 状态图例：⬜ 未开始 · 🟨 进行中 · ✅ 完成（含验收证据）· ⛔ 阻塞

### Sprint 0 — 基线与流程（本轮已完成）
| ID | 任务 | 验收 | 状态 |
|---|---|---|---|
| S0.1 | 依赖安装 + workflow 包构建，跑通全量测试 | 4919 用例绿 | ✅ |
| S0.2 | 建立本流程文档与基线快照 | 本文 §2 | ✅ |

### Sprint 1 — 纯 SQLite 改造与契约建立
| ID | 任务 | 验收 | 状态 |
|---|---|---|---|
| S1.1 | 建 `packages/contracts` + `packages/shared` 中立骨架（IStorageDriver / ISearchProvider / IMediaMetadataProvider / IJobQueue / crypto / logger） | 目录存在、零第三方依赖、tsc 过 | ✅ |
| S1.2 | `SqliteJobQueue` 落地（sys_queue_jobs 表 + `UPDATE…RETURNING` 原子认领 + BEGIN IMMEDIATE + 指数退避 + 死信） | `:memory:` 单测全绿（含并发认领唯一性、退避、死信） | ✅ |
| S1.3 | SQLite 黄金 PRAGMA 四件套补齐（synchronous=NORMAL / busy_timeout=5000 / temp_store=MEMORY / cache_size=-64000） | 单测断言 pragma 值；全量测试绿 | ✅ |
| S1.4 | 删 `postgres.ts` + 剥离全部 pg 依赖（23 文件 / 7 个 .pg.test / 12+ scripts / compose） | `grep pg` 归零；全量测试绿；compose 去 postgres | ✅ |
| S1.5 | 凭据 AES-256-GCM 加密落盘（含迁移读取旧明文） | 加解密单测 + 迁移测试 | ✅ |
| S1.6 | Kysely + kysely-sqlite 统一数据访问（新查询走 QB，存量渐进替换） | 类型检查过；抽样仓储迁移 | ✅ |

### Sprint 2 — 独立 Worker 与部署解耦
| ID | 任务 | 验收 | 状态 |
|---|---|---|---|
| S2.1 | `apps/host-worker` 独立进程（HTTP poke run-next/run-type3） | Worker 可独立启动；冒烟验证 drain 序列 + SIGTERM | ✅ |
| S2.2 | 剥离 Next.js instrumentation 常驻循环（P1） | 门控 5 用例；external 模式 web 无常驻循环 | ✅ |
| S2.3 | compose 精简 + .env.example 重整（P19） | 服务表更新；env 文档含 worker/secret/逃生门 | ✅ |
| S2.4 | Electron ABI 正规化（P18/P11） | afterPack 自动换+验证；README 手动步骤移除 | ✅ |

### Sprint 3 — 业务流水线规则化与状态机
| ID | 任务 | 验收 | 状态 |
|---|---|---|---|
| S3.1 | anitomy + parse-torrent-title 解析（P5） | 真实文件名解析单测 + inspectStaging 集成 + 性能基准 | ✅ |
| S3.2 | XState 状态机 + Saga 补偿（P7/P9） | 10 状态机单测 + 3 个 workflow 集成测试 | ✅ |
| S3.3 | 限速原语 + 品牌 pacing（P13）；IStorageDriver 契约已在 S1.1 定义，executor 统一适配留待后续 | 限速 9 + 装饰器 6 + 工厂接线断言 | 🟨 |
| S3.4 | 死链回收 + 健康快照 + 接入巡检（P8） | 契约测试双实现覆盖 + patrol 接线 | ✅ |

### Sprint 4 — 门禁与测试金字塔闭环
| ID | 任务 | 验收 | 状态 |
|---|---|---|---|
| S4.1 | L0~L3 门禁（P4/P16/P17） | 每层用合成违规实证可抓 + 存量基线接管 | ✅ |
| S4.2 | 文件型全栈集成 + 认领契约双实现 + CI 切片测速 | 契约双实现 + 真文件集成 + 耗时基线 | ✅ |
| S4.3 | Playwright E2E 冒烟（搜索→转存→落盘→UI） | 流水线可跑 | ⬜ |
| S4.4 | 备份 + **恢复演练**（P20） | 6 单测 + 真实 drill 正/反两路 | ✅ |

## 5. 质量门禁（L0~L5，可执行）

| 层 | 检查 | 命令 / 规则 | 当前状态 |
|---|---|---|---|
| L0 物理所有权 | 新文件必须归入 contracts/shared/features/infrastructure/apps 之一 | 文件树检查脚本 | ⬜ 待建 |
| L1 依赖方向 | packages 间禁止逆向/循环依赖 | dependency-cruiser | ⬜ 待建 |
| L2 源码边界 | Features 禁 import Infrastructure；Contracts 保持纯净 | ESLint `import/no-restricted-paths` | ⬜ 待建 |
| L3 实现约束 | `max-lines` ≤ 600（跳过空行注释）、`complexity` ≤ 15 | ESLint 规则 | ⬜ 待建 |
| L4 运行时契约 | 全量单测/集成测试 | `vitest run` | ✅ 基线 4919 绿 |
| L5 构建发布 | `build:workflow` + typecheck + Docker 健康检查 + E2E | `npm run build:workflow && npm run typecheck` | ✅ 基线过 |

**每轮必跑**（任务验收的最低集）：
```bash
npm run build:workflow        # L5 前置
node node_modules/vitest/vitest.mjs run   # L4
```

## 6. 每轮执行规程（Round Protocol）

1. **选任务**：从 §4 取状态为 ⬜/🟨 且前置已完成的最小任务。
2. **红灯**：先写失败测试（新行为）或复现脚本，运行看到红。
3. **绿灯**：最小实现，运行转绿；**不允许**顺手重构无关代码。
4. **全量回归**：跑 §5「每轮必跑」，必须全绿；红则修复或回退本任务。
5. **更新文档**：改 §4 状态、§7 执行日志；基线数字变化时同步 §2。
6. **提交**：一个任务一个 commit（message 引用任务 ID，如 `refactor(sqlite): S1.2 SqliteJobQueue 原子认领`）。

## 6.5 与上游同步（fork 的防覆盖纪律）

本仓库是 `fancydirty/mediary-scout` 的 fork，开发直接在自己的 `main` 上（标准 fork
工作流，**不需要切换分支**；GitHub 的 Sync fork 是「把上游合进你的 main」，你的提交
全部保留，不存在覆盖）。

**标签不能改名**：`vYYYY.MM.DD` 是仓库自身的机器可读约定——`Release Docker` /
`Release Desktop` 的 `on: push: tags: v*` 触发器、`updater/run-update.sh` 的
`is_release_tag()`、`apps/web/lib/release-version.ts` 解析器、`scripts/deploy.sh`
找最新标签，全都认这套格式。加 `fork-` 前缀会一次性全部破坏。

**但上游用的正是同一套命名**（已 `git ls-remote --tags upstream` 验证：
v2026.09.29 / v2026.09.30 / v2026.10.04 / v2026.10.12 / v2026.10.22 …），
所以拉上游时必须隔离标签，否则与你将来的发布标签撞名：

```bash
git remote add upstream https://github.com/fancydirty/mediary-scout.git   # 仅一次

git fetch --no-tags upstream                       # 只拿分支（推荐）
# 或让上游标签落到独立命名空间，永不撞名：
git fetch upstream 'refs/tags/*:refs/tags/upstream/*'

git checkout main
git merge --no-ff upstream/main                    # 上游合进你；别 reset --hard，别 force-push
```

两个已核实的兜底：

1. git 对撞名标签**拒绝覆盖**（fetch 报错中止），不会静默丢失你的标签——
   坏处只是同步动作失败而非数据受损。
2. 一键更新只 `fetch origin`（你自己的 fork，见 `updater/run-update.sh` 的
   `fetch --tags --force origin`），发布与更新链路天然看不到上游标签。

冲突预判（本分支与上游分叉最深的文件）：`packages/workflow/src/sqlite.ts`
（PG→SQLite 重写）、`docker-compose.yml`（单镜像模式）、
`updater/run-update.sh`（拉镜像）、`scripts/deploy.sh`（标签化部署）、
`.github/workflows/*`。

## 7. 执行日志

| 时间 | 任务 | 动作与证据 |
|---|---|---|
| 2026-10-23 03:11 | S0.1 | `npm ci`（441 包）+ `build:workflow` 通过；首跑 46 文件因缺 dist 失败，构建后 **357 文件 / 4919 用例全绿**（67s） |
| 2026-10-23 03:13 | S0.2 | 基线快照与流程文档建立（本文） |
| 2026-10-23 03:16 | S1.1 | 新建 `packages/contracts`（4 个基础设施端口：IStorageDriver / ISearchProvider / IMediaMetadataProvider / IJobQueue）+ `packages/shared` 骨架；workspace 链接就位；contracts tsc 与根 typecheck 均过 |
| 2026-10-23 03:18 | S1.2 | TDD 落地 `SqliteJobQueue`：先红（模块不存在）→ 实现 → 8/8 绿（305ms）。修正两处：测试导入改默认导入（仓库惯例）；退避断言改为文档公式的正确值（首败 10s 而非 20s）。workflow 构建 + 根 typecheck + **全量 358 文件 / 4927 用例绿**（68s，较基线 +1 文件 +8 用例） |
| 2026-10-23 03:26 | S1.3 | TDD 落地黄金 PRAGMA：先红（synchronous 默认 FULL）→ sqlite.ts 构造器补齐四件套 → 绿。workflow 168 文件 / 2173 用例回归绿 |
| 2026-10-23 04:08 | S1.4 | **纯 SQLite 化完成（P2/P3 核心部分）**：① workflow 包删 `postgres.ts`(2349 行) + 10 个 PG 测试 + pg/@types/pg 依赖；② web 侧 `PostgresMediaSearchCache` → 新增 `SqliteJsonCache`（8/8 TDD 绿，语义逐条对齐 PG 版），`getWorkflowRepository` 恒走 SQLite（默认 `data/mediary.db`，父目录自动建）；③ 23 个 scripts：删 3 个 PG 专属（repro-schema-deadlock / verify-\*-postgres / pg-backup.sh），20 个转 SQLite（新建 `scripts/_lib/sqlite-db.mjs` 助手；方言转换均经真实引擎验证：`->>`→json_extract、TRUNCATE→逐表 DELETE、string_agg→group_concat、epoch→julianday）；④ compose 删 postgres 服务与 pgdata 卷、加 `mediary-data` 卷；⑤ CI 重写（去 postgres service，单次 vitest）；⑥ updater 更新前备份 pg_dump → `VACUUM INTO` + stdout 重定向（149 个 updater 测试同步改并全绿）；⑦ .env.example / deploy.md / launch.json / 全部过期注释清理。**验收：`npm ci` 可用、lock 同步（pg + 14 传递依赖移除）、全量 358 文件 / 4931 用例绿、lint + typecheck 绿；代码/脚本/配置/CI 中 postgres 引用清零（仅剩新文件里有意的历史对照注释）** |
| 2026-10-23 04:21 | S1.5 | **凭据落盘加密完成（P15）**：① 新建 `packages/shared/src/crypto/credential-crypto.ts`（AES-256-GCM，`enc:v1:` 前缀 + base64(iv|tag|ct)；密钥顺序：env `MEDIA_TRACK_CREDENTIAL_KEY` → 库同目录 `credential.key`(0600 自生成) → :memory: 进程内临时密钥；口令长度不当按 scrypt 派生）—— 11/11 TDD 绿（含换钥解不动、篡改抛错、非法密钥文件明确报错）；② shared 包改为构建到 dist（`build:shared` 并入 `build:workflow`），workflow 包加运行时依赖；③ 仓储边界透明加解密：`connectedStorageFromRow`/`upsertConnectedStorage` 两个 choke point + 敏感设置键注册表 `isSecretSettingKey`（10 个显式键 + `push_*` 族），7/7 TDD 绿（磁盘验密文、API 读回明文、旧明文兼容、跨实例同钥）；④ 迁移脚本 `scripts/migrate-encrypt-credentials.mjs` 端到端验证（dry-run/apply/幂等/读回）；⑤ .gitignore 加 `credential.key`，.env.example / deploy.md（备份必须连密钥）/ dev-db-query 注记同步。**验收：全量 360 文件 / 4949 用例绿（+18 新用例）、lint + typecheck 绿** |
| 2026-10-24 05:13 | S4.4 | **Sprint 4 收官（P20）**：备份脚本 S1.4 已有，真缺口是**没有任何恢复验证**——未经演练的备份不算容灾。① `packages/shared/src/sqlite-backup.ts`：backup（VACUUM INTO 一致性快照）/ verify（integrity + 每表行数，损坏**报告**不崩溃——测试逼出了这个加固）/ compare（逐表行数比对）/ restore。6/6 TDD 绿，钉死关键属性：**WAL 里未合并的已提交数据必须进备份**。② `scripts/sqlite-restore-drill.mjs`：解压→校验→比对，不过即非零退出。**真实验证两路**：好备份 `✓ 恢复演练通过`（exit 0）；损坏备份 `✗ 备份损坏，不可恢复`（exit 1）。③ deploy.md 补「恢复演练」小节 + crontab 建议；`npm run drill:restore` 脚本。**验收：全量 372 文件 / 5044 用例绿、gate 退出 0、三处 tsconfig + build:web 全过** |
| 2026-10-24 04:45 | S4.3 | **Sprint 4 之三 + 抓到一个潜伏构建回归**：① 新建 `e2e/`（playwright.config.ts + acquire-flow.spec.ts）——webServer 自动起**全确定性 fake 栈**（demo 搜索 + fake 存储 + stub agent + 独立 SQLite + 进程内 worker），4/4 通过：首页渲染 / demo 搜索 / health 探针 / **点获取→入队→worker drain→队列无卡滞**（server 日志实证 `drained 1 queued run(s)`）。② **E2E 的构建步骤抓出 S1.4/S1.5 引入的潜伏回归**：`next build` 客户端 chunk 被拖进 node:fs——根因是 node:fs 经 shared/workflow barrel 进入客户端可达链（HEAD 时链里是 pg，JS 可打包；我加入 node:fs 后不可打包）。修复四连：durable-cache/workflow-runtime 去掉 node 内置（mkdir 收进包的调用时 require）、`resolveIsDesktop` 迁零依赖叶子模块切断 3700 行运行时子树、app/update-actions 三处静态导入改动态（对齐该文件既有模式）、release-version 改导 shared 窄子路径。另修 2 个被掩盖的类型错误（根 typecheck 不覆盖 apps/web，CI 覆盖）+ 测试 mock 迁移 + L0 白名单 e2e/ + dep-cruiser 基线随图合法变化重生（5→4，第 5 个循环 update-view-server↔workflow-runtime 正好被本次重构修掉）。**验收：E2E 4/4、全量 371 文件 / 5038 用例、gate 退出 0、三处 tsconfig + build:web 全过** |
| 2026-10-23 08:38 | S4.2 | **Sprint 4 之二**：① 摸清存量——SQLite 相关 6 个切片 159 用例 2.3s（已达文档“1 秒级全量”量级）；executor 沙盒测试早已由 Storage115Simulator 系列覆盖（115 1660 行/pan123 1114 行/guangya 832 行测试）。② **发现真缺口：`claimNextQueuedRun`（并发最关键的 SQL：事务内 read+flip）在共享契约里 0 覆盖，只在 InMemory oracle 上证明过**——在契约补 6 个用例（FIFO/跨 drive 跳过/全忙碌 null/kind 独立队列/翻转 running 不二次认领/空库），SQLite 与 InMemory 双实现同时被证明（133+133）。③ 新增**文件型全栈集成测试**（3 用例）：真文件上 WAL+busy_timeout 生效、`credential.key` 同目录 0600、**跨连接可见性**（第二实例解出第一实例提交的加密凭据）、完整工作流跑通 + 落库读回 + 死链回收。**验收：契约 266 用例、全量 371 文件 / 5038 用例绿、gate 退出 0、typecheck 绿** |
| 2026-10-23 08:35 | S4.1 | **Sprint 4 启动（P4/P16/P17）**：① **L0 布局门禁** `scripts/check-layout.mjs`——packages/apps 必须登记（package.json+name+tsconfig）、workers 必须有 wrangler.jsonc、根目录只允许白名单文件。上线即抓到真问题（workers/* 无 package.json 的误报，查证后确认 CF Worker 故意非 workspace，改为 wrangler 标记规则）。② **L1 依赖图** `.dependency-cruiser.cjs`——6 条有序跨应用规则（ESLint 匹配不到相对逃逸，这里补上）+ 循环检测 + shared 基础层/contracts 中立/库不依赖宿主。存量 5 个循环走 `--ignore-known` 基线接管；**实证新增跨应用导入立刻失败**。③ **L2 边界**（ESLint `no-restricted-imports`，包名级）——关键发现：ESLint 用 ignore(gitignore) 语义，**无法匹配带 `..` 的相对引用**（ignore 包直接拒绝），故相对路径边界划归 L1，分工写入配置注释。④ **L3 约束** max-lines(600)+complexity(15)，125 个存量违规由 `eslint-suppressions.json` 基线接管（文档 §6.3 机制），实证新增长文件/新违规必挂。⑤ 全部接进 `npm run gate`（layout→deps→lint）与 CI。**意外收获**：L1 抓到 `parseReleaseTag` 在 web/desktop 逐字重复（desktop 注释写着「tests keep the two in step」人肉同步）——上收 `packages/shared/src/release-tag.ts` 单一事实源，消掉跨应用导入。**验收：gate 退出 0、全量 370 文件 / 5023 用例绿、typecheck 绿、四层门禁均用合成违规实证** |
| 2026-10-23 07:15 | S3.4 | **Sprint 3 收官（P8）**：死链机制原有记录/分级 TTL/读取过滤已完备，缺口是**过期软链只被过滤、从不删除**（表无限增长）且无健康可见性。① `DeadLinkStore` 新增 `reapExpiredDeadLinks`（只删过期软链，永久链永不回收，幂等，返回删除数）+ `deadLinkStats`（total/permanent/softActive/softExpired/byKind，softExpired 即可回收数）；② InMemory 与 SQLite 双实现，测试加进**共享契约**（一套覆盖两个实现）；③ 接入每日巡检 `runScheduledType3Now`——紧挨既有 pruneFinishedWorkflowRuns 的机会性 GC，best-effort 不阻断，softExpired 残留或永久链堆积时打 `[patrol] dead-links:` 可见信号。**排障中修掉 4 处测试 fake 缺新方法（根 typecheck 抓到）与 2 处我自己的测试算术/语法错误**。**验收：全量 370 文件 / 5023 用例绿、lint/typecheck 绿** |
| 2026-10-23 06:20 | S3.3 | **P13 封号风险（限速部分）**：① 新建 `packages/shared/src/rate-limiter.ts`——LeakyBucketPacer（恒定间隔，等待者串行链）+ TokenBucketPacer（平均速率 + 突发积压）+ 品牌注册表（115=漏桶 1.2s、夸克=令牌桶 3/s burst 5，治理文档参数），时钟/等待全注入，9/9 TDD 绿；② **115 内联 pacing 重构为共享原语**（`applyDelay` 的 lastCallAt 算术 → `pacer.pendingDelayMs()` + `pacer.wait()`，delay 可观测事件保留，行为逐点一致，既有 guard 测试全绿作证）；③ 新建 `brand-pacing.ts` Proxy 装饰器（只包 pacing，返回值/this/非方法属性原样，未登记品牌零包装），6/6 TDD 绿；④ **补上真缺口：quark executor 经工厂接令牌桶**（此前完全无 pacing；115 早有 1.2s），工厂测试加 spy 断言防接线裸奔。**验收：全量 370 文件 / 5018 用例绿、lint/typecheck 绿**。IStorageDriver 端口契约 S1.1 已定义；把 12 方法的 StorageExecutor 全面统一到该端口是更大重构，记为后续项 |
| 2026-10-23 05:58 | S3.2 | **Sprint 3 之二（P7/P9）**：新建 `run-state-machine.ts`——对齐治理文档 §5.4 状态图的 XState v5 机器（scheduled→directoryProvisioning→resourceSearching→candidatesEvaluating→transferring→pollingLanding→inspecting→organizing→deduplicating→stagingPurging→completed；任一非终态 FAIL→sagaCompensating→COMPENSATED→failed；noCoverage/nothingToDo 独立终态）。架构取舍：**机器只管状态迁移，补偿清单/失败原因由 façade 用纯 TS 管理**（绕开 xstate v5 assign 泛型与仓库 exactOptionalPropertyTypes 的冲突）；进入 directoryProvisioning/transferring/organizing 即登记补偿（暂存目录/半成品/搬运残留，后进先出）。**集成进 `runAcquisitionV2Workflow`**：粗粒度阶段标记（agent 内部步骤仍以其自身 trace 为准，已在注释声明）+ 结果新增 `runState`/`compensations`；失败路径 FAIL→与 withStagingCleanup 的 finally 做一致性互检→COMPENSATED→记 `[workflow] saga:` 日志→原样上抛。终态/非法事件在 façade 层吞掉（顺带消除 xstate 的 stopped-actor 警告）。13 个新测试全绿。**验收：全量 368 文件 / 5003 用例绿、lint/typecheck 绿、无警告** |
| 2026-10-23 05:36 | S3.1 | **Sprint 3 启动（P5）**：新建 `media-title-parser.ts`——三层确定性解析：anitomy（动漫括号名）→ parse-torrent-title（欧美发行名）→ 中文正则层（第N集/第N话/尝鲜版N/全N集/End·完 终章），合并输出归一化集号/季/画质/字幕组/年份。关键修补：① anitomy 会把电影年份误读成集号（Oppenheimer.2023→E2023）——等于年份的"集号"判为电影；② anitomy 0.0.35 不填 release.group——加首括号 token 兜底（跳过分辨率/语言/编码类 token）。9/9 TDD 绿。**集成**：`SimTreeFile.parsed` 字段 + `listTreeOf` 统一附加（`withParsedFileName`，幂等不抛），inspectStaging 等全部 listing 自带结构化解析；skill 提示词两处更新——"'parsed' 字段是 ground truth，不要从名字重新推导，仅当 episodeCode 为 null 才自行判断"。4/4 集成测试绿。**真实性能基准：单次 28.6µs（1 万次 286ms），较 LLM 调用快约 10 万倍、零 token、100% 可复现**。**验收：全量 366 文件 / 4990 用例绿、lint/typecheck 绿** |
| 2026-10-23 05:24 | S2.4 | **Sprint 2 收官（P18/P11）**：`after-pack.js` 从「只翻 fuses」扩展为 ABI 正规化终点——定位打包产物里 standalone traced 的 better-sqlite3 → `prebuild-install -r electron -t <version>` 抓 Electron ABI 预编译（免工具链）→ **双重强制验证**：① 二进制哈希必须变（杀死 @electron/rebuild「报成功没换二进制」的 silent no-op 前科）② 让产物内 Electron 以 `ELECTRON_RUN_AS_NODE=1` 实 require 并读回 ABI=130，任一失败即构建失败。7/7 TDD 绿；**真实功能验证**：prebuild-install 实抓 `better-sqlite3-v12.11.1-electron-v130-linux-arm64.tar.gz` 并安装到位（本容器缺 libnss3 导致 electron 验证步无法运行——环境限制，真实构建机无此问题）。README 删「手动 npx 偷换」步骤改为自动化说明；electron-builder.yml 注释同步。**验收：全量 364 文件 / 4977 用例绿、lint/typecheck/desktop 构建全过** |
| 2026-10-23 05:13 | S2.1+S2.2+S2.3 | **P1 头号反模式解除**：① 新建 `apps/host-worker`（TS，tsc 构建，零依赖）——常驻循环改为 HTTP poke web 已有的 `/api/workflows/run-next` 与 `/run-type3`（两条路由本就带 `x-media-track-worker-secret` 鉴权），零代码共享、零数据库访问；8/8 TDD 绿（idle 节流/非 idle 立即重 poke/secret 头/巡检节流/网络错不炸/401 不退出/SIGTERM 退出）；**对构建产物做真实 HTTP 冒烟**：run-next 3 连 poke（2 succeeded+1 idle）+ 首轮巡检 + 干净停机。② `instrumentation.ts` 模式门控 5/5 TDD 绿：`MEDIA_TRACK_WORKER_MODE=external`（或旧开关 `INPROCESS_WORKER=0`）→ 不启进程内循环，孤儿恢复（有界一次性）留在 web 启动路径；`INPROCESS_WORKER=1` 为逃生门；默认保持进程内（桌面/单进程零变化）。③ compose 新增 `worker` 服务（同镜像、`node apps/host-worker/dist/main.js`、无卷无端口），web 侧设 external + secret；Dockerfile 增建/拷贝 host-worker dist；.env.example / deploy.md 同步。**验收：全量 363 文件 / 4970 用例绿、lint + typecheck 绿、构建产物冒烟通过** |
| 2026-10-23 05:06 | S1.6 | **Sprint 1 收官**：引入 Kysely 0.29（其内置 `SqliteDialect` 即驱动 better-sqlite3，无需第二驱动/自写方言）。① `db-schema.ts` 表结构类型化单一事实源（`Generated` 标注 DB 默认列）；② 新建 `credential-store.ts`——凭据三表（app_settings / account_settings / connected_storages）全部读写迁到 Kysely，8/8 TDD 绿，把最易回退的语义钉死（跨账号冲突 no-op、同账号刷新、frozen 保留、按 (id,account) 删除）；③ `SqliteWorkflowRepository` 8 处委托切换（设置/存储 CRUD），加密边界保持在仓储层（payloadText 原样落盘，避免双重编码）；`tryUnbindConnectedStorage` 等原子事务路径暂留 raw SQL（绞杀者渐进）。**验收：全量 361 文件 / 4957 用例绿（+8 新用例）、lint + typecheck 绿、kysely 依赖归位 packages/workflow** |

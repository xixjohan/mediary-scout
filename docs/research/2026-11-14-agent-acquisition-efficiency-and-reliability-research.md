# Agent 采集效率、入库可靠性与工具编排优化调研

日期：2026-11-14。状态：研究与设计提案，**未实施业务修改，未触发生产重试、转存、清理或部署**。

## 1. 结论先行

1. 活动页的“Agent 步骤”是工具开始记录数；每行“次调用”是该工具开始前累计的网盘 guard 操作计数。两者都不是模型请求数，也不能把每行数字相加。
2. 本次《修罗雪姬》(1973)没有入库的直接证据是：同一个磁力候选被转存 5 次，每次均记录 `no_target_change`、空 `materializedFileIds`，消息为“离线任务已接受，但未检测到视频落地”；只读复查时目标目录确实为空。**不是已落地文件仅漏写数据库。**
3. 当前 115 执行器采用短窗口确认秒传，而不是等待普通离线下载完成；未落地后，同链接占位会释放，旧候选又能被调用。这把一次未命中变成重复提交、轮询与扫描，却不增加获得资源的证据。
4. 通知把“有候选但未落地”泛化成“暂无资源”；缺少持久的工具结束事件和循环停止原因，无法精确还原最后为何结束。
5. 候选标题是“1973＋1974 两部合集／蓝光原盘”。本地电影指南明文拒绝这类候选，仍不能靠提示词保证真实准入。即使后续落地，也不等于已得到目标电影的单一可播放正片。
6. 推荐保留 AI SDK、XState、SQLite 和现有限流底座：**LLM 处理语义歧义，代码负责状态迁移、转存/等待、防重、验证和提交。**不建议首先引入另一个完整 Agent 框架。
7. 防止同候选重复提交可以节约操作，但不能让外部网盘凭空完成下载；“支持持久后台离线下载”“自动拆分电影合集”“改变质量去重规则”是额外产品决策，不能在本次提示词优化中偷偷启用。

## 2. 范围、证据等级与版本边界

- **线上观测**：用户指定的正式活动页、已登录会话下的单个目标目录 GET、只读 SQLite 查询、限定时段容器日志。没有发起业务写操作；登录仅用于授权读取。
- **当前代码**：本地 `mediary` 分支，HEAD `91132338`，同时存在用户未提交修改。本文引用的是调查时的工作区，不等价于全部已经部署的生产源码。
- **推断**：由线上序列和当前代码推导，显式标记；不把未持久化的工具返回、取消结果、模型停止原因当成已取得证据。
- **建议**：下文新状态、新字段、新工具与账本均为待实现方案，不声称系统已经具备。

生产健康接口返回成功，但不提供构建 SHA；生产运行环境未取得可确认的 `BUILD_COMMIT`。因此，能确认本次运行及转存记录成功持久化，不能据此证明所有数据库路径正常，也不能认定本地每一处修复均已上线。

本文不包含管理员密码、Cookie、Token、私钥、磁力原文、分享地址或生产连接端点。运行标识仅用于维护者在内部日志中定位。

## 3. 现场：为什么调用很多，最终仍未入库

### 3.1 本次运行的事实

| 项目 | 观测 |
| --- | --- |
| 作品 | 修罗雪姬，1973，TMDB 2487 |
| workflowRunId | `6265b20b-8314-484a-af60-27aee0d41e6d` |
| 开始／结束 | `2026-11-14T09:46:43.625Z` ／ `2026-11-14T09:51:31.342Z` |
| 持续时间 | 约 4 分 47.7 秒 |
| 最终状态 | `no_coverage` |
| 工具开始记录 | 22 条，ordinal 0–21；截图中的 19 步是尚未结束的中间状态 |
| 实际转存记录 | 同一候选 `s1-1` 共 5 次 |
| 5 次结果 | `no_target_change`；`materializedFileIds: []` |
| 原始结果消息 | `offline task accepted; no target video materialized yet` |
| 库存 | 唯一电影占位集 `obtained: false`，`verifiedFileIds: []` |
| 目标目录只读复查 | HTTP 200；文件 0、子目录 0、总字节 0 |
| 最终通知 | 泛称“暂未找到可用资源 · 将持续尝试” |

电影使用剧季/集结构承载库存。该记录中的 season `completed` 字段不能作为正片入库证据：应看 `obtained`、验证文件及真实目录。本次这些证据均不支持入库成功。

唯一电影候选的标题同时包含《修罗雪姬》1973、《修罗雪姬2》1974、CC Blu-ray、蓝光原盘及合集信息，链接类型为 `magnet`。这证明存在候选，不证明它当前可秒传、能被下载或符合单正片导入要求。

其他搜索中，日文标题召回 5 条一般漫画／卷册记录；不转存它们是正确的身份排除。中文加年份、英文加年份及英文裸标题的对应快照均为健康空结果。不能把本次 5 次转存失败与同片早前另一次“片名预筛全部剔除”的运行混为一谈。

### 3.2 重复成本的证据

下表使用工具开始时的累计计数，不是单工具埋点耗时或完整 HTTP 计数。时间为 UTC。

| 转存工具序号 | 开始时间 | 开始前累计计数 | 紧随检查开始前计数 | 两次采样间增量 |
| --- | --- | ---: | ---: | ---: |
| #10 | 09:48:18.794 | 3 | 16 | 13 |
| #12 | 09:48:53.267 | 17 | 30 | 13 |
| #16 | 09:49:28.181 | 32 | 45 | 13 |
| #18 | 09:49:59.532 | 46 | 59 | 13 |
| #20 | 09:50:30.727 | 60 | 73 | 13 |

每组转存开始到下一检查开始相隔约 25–29 秒，其中包含工具执行与模型后续决策时间，不能全算作 API 延迟。5 组累计采样差合计 65，说明主要成本集中在反复转存阶段；并不能据此精确分解每一种 HTTP 请求。

- #0、#1 为读取指南；当前入口要求先读 protocol 与 movie，两次工具调用可以同一模型步骤发出。
- #4–#6 的搜索同时间发起；一般情况下，邻接行累计计数相减不能归因到单个并行工具。
- #13、#14 同时检查 staging 和 target；电影当前 staging 就是 target，存在重复目录读取。
- #15 调用了 `transferUntilLanded([s1-1])`，前后累计计数保持 32。**推断**：当前工具只接受分享候选，磁力会被拒绝，符合没有消耗网盘操作的现象；现有 trace 没存该调用结果，不能当成已捕获错误原文。
- 最后一次工具开始前计数是 73，之后仍可能检查或收尾，**不能说全程最终恰好调用 73 次**。
- 后六条呈 transfer／inspect 交替，形态上符合重复保护的窗口，但停止判断比较的是完整模型步骤签名，而不只是工具名字。没有持久的 stopReason，不能确认一定由重复保护触发。
- 没有记录到 `flattenMovie`、`markObtained`、`finish` 或 `reportNoCoverage`，最终模型文本和选源理由也为空。

### 3.3 计数口径的代码依据

- [活动时间线](../../apps/web/features/activity/components/agent-timeline.tsx#L22)显示步骤数量，[每行计数](../../apps/web/features/activity/components/agent-timeline.tsx#L30)未明确标为“开始前累计网盘操作”。
- [AgentStepView](../../packages/workflow/src/domain/agent-step-view.ts#L27)明确 `apiCalls` 是开始前累计值；同文件 L35 限制时间线展示为最多 50 条，不能把 UI 尾部当完整审计历史。
- [trace sink](../../packages/workflow/src/acquisition-v2/agent-trace-sink.ts#L48)在 `onToolCall` 时采样，不记录独立的工具结束、结果和耗时；同文件 L37 起重跑会清除同 run 的旧步骤。
- [Pan115ApiGuard](../../packages/workflow/src/storage/storage-115-executor.ts#L335)按包装操作增加计数；底层分页或封装内额外请求可能使一个操作对应多次 HTTP。
- [补扩展名 rename 回调](../../packages/workflow/src/storage/storage-115-executor.ts#L665)直接调用 `this.api.renameFile`，没有通过这里的 `callApi`。因此不能把该 guard 计数称为全量、严格的实际网盘 HTTP 次数。

### 3.4 为什么“任务接受”没有变成入库

[115 转存执行器](../../packages/workflow/src/storage/storage-115-executor.ts#L591)当前链路为：

```text
检查转存预算和写入范围
→ 转存前列目录
→ 提交分享／离线任务
→ 短窗口检查目录和离线任务状态
→ 转存后列目录，计算新文件 ID
→ 根据 action 与新文件判定 status
→ 成功时补扩展名
→ 非成功且不属于已有任务／已确认完成时，尝试取消离线任务
→ 返回转存结果
```

默认离线检测为 4 次、间隔 2 秒；目录请求、任务请求及默认操作节流另占时间。检测到完成信号但目录未显现时，可额外延长一轮窗口。因此它既不是“只等 8 秒的总时限”，也不是长下载任务管理器。[默认值](../../packages/workflow/src/storage/storage-115-executor.ts#L491)、[完成延长](../../packages/workflow/src/storage/storage-115-executor.ts#L627)、[取消分支](../../packages/workflow/src/storage/storage-115-executor.ts#L676)。

**已证实**：本次 5 次均未记录新文件，当前目标为空。

**代码机制**：普通磁力任务在短窗口没有确认落地，执行器会尝试取消；best-effort 取消失败不会改变转存返回结果。

**不能证实**：本次每次取消是否成功、磁力是否无种、资源是否永久失效、如果多等是否会成功。不能将 `accepted` 当 `completed`，也不能将短窗口空目录直接当永久死链。

## 4. 现有逻辑的主要缺口

### 4.1 副作用防重与失败分类

| 缺口 | 当前依据 | 影响 |
| --- | --- | --- |
| 未落地后释放同链接占位 | [sandbox](../../packages/workflow/src/acquisition-v2/sandbox.ts#L1055)异常时 release；L1073–1074 无新 ID 也 release | 同 run 的旧候选可反复提交；现有机制偏向防并发和防已落地重复，不是失败后的幂等账本 |
| 结果语义被压平 | [RealStorageV2](../../packages/workflow/src/acquisition-v2/real-storage-adapter.ts#L126)将非 succeeded 映射为 failed，另附 noTargetChange | 未秒传、仍在复制、结果未知、真实拒绝容易被模型一概当失败 |
| 死链登记不是执行门禁 | [dead-links](../../packages/workflow/src/acquisition-v2/dead-links.ts#L127)对部分 magnet no_target_change 登记软死链；sandbox仍可用已观察的旧快照 handle | 持久过滤下次搜索，不保证拦住本轮旧候选 |
| 单纯重复保护不足 | [签名](../../packages/workflow/src/acquisition-v2/agent-loop-guards.ts#L82)直接 stringify 输入/输出；[窗口](../../packages/workflow/src/acquisition-v2/repetition-stop.ts#L19)要求精确重复／交替 | 结果字段变化可能绕过，且要先浪费若干轮才止损；不是幂等控制 |
| 系统性阻断判断过窄 | [hasSystemicTransferBlock](../../packages/workflow/src/acquisition-v2/agent-loop-guards.ts#L102)只在整个历史没有落地时停 | 已有部分文件不代表后续不会耗尽配额或失去授权；应停止新增转存而保留整理能力 |
| 结束原因丢失 | [电影状态映射](../../packages/workflow/src/execution/movie-workflow-v2.ts#L230)、[剧集状态映射](../../packages/workflow/src/acquisition-v2/workflow-v2-bridge.ts#L246)主要看覆盖 | 预算、循环保护、等待落地、无匹配候选可能都表现为 no_coverage |

### 4.2 工具、指南和执行事实存在冲突

1. `transferCandidate` 已返回真实 staging 列表，[工具声明](../../packages/workflow/src/acquisition-v2/agent-loop.ts#L192)与 [sandbox 返回](../../packages/workflow/src/acquisition-v2/sandbox.ts#L1075)一致；[电影流程](../../packages/workflow/src/acquisition-v2/skill.ts#L67)却固定要求再 inspect。需要保留“新证据核验”，而不是每次机械多扫一遍。
2. [protocol](../../packages/workflow/src/acquisition-v2/skill.ts#L25)要求列举 ALL candidates/files；[search 指南](../../packages/workflow/src/acquisition-v2/skill.ts#L176)又允许找到可覆盖候选就不必通读。重复转述全部候选会增加上下文，且不等于覆盖审计。
3. [search 指南](../../packages/workflow/src/acquisition-v2/skill.ts#L185)要求健康空结果同词重搜 2–3 次；[sandbox 健康快照缓存](../../packages/workflow/src/acquisition-v2/sandbox.ts#L782)通常直接返回旧快照，不产生期望中的真实刷新。
4. [关键词说明](../../packages/workflow/src/acquisition-v2/skill.ts#L168)绝对禁止年份，[同章后文](../../packages/workflow/src/acquisition-v2/skill.ts#L192)和 movie 又允许最后阶段用年份消歧。应把搜索召回策略和身份判定证据分开，去掉相互冲突的绝对语句。
5. [电影身份规则](../../packages/workflow/src/acquisition-v2/skill.ts#L64)拒绝合集和原盘，并声称“Magnets and 115 shares both transfer instantly”。“可能秒传”不能表述成外部服务总是秒传。本次选源还提示书面限制需要变成准入门禁；线上是否使用同一版指南尚未确认。
6. [markObtained](../../packages/workflow/src/acquisition-v2/agent-loop.ts#L234)仍允许模型只提交 episode codes，不绑定通用 verified file evidence；本地新增 policy validator 有帮助，但不等于完整证据提交合同。
7. [finish 描述](../../packages/workflow/src/acquisition-v2/agent-loop.ts#L243)称成功即结束，实际 [finish stop](../../packages/workflow/src/acquisition-v2/agent-loop-guards.ts#L189)要求 `coverageMet === true`。部分成功／等待／受阻需要明确终态，不应让模型反复 finish。
8. [去重指南](../../packages/workflow/src/acquisition-v2/skill.ts#L43)把“大文件＝高码率＝更好”以及“Size is the ONLY criterion”写成规则。不同编码、片长、音轨和作品不能这样比较；改变现有保留规则需单独确认，不能以“效率优化”名义静默改为另一套质量排序。

### 4.3 状态机与库存证据尚未闭环

- [RunStateMachine](../../packages/workflow/src/acquisition-v2/run-state-machine.ts#L98)已使用 XState，不是“项目没有状态机”。它有 create/from/send/can/toJSON 和补偿登记，但当前封装保存的是自定义 state/context，不等同于已部署的持久 actor 执行引擎。
- [workflow-v2](../../packages/workflow/src/acquisition-v2/workflow-v2.ts#L296)在 Agent 完整执行后集中发送 TRANSFER_STARTED、LANDED、INSPECTED、ORGANIZED、DEDUPED、PURGED。这是事后标记，不是每个副作用前后的实际门禁，状态机 completed 本身不能证明入库。
- 当前主链没有把 `RunStateMachine.from` 与可靠恢复、租约和副作用日志完整接通。仅将状态快照写入 SQLite，不能保证恢复后不会再次提交离线任务。
- [库存合并](../../packages/workflow/src/acquisition-v2/workflow-v2.ts#L275)以历史 obtained 与 Agent coverage 的并集为主。未提交的 [verified-inventory](../../packages/workflow/src/acquisition-v2/verified-inventory.ts)、[inventory-checkpoint](../../packages/workflow/src/execution/inventory-checkpoint.ts)已补部分 TV 扫描与失败保留，不应重写覆盖；仍需统一电影与 TV 的证据提交，解决历史已删除文件造成的陈旧标记。
- [listTree](../../packages/workflow/src/storage/storage-115-executor.ts#L1053)默认深度 6，逐目录访问，未携带遍历完整性。被截断的扫描不能用来证明“该作品没有文件”，更不能据此清除全部库存或清理目录。

## 5. 已有基础设施与复用边界

调查核对了 workspace manifests、npm 锁文件及本地安装。版本是当前工作区证据，不是外部最新版推荐。

| 已有能力 | 位置／版本 | 可复用部分 | 不可假设已具备 |
| --- | --- | --- | --- |
| AI SDK | [根 manifest](../../package.json#L83)，本地 ai 6.0.201；openai-compatible 2.0.48 | generateText、stopWhen、prepareStep、activeTools、onStepFinish、telemetry 接口 | 新版在线示例的 API 名称必然适用于本地版本；LLM request retry 天然副作用安全 |
| XState | [workflow manifest](../../packages/workflow/package.json#L36)，5.33.3 | 显式状态、guard、事件、层级结构 | 自动持久执行、跨 worker 防重、云端 exactly-once |
| SQLite／查询层 | better-sqlite3 12.11.1、Kysely 0.29.7 | 本地事务、唯一约束、CAS 认领、迁移、业务和操作证据原子写入 | SQLite 事务能与网盘提交构成一个原子事务 |
| 生产任务消费 | workflow_runs 的认领、FIFO、nextAttemptAt、重试与启动恢复 | 延续现有任务来源与调度入口 | owner/heartbeat/fencing 多活安全已完备 |
| 独立 SqliteJobQueue | [sqlite-queue](../../packages/workflow/src/persistence/sqlite-queue.ts)、[manual-import-command](../../packages/workflow/src/execution/manual-import-command.ts#L14) | 数据结构与队列测试可参考 | 它已接入当前生产获取队列；不能直接替换而不迁移 |
| 存储适配器 | StorageExecutor → RealStorageV2；多盘 executor | 收口统一输出、保持品牌错误和能力差异 | 另一个 IStorageDriver 上的任务声明已经接入本采集链 |
| 限流与并发 | [rate-limiter](../../packages/shared/src/rate-limiter.ts)、[keyed-pool](../../packages/workflow/src/storage/keyed-pool.ts)、115 guard | 漏桶／令牌桶、按 key 并发、预算、熔断 | 进程内状态天然跨 worker 共享；guard 计数等于全量 HTTP |
| 候选与历史 | CandidateRegistry、link history、dead links、rejected source | 规范资源身份、来源记录、失效 TTL、账号／盘／作品隔离 | 内存 Registry 是持久锁；软死链是永久不可用证明 |
| 解析与验证 | anitomy 0.0.35、parse-torrent-title 3.0.1、Zod 4.4.3、扩展名修复、策略过滤 | 先规则提取特征，LLM只裁决歧义 | 文件名解析结果永远准确；扩展名补全证明视频可播放 |
| 库存与审计 | episode_states、episode_sources、library_episodes、scan snapshots、transfer_attempts、agent_steps | 复用实体 ID 与扫描证据，避免再造平行库存 | 最新来源 upsert 是不可变来源账本；已有完整 outbox／投递状态 |

生产队列已有失败重试及启动孤儿恢复；这适合进一步增加租约和对账，不适合直接增加更多重试次数。先防止未知远端结果重放，再讨论提高恢复积极性。

没有发现直接声明的 BullMQ、p-queue、Bottleneck 或完整 OpenTelemetry exporter。`p-limit` 和 `@opentelemetry/api` 的传递依赖不应被当作项目稳定公共依赖。

仓库同时有 npm 和 pnpm 锁文件，内容并不一致；当前 Docker／CI 使用 `npm ci`，本文以 npm 实际解析为准。本次不改锁文件或依赖。

## 6. 业界方案能借鉴什么

### 6.1 媒体自动化系统

| 系统 | 可借鉴模式 | 与本项目的差异／限制 |
| --- | --- | --- |
| Sonarr／Radarr [S1][S2] | 索引检索、下载器状态、下载完成、导入核验分阶段；质量档案、custom formats、最低分与升级 cutoff；导入失败保留明确原因 | 搜到／下载器接受不等于已导入；自动失败重试受协议和下载器支持限制，不能概括成所有场景自动修复 |
| Prowlarr [S3] | 索引器配置、健康与同步独立于业务获取 | 不是影片质量裁决器或导入器；它的下载客户端配置不等于自动同步到所有 arr 应用 |
| MoviePilot [S4] | 初次存量搜索、增量订阅、缺集补漏、洗版策略分别建模 | 插件和网盘能力分版本、来源；目录监控本身可能消耗 API 和触发风控，不能把全盘轮询当免费能力 |

共同点不是“LLM 越自主越好”，而是**选择、下载、验证、导入、历史记录各有边界**。保留人工处理歧义和失败状态，比假成功或无限重试可靠。

### 6.2 工作流与控制库比较

| 候选 | Node／持久化及部署 | 价值 | 本项目建议 |
| --- | --- | --- | --- |
| 现有 AI SDK + XState + SQLite [S5][S6] | 已安装；快照与操作日志自行持久化；无新增基础服务 | 最小迁移成本，能保留现有 providers 和 sandbox | **首选**；必须补账本、租约、恢复和真实事件边界 |
| LangGraph JS [S7][S8] | `@langchain/langgraph`；JS `@langchain/langgraph-checkpoint-sqlite` 确实存在并使用 better-sqlite3；SQLite saver主要面向本地／实验，生产还需评估其他后端 | 图式 Agent、checkpoint、人机中断、多节点恢复 | 不因“需要状态机”就换；已有 AI SDK/XState，迁移工具、消息、恢复语义成本较大 |
| Temporal [S9][S10][S11] | TypeScript SDK + Temporal Service + Worker；生产需服务持久后端或 Cloud，开发 SQLite 不能外推为生产部署方案 | 长任务、定时器、可靠重试、跨服务编排 | 当持久后台任务量、跨服务复杂度或可用性要求足以承担运维成本时再评估 |
| BullMQ [S12][S13] | Node + Redis；不能用当前 SQLite 原位替代 Redis | delayed jobs、backoff、stalled job 恢复、队列并发 | 解决调度，不替代业务 FSM、入库证据或网盘幂等；当前单机不优先 |
| p-limit [S14] | 进程内并发限制 | 限制 Promise 同时执行量 | 不等于限速；项目已有 keyed pool，不为同一问题重复引入 |
| p-queue [S15] | ESM、进程内队列、优先级与窗口配额 | 轻量本地调度 | 可在现有池确实缺所需能力时对比；不提供 durable workflow |
| Bottleneck [S16] | minTime、reservoir；跨进程限流需 Redis 等额外设施 | 细粒度限速与配额 | 现有漏桶优先；其分布式限流不等于持久保存所有待执行 job |

许可证应按包和锁定版本核对，不能统称 MIT：本地 `ai@6.0.201` 的 [npm锁记录](../../package-lock.json#L2838)为 Apache-2.0；XState与表中新引擎／轻量队列候选的核心包许可见对应维护者仓库。核心包许可不代表托管服务、关联插件或所有后端都免费或同许可证。本文不建议变更依赖，也不把任何框架称为外部网盘 exactly-once 保证。

XState 官方持久化说明指出，恢复时已执行 actions 不重新执行，而 invocations 会重新开始。[S5] LangGraph 的 checkpoint 也不是每一条语句的事务。[S8] Temporal/BullMQ 的重试同样要求 activity/job 幂等。[S11][S13] 因此，换框架不能消除“请求成功但响应丢失”的重复转存窗口。

## 7. 三种可行方案与推荐

| 方案 | 范围 | 优点 | 代价／剩余缺口 |
| --- | --- | --- | --- |
| A：局部止损 | 计数文案、结束原因、同 run 同源门禁、统一指引、合并冗余读取 | 改动集中，可先稳定当前快速模式 | LLM仍承担多步I/O编排，跨进程恢复能力有限 |
| B：证据驱动编排 | 在 A 上接通现有 FSM、持久操作账本、观察缓存、验证提交；LLM只提供语义计划 | 同时改善成本、准确性、可恢复性；复用当前底座 | 需要明确状态合同、数据库迁移和故障注入测试 |
| C：替换／引入重型引擎 | LangGraph 或 Temporal／BullMQ，对应图执行或分布式任务需求 | 可获得更完整平台能力 | 迁移、基础设施和重复抽象成本高，不能直接修复媒体身份和外部网盘语义 |

**推荐 A → B，暂不选择 C。**A 必须保留通向 B 的 typed outcome 和审计字段，不能只是把 maxSteps 从 60 改小，或把工具合并成无边界万能入口。

## 8. 推荐设计：模式各司其职

### 8.1 适配器：只翻译供应商语义，不掩盖异步状态

在现有 StorageExecutor → RealStorageV2 边界演进，不另造一条并行采集链。以下是**拟议**结果类型，非当前接口：

| outcome | 含义 | 允许的后续动作 |
| --- | --- | --- |
| `accepted_pending` | 已确认接收，但尚未取得落地证据；包括服务完成但索引仍滞后 | 有界轮询／持久调度；不得当成功或永久死链 |
| `landed` | 观察到与操作关联的新文件，仍未通过内容及归位验证 | inspect／validate／organize；禁止仅凭 status标记获得 |
| `instant_miss` | 快速模式在界限内未命中，且远端无继续处理任务或已确认安全取消 | 本 run该源不重提；可评估不同候选 |
| `rejected` | 明确且可分类的资源拒绝，如分享撤销 | 按错误原因登记失效或选择不同候选 |
| `transient_error` | 可重试读取错误，或可以证明副作用尚未发出的暂时失败 | 在独立预算内退避重试 |
| `account_blocked` | 配额、授权等账户级阻断 | 禁止新转存；仍允许安全整理已落地文件 |
| `unknown` | 副作用可能已提交，响应丢失／取消不明／无法完成对账 | 先 reconcile；不盲目重提、换源或破坏性清理 |

共同字段建议包含 `operationId`、provider task reference（如可得）、`canonicalResourceKey`、`observationId`、文件 ID、结构化 reason、可重试范围和供应商脱敏摘要。`landed` 必须关联本操作／本作品，不接受“目录里任意有一个视频”。

按 provider 声明任务查询、取消、分页、选择性接收、服务端重命名等 capability；不支持查询就返回能力缺口和保守状态，不能伪造统一可靠任务管理能力。不要以分享／磁力粗分类代替实际异步语义：大分享服务端复制也可能 pending。

### 8.2 策略模式：决策政策与 I/O 分离

优先用纯函数与有限配置，不建立过度泛化的插件注册体系。

- `SearchPolicy`：中文裸标题预热、允许的别名、缓存有效性、provider故障重试；年份是否用于查询由明确策略控制，年份作为身份依据不受此限制。
- `CandidatePolicy`：作品身份、媒体类型、电影合集／原盘准入、订阅范围、质量和字幕硬软偏好；先硬约束再排序，不把所有约束加权成可相互抵消的总分。
- `TransferPolicy`：当前 `instant_only` 和未来可选 `durable_download`；超时、取消、重试与换源条件必须分开。
- `ImportPolicy`：已验证文件到作品／季／集映射，重命名、同盘归位、重复与替换条件。

策略不得执行删除或修改云端状态；它输出计划，执行器在写范围、版本和证据门禁下执行。模板方法不适合强行统一各盘不同的任务生命周期，适配器加显式 capability 更清楚。

### 8.3 状态机：接在真实副作用边界

以下为提议的执行结构，不是对现有状态名的描述：

```text
queued → claimed → provisioned → observed → planned
  → transfer_intent → submitted
      → pending → reconcile → landed
      → instant_miss／rejected → evaluate_next
      → unknown → reconcile／await_review
      → account_blocked → finalize_available
  → validating → organizing → verifying_target → committing
  → evaluate_remaining → planned 或 finalizing
  → succeeded／partial／no_match／not_materialized／blocked／cancelled
```

- 为多候选和多季保留显式循环，不能只把现有线性状态从开头到尾补发一次。
- `LANDED` 只由文件证据产生，`ORGANIZED` 只由归位结果产生，`COMMITTED` 只在库存事务提交后产生。
- pending 是可恢复业务状态；未知远端结果必须先对账。过期不等于安全取消，取消失败不等于可重提。
- 保留资源短缺、入库失败、基础设施阻断、主动取消和部分成功的差异。流程执行完不代表业务全覆盖。
- 非法迁移需要可诊断拒绝，不继续默默吞掉关键错误事件。
- 状态快照需要 schema／machine version；升级时明确迁移、重建或人工处理策略，不能无验证恢复不兼容快照。

### 8.4 操作账本、租约与幂等

这部分需要持久化设计，不能承诺“零新表”。可复用 workflow_runs 和现有 attempts 主键体系，另加操作级记录／事件；具体迁移需在实施阶段评审。

拟议持久字段：

- 运行：`runId`、独立 `attemptId`、owner、leaseUntil、heartbeat、fencingToken、nextActionAt、stateVersion、stopReason。
- 操作：`operationId`、业务幂等键、kind、requestDigest、intent/submitted/observed/verified/committed/unknown、remoteTaskRef、reconciliationDeadline、结果摘要。
- 证据：observationId、存储与目录 scope、fileId、identity映射、来源、扫描完整性、读取时间、写后版本、验证级别。

必须分开两类键：计划身份包含账户、连接盘、作品、需求修订和资源身份，用于判断计划是否过期；**未决副作用防重键**包含账户、连接盘、物理目标、操作种类和规范资源身份，不能因 runId 或需求修订变化而失效。仅用易变 candidateId 不足。对同一目标中的相同未决操作，新run／新需求先复用证据并对账；作品和季集映射仍按各自计划验证，不能因此错误合并库存。

执行顺序：

1. SQLite事务认领带租约的任务，以唯一约束和条件更新保留 operation intent；跨run、跨需求修订检查同一未决副作用防重键，已有操作则复用并对账。
2. 事务外发出网盘请求，立即记录远端引用或结果；超时且不能证明未发送则写 unknown。
3. 新 worker恢复时先校验租约与 fencing，再查询远端任务／受限目标目录，不从头重放整个 Agent 副作用序列。
4. 验证、归位和目标复核后，在同一 SQLite事务中更新库存证据、来源和业务结果；通知投递若要求可恢复，应使用 outbox／投递状态。
5. 通知发送失败仅重试投递，不重新采集。

fencing可以阻止旧 worker继续写本地数据库，但网盘通常不识别 token；必须在本地写操作入口检查租约、串行化同 scope并对账，仍不能保证远端 exactly-once。唯一约束也只能避免已知的重复意图，不能消灭网络不确定性。

补偿采用有证据的 Saga 思路，而非“失败就删整个目录”：只能取消本操作拥有的任务、处理本 run可归属的残留；已入库文件不是通用回滚垃圾，未知归属和未确认取消的目录不得盲删。

## 9. 工具合同与调用指引

### 9.1 先用代码减少决策面，再改提示词

- 利用本地 AI SDK已支持的 `prepareStep.activeTools`，按状态只开放需要的工具；当前 [prepareStep](../../packages/workflow/src/acquisition-v2/agent-loop.ts#L410)主要注入预算和收尾提醒，尚非通用状态门控。
- 搜索／评估期开放观察与计划；pending只开放状态观察和允许的取消；整理期禁新转存；系统阻断时仍保留已落地文件的整理与提交能力。
- 同一 scope的副作用串行化；仅独立只读查询可受限并发。不要简单把全局所有工具串行，也不要允许 move、delete、transfer在同一目录竞争。
- activeTools只减少模型误用，sandbox执行边界仍必须再次校验状态、租约、scope和证据，防止过期计划或并行工具越权。
- 初始上下文一次给出作品身份、硬软偏好、缺集、缓存快照摘要及当前可执行动作；品牌指南按需读，重复读不会增加事实证据。
- [内容过滤后的 recovery tool set](../../packages/workflow/src/acquisition-v2/agent-loop.ts#L503)已经有收窄工具的先例，可借鉴而不是重建工具系统。

### 9.2 工具粒度提案

以下新名字只是接口设计候选，**不得提前写入生产提示词让模型调用**。

| 职责 | 当前基础 | 提议调整 |
| --- | --- | --- |
| 读取证据 | viewResourceSnapshot、inspectStaging、inspectTargetDir | 统一返回 observationId、完整性、是否缓存；按目录去重，不重复读取电影同一 staging/target |
| 语义选源 | 模型自由调用transferCandidate | 提交 typed plan：候选集合、身份依据、目标映射、硬约束结果；计划不直接执行云端写入 |
| 执行已审查计划 | transferCandidate、transferUntilLanded | 由编排器执行 submit／reconcile；失败结果不可压平；批处理只在候选已审批且错误可安全分类时推进 |
| 确认入库 | markObtained(codes) | 提议 `commitVerifiedCoverage`，绑定file evidence、目标目录和mapping；空声明无法成功 |
| 结束 | finish、reportNoCoverage | 提议 `finalizeRun(outcome, evidenceRefs)`，接收合法partial、pending交接和blocked结果；拒绝无证据成功 |

高层工具应覆盖一个有明确后置条件的任务，而不是把所有源搜索、自动选片、转存、删除塞进一个不透明调用。[S17] 批量归位／字幕处理已有基础，应优先使用，不让模型每个文件调用一次。

### 9.3 观察缓存不能制造“假新鲜”

观察至少携带 `observedAt`、`directoryRevision`、分页／深度完整性、文件 ID及相关元数据。写入后按触及目录失效；同一次写后的只读工具共享正在执行的 listing，避免并发重复扫描。

没有写入且读取版本不变，可以复用 `transferCandidate` 返回的树；pending、服务端异步变化或达到策略指定复查时间时，仍需重新观察。**本地未写不等于云端未变**，TTL／provider信号与最终提交前复核不能省略。

健康空搜索使用缓存；只有源错误、缓存过期或明确刷新策略才重新请求。刷新节流由系统保证，不再要求模型用同词重复调用碰运气。未完整读取的候选分页不能支持“所有候选都无匹配”的结论。

### 9.4 指引诊断与保守改写

#### 1. 评分卡

**综合评分（加权）：6.1/10。核心问题：角色与目标清楚，但指南之间、指南与真实工具结果之间存在冲突。**此分数是文本审查判断，不是入库成功率或模型能力实测。

| 维度 | 权重 | 评分 | 原句／问题 | 优先级 |
| --- | ---: | ---: | --- | --- |
| 角色定位 | 1.2 | 8 | “You drive your own observe → act → verify loop”明确角色，但自主边界需由代码限制 | — |
| 任务目标 | 1.0 | 8 | “the SMALLEST set of candidates that covers the whole need”目标明确 | — |
| 约束条件 | 1.0 | 5 | “Magnets and 115 shares both transfer instantly”不成立；合集限制仅文字化 | P1 |
| 输出格式 | 1.0 | 6 | “ALL of them”要求重复长篇枚举，缺少稳定结构和终止证据 | P1 |
| 指令清晰 | 1.5 | 4 | “re-run the SAME keyword 2-3 times”与健康缓存冲突，重复检查与返回证据重叠 | P0 |

#### 2. 场景判定

- 应用场景：有副作用的多源媒体获取与归位。
- 目标受众：运行在当前 sandbox中的电影／剧集采集 Agent；不是直接操作网盘API的通用助手。

#### 3. 优化建议

- [P0] 原“同词重搜2–3次”改为“健康缓存空结果不重复调用；源错误按返回健康信息区分，不把同词命中缓存当新搜索证据”。
- [P1] 原“转存后必inspect”改为“先读取转存返回的完整文件证据；只在结果缺失、过期、异步未决或后续写入后复查”。
- [P1] 原“both transfer instantly”改为“接收任务不代表落地；以实际文件证据判定，不因空结果反复重提同一候选”。
- [P1] 原“列出所有候选全文”改为“记录选择和拒绝的结构化理由；原始列表保留在证据存储，模型仅引用有关条目”。该调整需要同时保留全候选可访问性，不应偷偷截断召回。

#### 4. 方案对比与最终版本

**方案A（保守修复）**：保留当前工具、电影单正片要求和快速转存模式，修正相互冲突的指令。

**方案B（深度重构）**：采用“角色—任务—证据—约束—输出”的结构，模型只提交计划，编排器执行、验证和提交；依赖第8节新合同，当前不能直接使用。

**本阶段采用方案A作为待审稿**；架构目标采用第7节方案B，两种“A/B”分别指提示词改写和系统方案，实施时应使用明确名称区分。

**最终优化版本（保守指引草案，不是已修改的生产文本）**：

```text
Role: Select resources for the requested title and missing items using only the supplied sandbox tools and observed evidence.

1. Read the required protocol and media playbook once. Read a brand or specialist section when its situation occurs; re-reading unchanged text is not new evidence.
2. Use the supplied resource snapshot first. Search supported title aliases only when the observed candidates cannot meet the request. Do not repeat a keyword merely because its healthy cached snapshot is empty. Distinguish provider errors from healthy empty results.
3. Before transferring, state the candidate ID, target identity, matching evidence, and any unresolved conflict. Apply the configured hard requirements. Under the current movie policy, reject multi-film collections and full-disc dumps; do not transfer them to discover their contents.
4. transferUntilLanded accepts movie share candidates only, never magnets. Rank and include only candidates already judged to be the requested film. Use transferCandidate for a permitted individual magnet.
5. Read the files returned by the transfer tool before requesting another inspection. Inspect again when the returned evidence is absent, no longer current, or an asynchronous result requires another observation. For a movie, staging and target refer to the same landing directory; do not inspect both for the same observation.
6. Accepted does not mean landed. After an empty noTargetChange result, do not resubmit the same candidate, or another candidate explicitly identified by the tools as the same link, during this run. A batch result may omit this flag: when an empty single or batch result does not prove terminal rejection or safe cancellation, treat the operation as unresolved. Use available read-only evidence before any further transfer. If the available tools cannot resolve it, state the uncertainty and stop requesting writes. A transient or unknown response is not proof of a dead resource.
7. Before moving, deleting, or marking coverage, identify the target work and the actual files from observed evidence. Follow the existing storage scope and cleanup guards. Do not mark a film or episode merely because a transfer was accepted.
8. Mark obtained only after the correct files are confirmed in their final target and required organization is complete. Call finish once coverage is met. When healthy search evidence has been exhausted, use reportNoCoverage with the actual reason, including candidates that did not materialize. Never describe a provider or account failure as proof that no resource exists.
9. For each decision, record concise evidence references, the chosen action, and the reason. Do not repeat full candidate lists already retained by the system, and do not invent tool results or new tool names.
```

**改动说明**：该稿修正缓存、重复inspect、链接类型与无落地重提指令，不新增异步下载能力，也不改变现有质量／字幕偏好。当前批量工具的 [attempts投影](../../packages/workflow/src/acquisition-v2/sandbox.ts#L1168)没有保留noTargetChange，虽然内部会据此停止；因此草案同时覆盖无法证明终结的空批量结果，不能依赖缺失标志。它仍不能补全blocked／pending终态；结构化outcome与准确结束映射需要代码支持。上线前必须与所有章节同步消除冲突，并通过固定场景评测，不能只替换其中一段。

## 10. 提高入库准确度：成功必须有证据链

推荐证据链为：

```text
作品与需求身份
→ 合规候选／规范资源身份
→ 本操作实际落地文件
→ 正片／季集／质量与字幕策略核验
→ 归位结果与目标复核
→ 库存与来源事务提交
→ 用户结果通知
```

1. **片名与年份**：以TMDB identity、别名、年份和媒体类型交叉判定；文件名解析是特征，不是永不出错的 ground truth。本例1974续作和漫画不能当1973正片。
2. **合集与原盘**：当前电影政策应先机械拒绝明显合集／原盘。以后若批准合集支持，必须先得到可枚举文件清单、逐片映射和选择性导入能力；不能简单flatten全部视频再宣告获得。
3. **季集映射**：常规命名先规则解析；绝对集号、特别篇、跨季包交给LLM提出映射并留理由。模糊结果不得覆盖已验证库存。
4. **文件验证分级**：先文件ID、目录、大小、扩展名及名称特征；再按风险做容器头、媒体流和片长检查。需要读取真实内容时走现有鉴权和限流，不默认下载整片。大小阈值和片长不能单独证明身份。
5. **无扩展名**：复用现有落盘补扩展名与组织阶段嗅探；“改名成功”不等于容器完整、可播放或属于正确作品。
6. **质量去重**：硬要求先于排序；只有确定同作品、同集且版本可比，才谈替换。当前“大者优先”不应扩张成跨编码／跨片长真理。若修改规则，先输出对比计划和保留原因，验收前不删除旧副本。
7. **库存证据**：通用commit应要求file→title/episode映射和最终位置。历史obtained只是待复核事实；完整扫描与不完整扫描必须区别处理，不能遇到网络错误就清空库存。
8. **清理安全**：只处理本run可归属、已判定的残留，保护已归位文件、move失败文件和仍pending内容。不确定内容先保留并显式通知；不自动创建或执行新的隔离删除策略。
9. **字幕软失败**：若当前配置允许软兜底，正片成功与字幕未确认分别报告；字幕重试不应触发重新获取整部电影。

## 11. 性能与可观测性方案

### 11.1 必须分开的计量

| 指标 | 精确定义／采集位置 |
| --- | --- |
| model request | 实际模型请求，含SDK/网关重试；记录模型、token、耗时和finishReason |
| model step | SDK一次步骤，可包含多个工具调用；不能由工具条数反推 |
| tool call | 独立callId、attemptId、开始／结束、状态、结构化错误 |
| logical provider operation | guard包装调用计数，用于业务预算 |
| provider HTTP request | transport层真实请求，含分页、retry；不记录带凭据的URL或header |
| side-effect submission | 每次真正提交离线／分享接收／移动／删除；区分重用、拒绝和实际发送 |
| observation | 缓存命中、分页、遍历深度、完整性、版本与访问成本 |
| business progress | 新验证文件数、新覆盖数、已解决候选数；不是“又调用了一个工具” |

通过callId/parentId和异步上下文关联成本，不再依靠相邻累计数字相减估算并发工具。UI可显示“工具开始记录22条／模型步骤待采集／guard操作累计73次（末次工具开始前；最终总量未知）”；guard操作不能冒充真实HTTP次数，完整埋点后再分别显示最终总数。

补充 `loopStopReason`：coverage_met、candidate_exhausted、repetition_guard、step_limit、io_budget、time_budget、provider_block、pending_handoff、cancelled、model_error。SDK finishReason 与业务停止原因分别保存；不能用空模型文本猜测终止。

trace可best-effort，但幂等账本和库存证据不是可丢观测日志。敏感字段应在持久化边界使用白名单／脱敏，UI继续防御性脱敏；不保存Cookie、完整分享链接或签名直链，也不要求模型内部思维链作为审计证据。

### 11.2 减少成本的顺序

1. 先阻止无新证据的重复提交和不合法候选；“不做错事”比更快执行错误动作收益更大。
2. 合并同目录观察；保留落地、写后和提交前必须的验证。
3. 缩减LLM返回上下文：结构化摘要、分页／按需展开、保留候选可达性及过滤统计；不是盲目top-N。
4. 把固定轮询、退避与超时交给执行器／调度器，等待期间不反复唤醒模型。
5. 复用批量归位和字幕操作；跨目录只读受限并发，同盘受限副作用串行。
6. 按provider＋账户／连接scope设置速率、在途任务、调用和剩余清理预算；包括补扩展名的rename路径，避免计量盲区。
7. 将模型/SDK重试与业务重试区分。SDK请求重试、generateText整轮恢复和worker重试叠加时，必须复用操作记录，不能重新提交已未知或已成功的副作用。

默认预算不应直接照注释配置：当前工厂hard 300，harness reserve 5，Agent可见hard wall为295，软提醒按减60推导时为235；常量默认240不代表所有运行实际阈值。[guard默认](../../packages/workflow/src/storage/storage-115-executor.ts#L1453)、[loop guards](../../packages/workflow/src/acquisition-v2/agent-loop-guards.ts)。应在每次运行开始时保存实际生效配置，而非扩大预算掩盖空转。

### 11.3 验收指标，而非未经测量的提速承诺

- 仅在执行器防重层回放本次同源5次提交，目标为没有新证据时至多1次真实提交，消除后4次冗余提交及相关检查；若连同当前电影准入规则端到端回放，本例合集／原盘应在提交前被拒绝，目标为0次。两者都不保证资源最终能入库，也不承诺耗时按比例减少。
- 同一未变且可复用的观察版本，重复逻辑读不应产生重复provider遍历；异步到期复查和最终验证单独计数。
- 每条真实提交都有持久operation intent；每个已结束attempt有明确stopReason；成功库存都有验证文件证据。
- 指标看p50/p95模型请求数、token、网盘请求、任务提交、端到端耗时；同时看有效入库率、错片／错集率、重复提交率、误删数和unknown恢复率。
- 成功率分母需区分“有合规且可获取候选”“只有无法秒传候选”“无匹配候选”，避免把外部资源缺失算成编排退化，或反过来隐藏编排失败。
- 新设计先以固定夹具、模拟器、回放对比；涉及真实网盘时单独授权、隔离目录、明确配额上限。未完成对照实验前不给“减少80%调用”之类结论。

## 12. 分阶段实施与验证

各阶段原为提案；2026-11-14 用户授权后 P0／P1／P2 与第11节可观测性已实施（见第13节），P3 长期离线下载／电影合集导入／新质量规则仍另行决策。本文不授权生产变更或新增下载行为。

### P0：当前模式止损

- 准确命名UI计数；新增工具结束／attempt身份／停止原因，保留前次重试记录。
- 将“有候选未落地”“未知结果”“资源拒绝”“真正无匹配”“账户阻断”区分输出。
- 同run规范链接的重复调用门禁；unknown／pending先对账，不作为可重试failed释放。
- 统一指南，机械拒绝当前不允许的电影合集／原盘；合并电影同目录检查。
- 覆盖rename等绕过guard的路径，验证计数和限流口径。

验收：本次脱敏回放不再发出5次同源提交，不误称已入库，不将accepted表述为下载完成；错误通知与持久原因一致。

### P1：可靠编排

- 复用XState，替换事后补发事件；按真实I/O边界迁移。
- 操作账本、独立attempt、租约与对账恢复；保持原workflow_runs调度入口。即使仍采用快速模式，也持久保留pending／unknown，执行有界安全对账及本操作取消确认；这不等于授权继续等待长期下载。
- 状态门控工具、规范资源身份、防重范围、持久最终结果与通知投递边界。
- 为数据库和machine snapshot设计迁移与回退，不销毁既有用户库存或运行历史。

验收：提交后响应丢失、落地后进程退出、库存提交后通知失败均能恢复，不重复获取、不假成功；双worker不能同时消费相同未决意图。

### P2：准确度与批处理

- 协调复用当前未提交的TV库存检查点和policy validator，补电影共同验证合同。
- typed候选计划、证据绑定commit、完整性明确的观察缓存、字幕与归位批量处理。
- 固定数据集评价同名、续作、跨季、无扩展名与不完整扫描。

验收：错片／错集、误删零容忍；清晰说明无法确认的资源，不用LLM声明绕过物理证据。

### P3：可选后台离线下载

P1已经保存pending／unknown并处理安全恢复；P3额外改变的是业务政策：只有在用户确认不再限于秒传时，才允许任务持续普通离线下载，并增加长期查询调度、等待上限和在途数量／配额策略。取消所有权和不确定结果对账不是P3才加入的可选安全项。等待期间释放LLM与worker执行槽，不能用一个超长sleep占用整条采集任务。

是否再采用Temporal／BullMQ，应由长期任务规模、多进程部署和运维预算决定；不是P0/P1的前置依赖。电影合集支持和质量规则调整另行决策。

### 测试矩阵

| 场景 | 必须验证 |
| --- | --- |
| 本次合集／原盘候选原样端到端回放 | 按当前电影准入规则零次真实提交，记录不合规原因而非伪称下载失败 |
| 合规单片磁力短窗无落地（独立夹具） | 至多一次真实提交、明确not_materialized或unknown，无重复提交和假库存 |
| 分享复制pending／完成后目录延迟 | 不直接登记永久死链，不立即烧下一个候选；完成索引滞后不误取消 |
| 请求成功响应丢失 | unknown→对账，不能作为普通网络失败重新提交 |
| 任务已存在／取消失败 | 不取消不属于当前操作的任务；取消未确认不等于任务消失 |
| failed但文件已落地 | 优先验证真实文件，不能因状态字符串丢弃有效落地 |
| 恢复／双worker／租约过期 | 阻止过期worker提交库存与继续执行新副作用；远端不确定结果可追踪 |
| 同源不同candidateId／跨run | canonical key防绕过；账户、网盘、作品、需求revision隔离正确 |
| 无扩展名／深层目录／分页失败 | 修复名称不冒充完整媒体验证；不完整扫描不等于空目录 |
| 1973＋1974合集／漫画／同名作品 | 当前策略拒绝不合规候选；未来若允许合集必须逐文件正确映射 |
| 归位一部分失败／去重／替换 | 只提交已验证成功部分，保护旧文件和未移动文件 |
| 字幕失败／预算耗尽／授权过期 | 保留正片与partial结果，停止新转存但允许安全整理 |
| UI计数／并行工具／模型重试 | 各类次数分别准确，不把累计值相加，不将工具数当模型数 |
| 源故障／健康空缓存 | 故障不能报告无资源；重复缓存读取不被算作新搜索 |
| 库存事务失败／通知失败 | 云端已落地可恢复提交；通知重试不重启采集 |
| 用户取消／清理 | 只取消拥有的任务；不删除已有库、未知内容、未确认pending内容 |

## 13. 实施进展、验证与未完成事项

### 13.1 只读调查（保留）

只读线上调查已确认第3节的运行记录、5条转存结果、库存未获得以及目标目录为空。生产日志没有足够的工具结果和停止原因，因此保留推断边界，没有进行额外转存试验来“验证”外部资源。

### 13.2 实施进展（2026-11-14 用户授权后）

用户授权“按方案及其各项功能点推进执行（由于没有正式发布，不用考虑历史数据兼容性）”。P0／P1／P2 与第11节可观测性已落地；**P3 长期离线下载、电影合集导入、新质量规则仍按第12节另行决策，未实施**。 obsolete 测试按新契约更新，未加兼容垫片。

| 方案功能点 | 实现位置 | 证明测试 |
| --- | --- | --- |
| P0 同 run 规范链接防重门禁（物理目标＋规范资源身份键） | [real-storage-adapter.ts](../../packages/workflow/src/acquisition-v2/real-storage-adapter.ts) | v2-sandbox-same-link、v2-orchestrator-same-link |
| P0 电影合集／原盘机械拒绝 | [movie-admission.ts](../../packages/workflow/src/acquisition-v2/movie-admission.ts) | v2-sandbox-safety |
| P0 unknown／pending 先对账，不当可重试 failed 释放 | real-storage-adapter.ts、orchestrator.ts | repository-contract（恢复／对账） |
| P0 rename 等绕过 guard 路径纳入计量 | [storage-115-executor.ts](../../packages/workflow/src/storage/storage-115-executor.ts) | pan115-guard-calls-spent、storage-115-executor |
| P1 XState 接真实 I/O 边界、操作账本／attempt／租约／对账恢复 | [workflow-v2.ts](../../packages/workflow/src/acquisition-v2/workflow-v2.ts)、orchestrator.ts | v2-acceptance、v2-movie-workflow、v2-runner-persist |
| P1 覆盖满足后状态门控采集工具 | [coverageGatedActiveTools](../../packages/workflow/src/acquisition-v2/agent-loop.ts) | v2-agent-loop-coverage-gate |
| P2 证据绑定 commit（成功必须有验证文件，否则拒绝且不登记） | [obtainedEvidence](../../packages/workflow/src/acquisition-v2/sandbox.ts) | v2-acceptance、v2-sandbox-coverage |
| P2 健康感知观察缓存（不健康空缓存免费复搜，健康空缓存 dedup） | [isSnapshotHealthTrusted](../../packages/workflow/src/acquisition-v2/snapshot-presentation.ts) | search-profile、v2-raw-snapshot |
| P2 指引保守改写（0 先判源健康再升级，中英／各类型一致） | [search-profile.ts](../../packages/workflow/src/acquisition-v2/search-profile.ts)、skill.ts、task-agents.ts | search-profile |
| §11.1 tool call：独立 callId／attemptId／开始／结束／状态／结构化错误 | [agent-tool-wrap.ts](../../packages/workflow/src/acquisition-v2/agent-tool-wrap.ts)、[agent-trace-sink.ts](../../packages/workflow/src/acquisition-v2/agent-trace-sink.ts)、[updateAgentStepEnd](../../packages/workflow/src/persistence/sqlite.ts)、[agent-step-view.ts](../../packages/workflow/src/domain/agent-step-view.ts)、[agent-timeline.tsx](../../apps/web/features/activity/components/agent-timeline.tsx) | agent-trace-sink、agent-loop-progress、progress-sink、agent-step-view、repository-contract |
| §11.1 loopStopReason 与 SDK finishReason 分存 | [agent-stop-reason.ts](../../packages/workflow/src/acquisition-v2/agent-stop-reason.ts) | agent-stop-reason、repetition-stop |
| §11.1 UI 计数准确命名（工具调用记录 N 条／网盘 API 累计 N 次） | [agent-timeline.tsx](../../apps/web/features/activity/components/agent-timeline.tsx) | activity-view |

tool-end 记录链路：`wrapTools`（[agent-tool-wrap.ts](../../packages/workflow/src/acquisition-v2/agent-tool-wrap.ts)）每次调用生成 callId，执行前发 start、执行后发 end（throw 或 guard `{error}` → `failed`＋结构化错误，否则 `succeeded`）；trace sink 把 start 追加为步骤、end 按 callId 合并到同一步骤（不消耗 ordinal）；progress sink 忽略 end，避免重复推进进度或重复计数 obtained。payload 为 JSON blob，新增字段无需 schema 迁移。

### 13.3 本次验证

```bash
npm run build:workflow   # 刷新 dist 类型（apps/web typecheck 依赖 built dist）
npm run typecheck        # tsc --noEmit && tsc --project apps/web/tsconfig.json --noEmit
npm run lint             # eslint . --max-warnings 0
npm run gate             # 24 个子门禁 + lint + typecheck
npm test                 # 全量 vitest
```

- `build:workflow`／`typecheck`／`gate`／`lint` 均通过（`npm run gate` exit 0）。
- 全量 vitest：**7310 通过**；15 个失败全部位于本次未改动的 `apps/updater`（`tunnel-env.test.mjs`／`run-update.test.mjs` 的 POSIX 文件权限位断言，Windows 不 honor `chmod 0o600/0o640`，报 `expected 438 to be 384` 一类）。已用 `git stash` 移除本次全部改动后复跑同一文件，失败数不变，证明与本次改动无关。
- 新增／更新测试覆盖：tool-end 记录（start/end 路由、callId 关联、end 不消耗 ordinal、end 不推进进度）、`updateAgentStepEnd`（in-memory＋SQLite 双引擎契约）、覆盖门控、健康感知指引、展示字段投影。

**gate:limits 与 gate:layout 的处理（用户已决策）**：方案功能点使 7 个已在 baseline 登记的巨型文件增长，触发棘轮；`agent-loop.ts` 作为非 baseline 新文件超过 600 行硬限。处理方式：

1. **拆分而非放宽绝对上限**：`agent-loop.ts` 的工具包装／可观测关注点抽到 [agent-tool-wrap.ts](../../packages/workflow/src/acquisition-v2/agent-tool-wrap.ts)（691→593 行，解除新文件硬限）；`sandbox.ts` 超出 `gate:layout` 的 2640 行棘轮（该门禁自带一条独立于 baseline 的硬编码上限），按门禁自身建议「拆分到独立子模块」，把纯函数的快照呈现与关键词卫生逻辑抽到 [snapshot-presentation.ts](../../packages/workflow/src/acquisition-v2/snapshot-presentation.ts)（2748→2610 行）。两处均为纯搬迁，行为不变，无新增抽象层。
2. **存量 7 文件按用户决策 re-baseline**：`node scripts/gate-code-limits.mjs --update-baseline` 固化最新指标（orchestrator／sandbox／runner-v2／repository／sqlite／storage-115-executor／repository-contract）。这是棘轮的常规使用方式——方案授权的合法功能增长后重新登记基线；不是为掩盖问题而放宽。这些上帝类的进一步拆分仍属技术债，未在本次范围。
3. **`eslint-suppressions.json` 剪枝**：`--prune-suppressions` 清掉 1 条已失效条目（`real-storage-adapter.ts::complexity`，本次改动后该函数复杂度已下降）。ESLint 9 会把失效的 bulk suppression 视为退出码 2 的硬错误。

### 13.4 未完成与边界

- **浏览器实机验收未做**：本地 dev 会加载 `env/.envdev` 的真实 115 凭据并发起真实调用（`--demo` 不替换 storage adapter），时间线徽标的真实运行数据需另行授权的真实采集才能产生。本次仅完成测试／类型／lint／回归验证；未在生产造数、未发起真实转存、未部署。
- **P3／合集导入／质量规则**：未实施，需另行决策（第12节）。
- 没有新增依赖。本文不覆盖用户正在修改的业务文件及其他研究文档。

历史校正：2026-11-10的[活动持久化与重试调查](2026-11-10-activity-persistence-and-transfer-retry-storm-investigation.md)可作背景，但当前 `fc`／`fn` 解析已修正，现有熔断和XState也确实存在；不能再以旧文“单一字段根因”“没有断路器”等断言解释这次事故。[当前115字段解析](../../packages/workflow/src/storage/pan115-open-client.ts#L202)。

## 14. 参考来源

检索与核对日期：2026-11-14。优先使用官方文档／维护者仓库；在线文档可能领先本地安装版本，采用前需核对本地类型及锁文件。

- [S1 Sonarr 官方 Wiki 源码](https://github.com/Servarr/Wiki/tree/master/sonarr)：检索、下载、队列、失败处理与导入边界。
- [S2 Radarr Settings](https://wiki.servarr.com/radarr/settings)：质量档案、custom formats、升级与导入配置。
- [S3 Prowlarr Quick Start Guide](https://wiki.servarr.com/prowlarr/quick-start-guide)：索引器与应用同步职责。
- [S4 MoviePilot Wiki](https://github.com/jxxghp/MoviePilot-Wiki)：订阅、搜索、整理及插件能力边界。
- [S5 XState Persistence](https://stately.ai/docs/persistence)：快照持久化、恢复与副作用注意事项。
- [S6 AI SDK Loop Control](https://ai-sdk.dev/docs/agents/loop-control)；[Tools and Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)：工具、循环和步骤控制，具体API以本地6.0.201为准。
- [S7 LangGraph JS SQLite Checkpointer](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-sqlite)：JavaScript SQLite支持的实际实现。
- [S8 LangGraph JS Fault Tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)：检查点与恢复边界。
- [S9 Temporal TypeScript SDK](https://github.com/temporalio/sdk-typescript)：Node/TypeScript组件与运行结构。
- [S10 Temporal Service Persistence](https://docs.temporal.io/temporal-service/persistence)：服务持久化和部署要求。
- [S11 Temporal Activity Definition](https://docs.temporal.io/activity-definition)：activity重试与幂等要求。
- [S12 BullMQ](https://github.com/taskforcesh/bullmq)；[S13 Idempotent Jobs](https://docs.bullmq.io/patterns/idempotent-jobs)：Redis队列与幂等设计。
- [S14 p-limit](https://github.com/sindresorhus/p-limit)：并发限制。
- [S15 p-queue](https://github.com/sindresorhus/p-queue)：进程内异步任务队列。
- [S16 Bottleneck](https://github.com/SGrondin/bottleneck)：限速、reservoir和分布式限流。
- [S17 Anthropic — Writing Tools for Agents](https://www.anthropic.com/research/writing-tools-for-agents)：任务导向工具、信息密度和评测维度。
- [S18 Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)：预定义workflow与自主agent的复杂度、成本和适用性取舍。

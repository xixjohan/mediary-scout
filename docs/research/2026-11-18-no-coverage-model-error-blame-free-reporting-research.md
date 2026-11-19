# 「暂未找到可用资源」的真身：模型循环第 1 步就崩了，却被当成「确实没有片源」

- 日期：2026-11-18
- 状态：调研完成（含门禁设计），方案待实施
- 触发现象（生产 `/notifications`，2026-11-18 22:01）：
  - 《咒术回战 第 1 季》卡片：`暂无资源` + 「暂未找到可用资源 · 将持续尝试」+ 缺集 E01–E59
  - 同一部片在「创建订阅 → 预览」里**能看到资源**
- 数据来源：生产容器 `mediary` 的 `data/mediary.db`（154 条 `workflow_runs` 只读查询）+ 源码审计

---

## 1. 结论先行

**搜索是成功的，失败的是模型循环本身；产品把系统故障报成了内容事实。**

《咒术回战》那一轮的审计链完整写着：

```
resource_filter_applied   { inputCount: 82, keptCount: 77, policyDropped: 5,
                            policyReasons: {wrong_title: 5}, sourceStatus: "healthy" }
loop_stopped              「智能体循环结束：model_error（共 1 步）」
                          data: { stopReason: "model_error", steps: 1 }
```

三件事同时成立：

1. 搜索源健康（`sourceStatus: "healthy"`），**取回 82 条候选，准入 77 条**；
2. 磁盘上确有这份快照（`resource_snapshots` 里 `咒术回战:77`）；
3. **智能体只跑了 1 步就停了，且没有任何终结声明**（无 `no_coverage_reported`、无 `finish`）。

也就是说：搜到了、筛过了、77 条候选摆在那里，模型第一步就报错退出，
而下游的集数算术看到「一集也没进库」，于是判定 `no_coverage`，
最终渲染成「暂未找到可用资源 · 将持续尝试」。

**这正是三年前那条教义要防的事，只是这次甩锅的对象从「搜索源」换成了「大模型」。**

### 1.1 不是孤例：生产里 27 条 no_coverage 有一半是这种

| 统计（154 条 run，27 条 `no_coverage`） | 数量 |
| --- | --- |
| `stopReason = model_error` | **14** |
| 其中 `steps = 1`（第一步就崩） | **13** |
| 其中 `keptCount > 0`（明明有候选） | **10**（单轮最多 235 条） |
| `candidate_exhausted`（真正搜完没找到） | 1 |
| 无 `loop_stopped` 事件（旧版本 / 真·无覆盖） | 12 |

单轮准入候选数对照（全部 1 步即停）：

```
4d0da4f3 type3_monitor  kept=235  steps=1
5a54ab4b type3_monitor  kept=221  steps=1
95364a55 type3_monitor  kept=229  steps=1
9ca4a072 type3_monitor  kept=164  steps=1
5d601c14 type3_monitor  kept=84   steps=1
eb78f8e2 type3_monitor  kept=77   steps=1   ← 截图里的《咒术回战》
0ee10732 type2_init     kept=82   steps=1
81f02a2e type2_init     kept=9    steps=1
aab2bad9 type3_monitor  kept=0    steps=1
```

「有 235 条候选却报告没有资源」——这不是资源问题，是**报告说谎**。

### 1.2 为什么「预览」和「巡检」会互相打脸

两者走的是同一条 `matchPolicy`（这是刻意设计的承诺），但**证据来源不同**：

| 入口 | 取数 | 判定 | 结论依据 |
| --- | --- | --- | --- |
| 创建订阅 → 预览 | `resolveTitleResources` + `previewPolicy(…, { identity })` | 纯函数，把候选逐条过规则 | 只要有候选能过规则就报「命中 N 个」 |
| 每日巡检 22:00 | 搜索 → 快照落库 → **交给 LLM 智能体**决定转存 | LLM 逐步调用工具 | 集数算术：`stillMissing === missingBefore` ⇒ `no_coverage` |

预览是**确定性**的；巡检是**概率性**的。中间那层 LLM 挂了，预览不知道，用户只看到两个自相矛盾的结论。
所以「预览能看到资源、巡检说没有资源」不是数据不一致，而是**可靠性层级不同**——而产品没有把这件事说出来。

---

## 2. 根因：缺一层「智能体失败」的分类器

### 2.1 状态是算出来的，看不到「谁没干活」

[workflow-v2-bridge.ts:246](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/workflow-v2-bridge.ts#L246)：

```ts
function resolveStatus(input: { missingBefore: string[]; stillMissing: string[] }): WorkflowStatus {
  if (input.stillMissing.length === 0) return "succeeded";
  if (input.stillMissing.length < input.missingBefore.length) return "partial";
  return "no_coverage";      // ← 一集没进库就落到这里，不问原因
}
```

函数签名里**根本没有**审计事件。搜索源全挂、模型报错、清一色被规则排除、真的没有资源——
四种完全不同的现实，在同一个 `return` 处坍缩成同一个状态。

### 2.2 「别甩锅」教义已经实现了三次，但漏了第四次

仓库里已经有三条同形制的分类器，且都被 `emptyRunOutcome` 消费
（[notification-report.ts:110](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/domain/notification-report.ts#L110)）：

| 分类器 | 覆盖的「不是资源的问题」 | 用户读到的文案 |
| --- | --- | --- |
| `classifyTransferBlock`（[transfer-block.ts:45](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/transfer-block.ts#L45)） | 账号被封：配额 / 登录过期 / 非 VIP / 盘满 | 「转存失败:配额不足」 |
| `classifySearchSourceFault`（[search-source-fault.ts:38](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/search-source-fault.ts#L38)） | 搜索源连不上 / 返回非 PanSou 格式 | 「XX 本轮连不上…资源留待源恢复后自动重试」 |
| `searchFilterFailureReason`（[search-filter-diagnostics.ts:21](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/search-filter-diagnostics.ts#L21)） | 候选全被订阅规则排除 | 「已有候选未满足订阅规则（…），本轮未自动采集」 |
| **（缺）** | **智能体循环异常终止（模型报错/内容过滤/空转）** | **退化成「暂未找到可用资源」** |

第四种正是本次命中的分支。缺了它，`emptyRunOutcome` 落到最后一行：

```ts
return { status: "no_coverage", lines: ["暂未找到可用资源 · 将持续尝试"] };
```

### 2.3 `model_error` 的语义本来就是「系统异常」，只是没人翻译

[agent-stop-reason.ts:49](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/agent-stop-reason.ts#L49)：

```ts
if (finishReason === "content-filter" || finishReason === "error") return "model_error";
if (hasSuccessfulFinish(steps)) return "coverage_met";
if (hasSuccessfulNoCoverageReport(steps)) return "candidate_exhausted";
…
return "model_error";   // 裸 stop、无终结声明 ⇒ 也是模型异常
```

单测已经把语义钉死（`agent-stop-reason.test.ts`）：
- 「labels a bare model stop with no terminal declaration model_error」
- 「labels a content-filter finish model_error」

问题是：**这个结论只写进了审计事件**（`loop_stopped`），下游三个消费方——bridge 的状态判定、
通知文案、通知页的 pill——都没有读它。

### 2.4 失败为什么没走「获取失败」那条路

仓库其实有一条诚实的失败通道：
`handleWorkflowRunFailure`（[workflow-failure-handler.ts:169](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/workflow-failure-handler.ts#L169)），
渲染成 `status: "failed"` → 「获取失败」，并区分 `retrying`（网络类可自动重排）与终态失败。

但它只在**抛错**时触发。本次 `generateAgentTurn` **没有抛错**——AI SDK 正常返回了一个
`finishReason: "error"`（或裸 `stop`）的空结果。异常被吞成了「正常的空运行」，
于是绕开了失败通道，径直落进 `no_coverage`。

这构成一个**分类盲区**：同一类「模型不可用」，抛错时叫「获取失败」，不抛错时叫「没有资源」。

---

## 3. 侧证：这些运行的 staging 也没清掉

14 条 `model_error` 里有 11 条附带：

```
staging_leaked  staging 目录清理后仍在网盘上(3565353622705276197)…
  cleanupError: "SAFETY_VIOLATION: refusing to remove protected/root directory cid=…"
```

即：模型第一步就死了，暂存目录既没被整理也没被回收。这不是本次主诉，但同属
「智能体中途死亡」的后果面——清理依赖模型主动调用工具，模型没跑就没有人收尾。
（建议单独立项，不与本方案混做。）

---

## 4. 现有可复用的基础设施（不需要新库）

| 能力 | 现有实现 | 本方案怎么用 |
| --- | --- | --- |
| 停止原因枚举 | `LoopStopReason`（9 个值，含 `model_error`） | 直接作为分类输入，不新增枚举 |
| 审计通道 | `loop_stopped` 事件，已带 `{stopReason, steps}` | **零 schema 变更**，读取即可 |
| 诚实文案通道 | `emptyRunOutcome(transferBlock, sourceFault, filterReason)` | 追加第 4 个入参，签名对称 |
| 状态与 kind 联动 | `report.status === "failed" → kind = "transfer_failed"`（3 处已实现） | 沿用同一模式，新增 `agent_error` kind |
| 失败重试判定 | `isTransientForRun` / `AUTO_REQUEUE_*` | 内容过滤类不重排、网关类可重排 |
| 通知页 pill 表 | `statusMeta` / `kindIcon`（[page.tsx:53](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/notifications/page.tsx#L53)） | 加一行即可 |

结论：**不需要引入任何新依赖**。这只是把已经存在的事实接到已经存在的渲染通道上。

---

## 5. 业界主流做法对比

| 系统 | 如何处理「搜不到」vs「工具/系统坏了」 | 对本项目的启示 |
| --- | --- | --- |
| **Sonarr / Radarr + Prowlarr** | 每个 indexer 独立健康状态；搜索失败在 UI 上报红字（「Indexer X failed」），**不改变剧集本身的「已获取/缺失」状态**；「No results found」只在 indexer 全部成功返回时出现 | 状态位与证据位必须分离：剧集缺集是事实，索引器失败是另一维度 |
| **Prowlarr** | 上面搜索结果的改进说明里明确提到「Improve messaging on no results with applied filter」——即空结果要区分「过滤掉了」 | 与本仓 `searchFilterFailureReason` 同源思路 |
| **AI Agent 工程实践**（2026 年失败分类学） | 一致强调「silent failure」是最难排查的一类：agent 不抛错、返回空、上游记成成功 | 本次即典型 silent failure——`finishReason: "error"` 不抛错 |
| **MoviePilot** | 订阅下载失败会区分「资源不存在 / 索引器异常 / 下载器异常」，分别给不同提示 | 与本方案的四分类一致 |

**共同结论**：成熟系统的做法不是「猜资源有没有」，而是**把「没拿到」拆成互斥的几种原因，各自说真话**。

---

## 6. 具体方案

### 6.1 第一步：补第四个分类器（核心，约 40 行）

新增 `packages/workflow/src/acquisition-v2/agent-fault.ts`，与 `transfer-block.ts` 同形制：

```ts
/**
 * 智能体循环异常终止判定 —— transfer-block / search-source-fault 的第三个孪生。
 *
 * 缺陷原型（2026-11-18 生产实测）：搜索取回 82 条、准入 77 条、源健康，
 * 但 LLM 第一步就 finishReason=error（不抛错），循环静默结束。集数算术看到
 * 「一集没进库」判 no_coverage，用户读到「暂未找到可用资源」——预览里却能
 * 看到这部片的资源。系统故障又一次被报成了内容事实。
 */
const LOOP_STOPPED = "loop_stopped";

export interface AgentFault {
  reason: string;
  stopReason: "model_error";
  steps: number;
  /** 本轮是否有任何一个模型可判定的终结声明（finish / reportNoCoverage）。 */
  hasTerminalDeclaration: boolean;
}

export function classifyAgentFault(
  auditEvents: readonly AuditEvent[] | undefined,
): AgentFault | null {
  if (!auditEvents?.length) return null;
  const stopped = [...auditEvents].reverse().find((e) => e.type === LOOP_STOPPED);
  if (!stopped || stopped.data?.["stopReason"] !== "model_error") return null;
  // 有终结声明却仍被判 model_error = 内容过滤等罕见组合，仍按故障报，但要说明。
  const steps = Number(stopped.data?.["steps"] ?? 0);
  return {
    reason:
      steps <= 1
        ? "AI 模型本轮没有产出任何可用步骤（上游返回空/报错），本次没有真正评估资源。"
        : "AI 模型本轮中途异常终止，未能完成资源评估。",
    stopReason: "model_error",
    steps,
    hasTerminalDeclaration: false,
  };
}
```

**为什么必须是「不猜」的读取式判定**：与 `classifySearchSourceFault` 同一条边界——
只有 `loop_stopped.stopReason === "model_error"` 这条**结构化证据**才触发。
`deriveLoopStopReason` 已经把「有 `finish`」「有 `reportNoCoverage`」排除在前，
所以读到 `model_error` 等价于「既没完成也没诚实放弃」。

### 6.2 第二步：串进 `emptyRunOutcome`（签名对称扩展）

```ts
export function emptyRunOutcome(
  transferBlockReason?: string | null,
  searchSourceFaultReason?: string | null,
  searchFilterReason?: string | null,
  agentFaultReason?: string | null,     // ← 新增，最后一位
) {
  if (transferBlockReason?.trim()) return { status: "failed", lines: [`转存失败:${…}`] };
  if (searchSourceFaultReason?.trim()) return { status: "failed", lines: [searchSourceFaultReason.trim()] };
  if (searchFilterReason?.trim()) return { status: "failed", lines: [searchFilterReason.trim()] };
  if (agentFaultReason?.trim()) return { status: "failed", lines: [agentFaultReason.trim()] };
  return { status: "no_coverage", lines: ["暂未找到可用资源 · 将持续尝试"] };
}
```

优先级放在最后是刻意的：**能走到转存/被规则排除，说明资源确实找到了**，
那两条对用户更有行动价值；`agentFault` 只在「连评估都没发生」时才说话。

### 6.3 第三步：三个消费点接线

| 位置 | 改动 |
| --- | --- |
| `workflow-v2-bridge.ts:123-133` | 加 `const agentFault = classifyAgentFault(v2.auditEvents);`，把 `agentFault?.reason ?? null` 传进 `buildNotification` |
| `workflow-v2-bridge.ts:316 / 351 / 373` | `kind` 增加 `report.status === "failed" && agentFault → "agent_error"`（与 `transfer_failed` 同构） |
| `movie-workflow-v2.ts:326-330` | 同一个第 4 入参接上 |

### 6.4 第四步：UI 与摘要（3 处小改）

| 文件 | 改动 |
| --- | --- |
| `notifications/page.tsx` `kindIcon` | 加 `agent_error: { tone: "amber", icon: AlertTriangle }` |
| `notifications/page.tsx` `daySummary` | 「N 项暂无资源」的统计只数 `kind === "no_coverage"` —— 已正确；`agent_error` 自动不落入，无需改 |
| `activity-feed.tsx` `completedPillLabel` | `failed` 已映射「获取失败」，沿用 |

> 关键收益：`agent_error` 不叫「暂无资源」，通知页顶部的「N 项暂无资源」计数也就自动诚实了。

### 6.5 第五步（可选，但与本次根因同源）：让「预览 vs 巡检」不再打脸

在订阅卡的巡检报告里，若本轮是 `agent_error`，追加一行指向证据：

> 「本次未评估资源（AI 模型异常）。搜索已取回 77 个候选，可在详情页「资源」里直接预览。」

这需要把 `keptCount` 一并带出（`resource_filter_applied.data` 已有，无需新查询）。

---

## 7. 门禁与回归测试（同类问题不复发）

### 7.1 单元测试（`packages/workflow/tests/execution/agent-fault.test.ts`）

| 用例 | 断言 |
| --- | --- |
| `loop_stopped{model_error, steps:1}` | 返回非 null，文案含「没有产出任何可用步骤」，**不得出现「暂未找到」「没有资源」** |
| `loop_stopped{model_error, steps:7}` | 文案为「中途异常终止」 |
| `loop_stopped{coverage_met}` | 返回 null（真成功不能报故障） |
| `loop_stopped{candidate_exhausted}` | 返回 null（真·没找到必须保留 no_coverage） |
| 无 `loop_stopped` 事件 | 返回 null（旧数据/非 agent 路径不误判） |
| `emptyRunOutcome(null,null,null, agentFaultReason)` | `status === "failed"`，且**不等于**「暂未找到可用资源」 |
| `emptyRunOutcome` 四参全空 | 仍是 `no_coverage`（**守卫：不许把真·无覆盖也变成 failed**） |

### 7.2 门禁（`tools/gates/check-blame-free-reporting.mjs`，新增）

这类 bug 的共性是「新增了一种系统故障，但忘了加进诚实通道」。用静态断言堵住：

1. **断言分类器齐备**：`acquisition-v2/` 下必须同时存在
   `transfer-block.ts`、`search-source-fault.ts`、`search-filter-diagnostics.ts`、`agent-fault.ts`。
2. **断言接线未被删**：`workflow-v2-bridge.ts` 与 `movie-workflow-v2.ts` 都必须
   import 并调用 `classifyAgentFault`，且把结果传进 `emptyRunOutcome` / `buildNotification`。
3. **断言 `no_coverage` 不再无条件兜底**：`emptyRunOutcome` 的实现里，
   `status: "no_coverage"` 必须出现在**所有**故障分支之后（用行号比较，防止有人把新分支追加到 return 后面）。
4. **断言 `loop_stopped` 事件仍带 `stopReason`**：`orchestrator.ts` 里该事件的 `data` 必须含
   `stopReason`（否则整条链读不到证据）。

> 门禁的判据是「有没有可能再次沉默」——一个故障种类，若没有对应的
> `classify*` 且没被 `emptyRunOutcome` 消费，静态就应该红。

### 7.3 端到端（可选，`tests/e2e/`）

fake 栈注入一个 `finishReason: "error"` 的 stub 模型，断言：
- 通知卡 pill 是「获取失败」而不是「暂无资源」；
- 通知页顶部摘要**不计入**「N 项暂无资源」；
- 详情页「资源」面板里仍能看到候选（证明数据一直在，只是报告错了）。

---

## 8. 明确不做

- **不把 `model_error` 一律判成可重试**：内容过滤 / 模型下线重排只会重复烧钱。
  沿用 `isTransientForRun` 现有的保守分类，本方案只改**文案与状态**，不改重试策略。
- **不改 `resolveStatus` 的集数算术**：缺集是事实，仍然按集数算 `partial` / `no_coverage`；
  由 `emptyRunOutcome` 在**文案与 `report.status`** 层纠正。
- **不新增数据库列**：证据已存在于 `auditEvents`（JSON 列），读取即可。
- **不在本方案里修 `staging_leaked`**：那是另一个独立缺陷（清理依赖模型主动调用），单独立项。

---

## 9. 参考

- 本仓既有教义与实现：`docs/postmortems/strm-generation-empty-and-false-paused-state.md`（「别甩锅」的起源）、
  `packages/workflow/src/acquisition-v2/search-source-fault.ts`、`transfer-block.ts`、
  `docs/research/2026-11-17-preview-false-positive-identity-gate-research.md`（预览与巡检同源判定的另一半故事）
- 同族失败分类学：
  [AI Agent Failure Modes in 2026: The 5-Category Taxonomy](https://futureagi.com/blog/ai-agent-failure-modes-2026/)、
  [An Ontology of LLM Failure Modes](https://www.composo.ai/post/llm-failure-modes/)、
  [Why LLM Agents Fail Silently and How to Debug Them](https://dev.to/mudassirworks/why-llm-agents-fail-silently-and-how-to-debug-them-251l)
- 业界同类产品的处理方式：
  [Radarr 日志中 indexer 失败与「No results found」分离](https://forums.unraid.net/topic/53807-support-binhex-radarr/page/36/)、
  [Prowlarr 关于「no results with applied filter」的提示改进](https://www.freshports.org/net-p2p/prowlarr/pkg-plist)、
  [Sonarr 搜索无结果与索引器状态的讨论](https://wiki.servarr.com/sonarr/system)

---

## 10. 实施记录（2026-11-18）

### 10.1 落地清单

| 阶段 | 交付 | 位置 |
| --- | --- | --- |
| 分类器 | `classifyAgentFault()`：读 `loop_stopped.stopReason === "model_error"` 且 `steps <= 1`；读 `resource_filter_applied.keptCount` 之和决定文案是否点名候选数 | [agent-fault.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/agent-fault.ts) |
| 包装导出 | `export * from "./acquisition-v2/agent-fault.js"` | [packages/workflow/src/index.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/index.ts) |
| 诚实通道 | `emptyRunOutcome` 增加第 4 入参 `agentFaultReason`，优先级排在最末（转存受阻 > 源故障 > 规则排除 > 智能体异常） | [notification-report.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/domain/notification-report.ts) |
| 报告透传 | `buildSeasonReport` / `buildSeriesReport` / `buildReplacementReport` 三个 builder 同增 `agentFaultReason` | 同上 |
| 剧集接线 | bridge 调 `classifyAgentFault`，经 `failedKind()` 决定 `agent_error` / `transfer_failed`（覆盖 replace / series / type3 / 单季四条出口） | [workflow-v2-bridge.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/workflow-v2-bridge.ts) |
| 电影接线 | 同一分类器接入 `emptyRunOutcome` 第 4 参，kind 同样分 `agent_error` | [movie-workflow-v2.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/movie-workflow-v2.ts) |
| UI | 通知页新增 `agent_error`（红色 `TriangleAlert`），pill 文案覆盖为「AI 异常」；活动页读 `kind` 区分「AI 异常 / 获取失败」；`ActivityCompletedItem` 新增 `kind` 字段 | [notifications/page.tsx](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/notifications/page.tsx)、[activity-feed.tsx](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/activity/components/activity-feed.tsx)、[activity-view.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/activity/core/activity-view.ts) |
| 样式 | `.feed-icon.tone-red` / `.feed-status-pill.tone-red` 用 `--color-danger` 组合 | [notifications.css](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/activity/styles/notifications.css) |
| 门禁 | `check-blame-free-reporting.mjs`（六项检查）+ 注册 `gate:blame-free` 到 `npm run gate` | [tools/gates/](file:///E:/WorkProject/Node/_Project/mediary-scout/tools/gates/check-blame-free-reporting.mjs) |

### 10.2 实施中修正的一个判断（比方案更严）

方案原本设想「多步后 `model_error` 也报中途异常终止」。实跑回归时 `replace-request` 测试有 6 条变红：
**替换运行以 `reportReplacement` 收尾，那是它自己的终结声明，循环没有机械停止**，
于是自然结束的 replace run 也会被判 `model_error`——把它报成「AI 异常」是反向撒谎
（模型明明干完了活）。

因此分类器收紧到 **`steps <= 1`**：模型只产出过一轮且毫无作为才算系统故障。
生产实测支持这个边界——14 条 `model_error` 里 13 条 `steps = 1`，
唯一多步的那条已被搜索源故障分类器覆盖。多步后结束的一律返回 `null`，
保持「暂未找到可用资源」这个不确定但诚实的结论。

（这也是「不做历史兼容」的收益：直接收窄判据即可，不需要兼容旧通知。）

### 10.3 实机验证（Dev 3020 容器内跑真实 dist）

用生产事故的真实审计证据直接调 `bridgeV2WorkflowToResult`：

| 用例 | kind | report.status | run.status | 文案 |
| --- | --- | --- | --- | --- |
| **A 事故复现**（`model_error` steps=1, kept=77） | `agent_error` | `failed` | `no_coverage` | 「AI 模型本轮异常终止，没有评估已找到的 77 个候选。资源可能仍在，可在作品详情页「资源」里手动获取。」 |
| **B** 同因但零候选 | `agent_error` | `failed` | `no_coverage` | 「AI 模型本轮没有产出任何可用步骤（上游空响应或报错），本次没有真正检索与评估资源。」 |
| **C 对照组** `candidate_exhausted` | `no_coverage` | `no_coverage` | `no_coverage` | 「暂未找到可用资源 · 将持续尝试」（保持） |
| **D 对照组** 无审计事件 | `no_coverage` | `no_coverage` | `no_coverage` | 同上（保持） |
| **E 对照组** 多步 `model_error` | `no_coverage` | `no_coverage` | `no_coverage` | 同上（不误判为 AI 异常） |

> `run.status` 仍为 `no_coverage` 是刻意的：**缺集是事实**，集数算术不该被文案修正污染。
> 诚实发生在 `report.status` 与 `kind` 这两层——而那正是用户看见的那两层。

### 10.4 质量门禁

`lint` / `typecheck` / `npm run gate`（含新增 `gate:blame-free`）全绿；
`packages/workflow/tests/acquisition-v2` + `tests/execution` + `tools/gates` 共 **150 个文件 / 1662 条用例**全部通过。
新增用例 20 条：`agent-fault.test.ts`(8) + `empty-run-outcome-agent-fault.test.ts`(5) +
`agent-error-notification-wiring.test.ts`(6) + `check-blame-free-reporting.test.mjs`(1)。

### 10.5 存量数据影响

生产库里已有的 14 条 `model_error` 通知**不会自动改写**（通知是落库快照）。
它们是 2026-11-18 22:00 之前的记录，历史就是历史；下次同类故障起才会产出
`agent_error`。若需要清理这些旧卡片的误导性文案，需一次性数据订正脚本——
本方案不做（不在需求范围内，且会改写历史事实）。

import type { AuditEvent } from "../domain.js";

/**
 * 智能体循环异常终止判定 —— `transfer-block.ts` 与 `search-source-fault.ts` 的第三个孪生。
 *
 * 缺陷原型（2026-11-18 生产实测，《咒术回战 第 1 季》）：
 *   resource_filter_applied { inputCount: 82, keptCount: 77, sourceStatus: "healthy" }
 *   loop_stopped            { stopReason: "model_error", steps: 1 }
 * 搜索取回 82 条、准入 77 条、源健康，但 LLM 第一步就 `finishReason: error`（**不抛错**），
 * 循环静默结束。集数算术看到「一集没进库」判 `no_coverage`，用户读到「暂未找到可用
 * 资源 · 将持续尝试」——而同一个订阅在「预览」里能看到资源。
 *
 * 这是「别甩锅」教义的第四种系统故障：前三种（账号被封锁 / 搜索源故障 / 规则全排除）
 * 都已经有分类器并被 `emptyRunOutcome` 消费，只有「智能体自己崩了」退化成内容事实。
 *
 * ## 为什么必须先排除「终结声明」
 *
 * `deriveLoopStopReason` 的顺序是：有成功的 `finish` ⇒ `coverage_met`；有成功的
 * `reportNoCoverage` ⇒ `candidate_exhausted`；两者都没有才是 `model_error`。
 * 因此读到 `model_error` **等价于**「既没完成，也没诚实放弃」——这正是系统故障。
 * 反过来，真实的「搜完了确实没有」落 `candidate_exhausted`，本分类器必须返回 null，
 * 否则产品再也无法如实报告「确实没有」，那比它要修的 bug 更糟。
 *
 * ## 为什么是读取式判定而不是重新推断
 *
 * 与 `classifySearchSourceFault` 同一条边界：证据来自 sandbox/orchestrator 写下的
 * 结构化审计事件，不从错误文本猜、不看模型措辞。任何正则匹配都可能把「模型说它
 * 崩溃了」误当成真崩溃，也可能漏掉真正的崩溃。
 */

/** orchestrator 在收尾时写下的唯一产物，携带业务停止原因。 */
const LOOP_STOPPED = "loop_stopped";

export interface AgentFault {
  /** 面向用户的一句话，直接进通知。 */
  reason: string;
  /** 本轮是否「搜索取回过候选」。有候选仍报无覆盖时，文案要指出去哪看。 */
  searchedCandidateCount: number;
  /** agent 消耗的步数（`model_error` 时通常 ≤1：第一轮就没产出）。 */
  steps: number;
}

/**
 * 从本次运行的审计事件里判定「这一轮是智能体自己崩了」。
 *
 * 返回 null 表示没有证据 —— 此时「暂未找到资源」是诚实的结论，必须原样保留。
 *
 * ## 为什么只认 `steps <= 1`
 *
 * `model_error` 的判据是「没有成功的 finish、也没有成功的 reportNoCoverage」。
 * 这个判据对**真正跑过的**运行过严：替换运行以 `reportReplacement` 收尾（那是它
 * 自己的终结声明，循环没有机械停止），模型正常结束却仍会被判 `model_error`。
 * 把它报成「AI 异常」是反向撒谎（模型明明干完了活）。
 *
 * 实测分布（生产 154 条 run）：14 条 model_error 里 13 条 `steps = 1`，
 * 唯一多步的那条已被搜索源故障覆盖。所以这里取最保守、也最无歧义的边界：
 * **模型只产出过一轮且毫无作为** = 系统故障；多步后结束的一律不认，交回
 * 「暂未找到可用资源」这个不确定但诚实的结论。
 */
export function classifyAgentFault(
  auditEvents: readonly AuditEvent[] | undefined,
): AgentFault | null {
  if (!auditEvents || auditEvents.length === 0) {
    return null;
  }
  // 取最后一条：一次运行至多一条 loop_stopped，但防御性地取最新（重试链可能叠加）。
  let stopped: AuditEvent | undefined;
  for (let index = auditEvents.length - 1; index >= 0; index -= 1) {
    const event = auditEvents[index];
    if (event?.type === LOOP_STOPPED) {
      stopped = event;
      break;
    }
  }
  if (stopped === undefined || stopped.data?.["stopReason"] !== "model_error") {
    return null;
  }

  const steps = Math.max(0, Number(stopped.data?.["steps"] ?? 0));
  // 多步后结束 ≠ 「一点活都没干」：可能是替换运行用 reportReplacement 正常收尾，
  // 也可能是别的机械停止。不认，保持 no_coverage。
  if (steps > 1) {
    return null;
  }

  const searchedCandidateCount = countAdmittedCandidates(auditEvents);
  return {
    reason: faultCopy(searchedCandidateCount),
    searchedCandidateCount,
    steps,
  };
}

/**
 * 本轮「过完准入门」的候选总数。读 `resource_filter_applied` 的 `keptCount`
 * 之和——这是 agent 真正能看见、能转存的那批，不是原始命中数。没有该事件
 * （例如电影路径不落这条审计）时返回 0，文案随之退化为不提数字。
 */
function countAdmittedCandidates(auditEvents: readonly AuditEvent[]): number {
  let total = 0;
  for (const event of auditEvents) {
    if (event.type !== "resource_filter_applied") continue;
    const kept = Number(event.data?.["keptCount"] ?? 0);
    if (Number.isFinite(kept) && kept > 0) total += kept;
  }
  return total;
}

/**
 * 文案分两档，全部避开「没有资源」这种结论式措辞：
 *  - 有候选：资源一直在，给出去哪看；
 *  - 无候选：连检索结果都没进过评估。
 */
function faultCopy(admitted: number): string {
  if (admitted > 0) {
    return `AI 模型本轮异常终止，没有评估已找到的 ${admitted} 个候选。资源可能仍在，可在作品详情页「资源」里手动获取。`;
  }
  return "AI 模型本轮没有产出任何可用步骤（上游空响应或报错），本次没有真正检索与评估资源。";
}

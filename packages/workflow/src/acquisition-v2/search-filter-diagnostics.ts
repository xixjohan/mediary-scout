import type { AuditEvent } from "../domain.js";
import type { ResourceSnapshotV2 } from "./fake-provider.js";
import { jevAllDroppedWarning } from "../providers/jev-judge.js";

export function searchSnapshotWarning(snapshot: ResourceSnapshotV2): string | undefined {
  if (snapshot.candidates.length > 0) return undefined;
  const summary = snapshot.filterSummary;
  if (summary && summary.inputCount > 0) {
    const reasons = Object.entries(summary.policyReasons).map(([reason, count]) => `${reason}:${count}`).join("、");
    return `片名预筛后仍有 ${summary.inputCount} 个候选；订阅策略排除 ${summary.policyDropped}${reasons ? `（${reasons}）` : ""}，死链排除 ${summary.deadLinkDropped}，用户拒绝 ${summary.userRejectedDropped}。当前无自动准入候选，不代表资源不存在。请如实报告未命中的规则；不要重复换关键词绕过规则。`;
  }
  const dropped = snapshot.prefilterDropped ?? 0;
  if (dropped === 0) return undefined;
  if (snapshot.sourceHealth && snapshot.sourceHealth.status !== "healthy") {
    return `预筛剔除 ${dropped} 个候选；搜索源状态为 ${snapshot.sourceHealth.status}，不能据此断言资源不存在。`;
  }
  return jevAllDroppedWarning(dropped);
}

/** Only explain a wholly filtered run; any surviving candidate needs its own outcome. */
export function searchFilterFailureReason(events: readonly AuditEvent[]): string | null {
  const filters = events.filter((event) => event.type === "resource_filter_applied");
  if (filters.length === 0 || filters.some((event) => Number(event.data?.["keptCount"]) > 0)) return null;
  if (!filters.some((event) => Number(event.data?.["policyDropped"]) > 0)) return null;
  const reasons = [...new Set(filters.flatMap((event) => {
    const value = event.data?.["policyReasons"];
    return value && typeof value === "object" ? Object.keys(value) : [];
  }))];
  const degraded = filters.some((event) => event.data?.["sourceStatus"] !== "healthy");
  const labels: Record<string, string> = { missing_term: "未满足包含条件", excluded: "命中排除条件", episode_filtered: "不在订阅集数范围", priority_unmatched: "未命中优先级条件", policy: "未满足规则" };
  const descriptions = reasons.map((reason) => labels[reason] ?? "未满足规则");
  return `已有候选未满足订阅规则${descriptions.length ? `（${descriptions.join("、")}）` : ""}，本轮未自动采集。${degraded ? "部分搜索源不可用，结果尚不完整。" : ""}请检查订阅规则或等待来源恢复，不能据此断言资源不存在。`;
}

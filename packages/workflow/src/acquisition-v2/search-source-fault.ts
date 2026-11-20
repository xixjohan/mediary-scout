import type { AuditEvent } from "../domain.js";

/**
 * 搜索源故障判定 —— `transfer-block.ts` 的搜索层孪生兄弟。
 *
 * 那个文件的教义（原话）：把账号级封锁报成「no_coverage / 暂未找到资源」是拿资源
 * 给系统问题背锅（**别甩锅**）。这里是同一件事发生在更早的一层：搜索源连不上时，
 * 一个候选都取不回来，集数算术于是判定 `no_coverage`，用户读到「暂未找到可用
 * 资源」—— 真实案例里这样持续了 6 天，作者本人都被误导了两小时。
 *
 * 从搜索适配层的异常和快照审计，以及沙盒拒绝上报的审计判定故障。
 * 本轮已有可用搜索证据时，保留原有结算。
 */

/** sandbox 拒绝无覆盖上报时写下的审计事件类型。 */
const REFUSED_EVENT = "no_coverage_refused_source_unhealthy";
const FAILED_EVENT = "search_source_failed";
const FILTER_EVENT = "resource_filter_applied";

export interface SearchSourceFault {
  /** 面向用户的一句话，直接进通知。 */
  reason: string;
  /** 哪些源出了问题，用于文案点名。 */
  sources: string[];
  /** 合并后的状态串（unreachable / protocol_error / 混合）。 */
  status: string;
}

/**
 * 从本次运行的审计事件里判定「这轮没覆盖是因为搜索源故障」。
 *
 * 返回 null 表示没有源故障证据 —— 此时「暂未找到资源」是诚实的结论，必须原样保留。
 * 这是本模块最重要的边界：过度判定会让产品再也无法如实报告「确实没有」，
 * 那比它要修的 bug 更糟。
 */
export function classifySearchSourceFault(
  auditEvents: readonly AuditEvent[] | undefined,
): SearchSourceFault | null {
  if (!auditEvents || auditEvents.length === 0) {
    return null;
  }
  const snapshots = auditEvents.filter((event) => event.type === FILTER_EVENT);
  if (auditEvents.some((event) => event.type === "no_coverage_reported") ||
    snapshots.some((event) => ["healthy", "degraded"].includes(String(event.data?.["sourceStatus"])))) {
    return null;
  }
  const failure = auditEvents.find((event) => event.type === FAILED_EVENT && event.data?.["status"] === "auth_error")
    ?? auditEvents.find((event) => event.type === REFUSED_EVENT)
    ?? auditEvents.find((event) => event.type === FAILED_EVENT)
    ?? snapshots.find((event) => ["unreachable", "protocol_error"].includes(String(event.data?.["sourceStatus"])));
  return failure ? describeFailure(failure.data) : null;
}

function describeFailure(data: AuditEvent["data"]): SearchSourceFault {
  const source = data?.["source"];
  const sources = typeof source === "string" ? [source] : stringArray(data?.["unhealthySources"]);
  const status = String(data?.["status"] ?? data?.["sourceStatus"] ?? "unknown");
  return { reason: failureReason(sources, status), sources, status };
}

function failureReason(sources: string[], status: string): string {
  const named = sources.length > 0 ? sources.join("、") : "搜索源";
  if (status === "auth_error") {
    return `${named} 搜索认证失败，本轮未能取得有效搜索结果。请检查搜索源凭据后重试。`;
  }
  // protocol_error 与单纯连不上要给不同建议:前者是「地址指向的东西不是 PanSou」,
  // 用户要去改配置;后者是「源挂了/网络不通」,等恢复或换源。
  const isProtocol = status.includes("protocol_error") && !status.includes("unreachable");
  return isProtocol
    ? `${named} 返回的不是 PanSou 接口格式（地址可能指向了别的服务），本轮没能取回任何候选。请检查搜索源地址后重试。`
    : `${named} 本轮连不上，没能取回任何候选。已按「搜索源不可用」收尾，资源留待源恢复后自动重试。`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

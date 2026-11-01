import type { AgentStepView, AuditEvent } from "@media-track/workflow";

/**
 * 权威活跃工作流实时状态接口 DTO 契约
 * 对应 GET /api/activity/status?tmdbId=xxx 或 ?runId=xxx
 */
export interface AcquiringStatusActiveResponse {
  status: "active";
  active: true;
  runId: string;
  tmdbId: number;
  title: string;
  year: number | null;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
  runStatus: "queued" | "running";
  queuePosition: number | null;
  phase: string;
  percent: number;
  activity: string;
  startedAt: string;
  /** 权威 Agent 工具调用步骤列表（已脱敏，按时间升序） */
  steps: AgentStepView[];
  /** 关键审计事件列表 */
  auditEvents: Array<Pick<AuditEvent, "type" | "message">>;
  cancellable: boolean;
}

export interface AcquiringStatusIdleResponse {
  status: "idle";
  active: false;
}

export type AcquiringStatusResponse = AcquiringStatusActiveResponse | AcquiringStatusIdleResponse;

/**
 * 前端任务详情时间线统一标准化展示项
 */
export interface AcquiringTimelineItem {
  id: string;
  text: string;
  time?: string | undefined;
  toolName?: string | undefined;
  phase?: string | undefined;
  isLatest: boolean;
  source: "agent_step" | "audit_event";
}

function formatStepTime(isoString?: string): string | undefined {
  if (!isoString) return undefined;
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return undefined;
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    const seconds = String(d.getSeconds()).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
  } catch {
    return undefined;
  }
}

/**
 * 统一时间线适配器（Adapter Pattern）
 * 将异构的 AgentStepView 与 AuditEvent 安全转换为统一的 UI 时间线项目，
 * 具备多级防御性回退，彻底根除字段漂移导致空白圆点问题。
 */
export function toAcquiringTimelineItems(
  steps: readonly AgentStepView[] = [],
  auditEvents: ReadonlyArray<{ type: string; message: string }> = [],
): AcquiringTimelineItem[] {
  // 1. 若存在实时 Agent 操作步骤（运行态核心流），优先按执行顺序展现
  if (steps.length > 0) {
    const items: AcquiringTimelineItem[] = steps.map((s, idx) => {
      // 权威字段取 activity，多级防御性降级避免任何可能导致的 undefined 空白
      const text =
        (s.activity && s.activity.trim()) ||
        (s.toolName && `执行工具: ${s.toolName}`) ||
        `步骤 #${s.ordinal !== undefined ? s.ordinal + 1 : idx + 1}`;

      return {
        id: `step-${s.ordinal ?? idx}-${s.at || idx}`,
        text,
        time: formatStepTime(s.at),
        toolName: s.toolName,
        phase: s.phase,
        isLatest: idx === steps.length - 1,
        source: "agent_step",
      };
    });
    return items;
  }

  // 2. 若暂无 Agent 步骤（如处于 queued 调度排队阶段），安全降级为关键审计事件
  if (auditEvents.length > 0) {
    const items: AcquiringTimelineItem[] = auditEvents.map((a, idx) => {
      const text = (a.message && a.message.trim()) || (a.type && `事件: ${a.type}`) || "系统调度记录";
      return {
        id: `audit-${idx}-${a.type || "evt"}`,
        text,
        time: undefined,
        toolName: undefined,
        phase: undefined,
        isLatest: idx === auditEvents.length - 1,
        source: "audit_event",
      };
    });
    return items;
  }

  return [];
}

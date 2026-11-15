"use client";

import type { AgentStepView } from "@media-track/workflow";

/**
 * agent 工具调用时间线（W4 L1）。
 *
 * 用原生 <details> 而不是受控 state：默认折叠（一次运行几十到几百步，全展开会把
 * 活动页变成一片字），展开是渐进披露，且不引入任何 JS 状态就能用键盘操作。
 *
 * 只渲染**已脱敏**的字段：`args` 在服务端读取边界就替换过了（agent-step-view.ts），
 * 这里不再做任何「保险起见」的二次过滤——那是重复的安全逻辑，两处各错一半比一处
 * 全错更难发现。唯一的前端职责是不把 args 里的值当链接渲染：candidateId 之类是
 * 不透明句柄，不是 URL。
 */
export function AgentTimeline({ steps }: { steps: AgentStepView[] }) {
  if (steps.length === 0) return null;

  return (
    <details className="agent-timeline">
      <summary>
        工具调用记录 <span className="agent-timeline-count">{steps.length}</span> 条
      </summary>
      <ol className="agent-timeline-list">
        {steps.map((step) => (
          <li key={`${step.ordinal}-${step.at}`} className="agent-timeline-item">
            <span className="agent-timeline-ordinal">#{step.ordinal}</span>
            <span className="agent-timeline-tool">{step.toolName}</span>
            <span className="agent-timeline-activity">{step.activity}</span>
            {step.apiCalls !== undefined && (
              <span className="agent-timeline-calls" title="该工具开始前累计的网盘 API 调用（guard 计数，非模型请求数）">
                网盘 API 累计 {step.apiCalls} 次
              </span>
            )}
            {step.downloadApiCalls !== undefined && (
              <span
                className="agent-timeline-calls agent-timeline-calls-download"
                title="其中有月度限额的下载类调用（直链解析／http 离线任务／离线任务管理）。平台侧额度未知，此处仅统计本次任务内的调用次数"
              >
                下载类 {step.downloadApiCalls} 次
              </span>
            )}
            {step.status !== undefined && (
              <span
                className={`agent-timeline-status agent-timeline-status-${step.status}`}
                title={step.error ?? (step.status === "failed" ? "工具执行失败" : "工具执行成功")}
              >
                {step.status === "failed" ? "失败" : "成功"}
              </span>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

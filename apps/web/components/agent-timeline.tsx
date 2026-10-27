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
        agent 步骤 <span className="agent-timeline-count">{steps.length}</span>
      </summary>
      <ol className="agent-timeline-list">
        {steps.map((step) => (
          <li key={`${step.ordinal}-${step.at}`} className="agent-timeline-item">
            <span className="agent-timeline-ordinal">#{step.ordinal}</span>
            <span className="agent-timeline-tool">{step.toolName}</span>
            <span className="agent-timeline-activity">{step.activity}</span>
            {step.apiCalls !== undefined && (
              <span className="agent-timeline-calls">{step.apiCalls} 次调用</span>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

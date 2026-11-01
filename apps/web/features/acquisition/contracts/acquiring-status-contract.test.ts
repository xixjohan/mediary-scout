import { describe, it, expect } from "vitest";
import {
  toAcquiringTimelineItems,
  type AcquiringTimelineItem,
} from "./acquiring-status-contract";
import type { AgentStepView } from "@media-track/workflow";

describe("toAcquiringTimelineItems 状态与时间线适配器测试", () => {
  it("当步骤与审计事件均为空时，返回空数组", () => {
    const items = toAcquiringTimelineItems([], []);
    expect(items).toEqual([]);
  });

  it("排队状态 (queued): 步骤为空但审计事件存在时，安全展现审计记录且文字非空", () => {
    const auditEvents = [
      { type: "task_enqueued", message: "任务已进入队列，等待 Worker 调度" },
      { type: "storage_selected", message: "已自动绑定默认 115 网盘工作区" },
    ];

    const items = toAcquiringTimelineItems([], auditEvents);
    expect(items).toHaveLength(2);
    expect(items[0]!.text).toBe("任务已进入队列，等待 Worker 调度");
    expect(items[0]!.source).toBe("audit_event");
    expect(items[0]!.isLatest).toBe(false);

    expect(items[1]!.text).toBe("已自动绑定默认 115 网盘工作区");
    expect(items[1]!.source).toBe("audit_event");
    expect(items[1]!.isLatest).toBe(true);
  });

  it("运行状态 (running): 存在 Agent 工具调用步骤时，必须正确提取 activity 且绝不依赖 headline", () => {
    const agentSteps: AgentStepView[] = [
      {
        ordinal: 0,
        toolName: "readSkill",
        activity: "正在查阅操作手册…",
        phase: "search",
        at: "2026-11-01T12:00:00.000Z",
        args: {},
      },
      {
        ordinal: 1,
        toolName: "viewResourceSnapshot",
        activity: "正在浏览候选资源…",
        phase: "search",
        at: "2026-11-01T12:00:02.000Z",
        args: {},
      },
      {
        ordinal: 2,
        toolName: "searchResources",
        activity: "正在搜索资源: 阿凡达",
        phase: "search",
        at: "2026-11-01T12:00:05.000Z",
        args: { keyword: "阿凡达" },
      },
      {
        ordinal: 3,
        toolName: "searchResources",
        activity: "正在搜索资源: 阿凡达 1080p",
        phase: "search",
        at: "2026-11-01T12:00:08.000Z",
        args: { keyword: "阿凡达 1080p" },
      },
    ];

    const items = toAcquiringTimelineItems(agentSteps, []);
    expect(items).toHaveLength(4);

    // 验证文字非空且 100% 对应 activity
    expect(items[0]!.text).toBe("正在查阅操作手册…");
    expect(items[1]!.text).toBe("正在浏览候选资源…");
    expect(items[2]!.text).toBe("正在搜索资源: 阿凡达");
    expect(items[3]!.text).toBe("正在搜索资源: 阿凡达 1080p");

    // 验证时间戳与最新高亮标记
    expect(items[0]!.time).toBeDefined();
    expect(items[3]!.isLatest).toBe(true);
    expect(items[0]!.isLatest).toBe(false);
  });

  it("多级防御性回退: 当 activity 丢失或为空时，优雅降级为工具名称或序号，绝不返回空白", () => {
    const corruptedSteps: AgentStepView[] = [
      {
        ordinal: 0,
        toolName: "customToolX",
        activity: "", // 模拟极端情况：activity 为空字符串
        phase: "pick",
        at: "2026-11-01T12:00:10.000Z",
        args: {},
      },
      {
        ordinal: 1,
        toolName: "",
        activity: "   ", // 模拟纯空格
        phase: "transfer",
        at: "2026-11-01T12:00:12.000Z",
        args: {},
      },
    ];

    const items = toAcquiringTimelineItems(corruptedSteps, []);
    expect(items).toHaveLength(2);
    expect(items[0]!.text).toBe("执行工具: customToolX");
    expect(items[1]!.text).toBe("步骤 #2");
  });

  it("审计事件多级防御: 当 auditEvent 的 message 为空时，优雅降级为事件类型", () => {
    const corruptedAudits = [
      { type: "stage_commit_started", message: "" },
    ];

    const items = toAcquiringTimelineItems([], corruptedAudits);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe("事件: stage_commit_started");
  });
});

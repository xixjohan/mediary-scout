"use client";

import { Clock, FolderSync, History, Pause, Pencil, Play, RefreshCw, Trash2 } from "lucide-react";
import type { StrmDeliveryMode, StrmScanMode, StrmTask } from "@media-track/workflow";

export interface StrmTaskCardProps {
  task: StrmTask;
  isRunning: boolean;
  onOpenRecords: (task: StrmTask) => void;
  onRun: (taskId: string) => void;
  onEdit: (task: StrmTask) => void;
  onDelete: (taskId: string, name: string) => void;
  onToggleActive: (task: StrmTask) => void;
}

function resolveScanModeLabel(mode: StrmScanMode): string {
  if (mode === "incremental_missing") return "增量补缺";
  if (mode === "full_sync") return "全量镜像";
  return "增量更新";
}

function DeliveryModeBadge({ deliveryMode }: { deliveryMode?: StrmDeliveryMode | undefined }) {
  const isRedirect = (deliveryMode ?? "redirect") === "redirect";
  return (
    <span
      style={{
        fontSize: "0.75rem",
        padding: "0.15rem 0.5rem",
        borderRadius: "999px",
        background: isRedirect ? "rgba(59, 130, 246, 0.2)" : "rgba(168, 85, 247, 0.2)",
        color: isRedirect ? "#60a5fa" : "#c084fc",
        fontWeight: 600,
      }}
    >
      {isRedirect ? "302 重定向" : "代理直链"}
    </span>
  );
}

function TaskStatusBadge({ isRunning, isPaused }: { isRunning: boolean; isPaused: boolean }) {
  let label = "已就绪";
  let bg = "rgba(34, 197, 94, 0.2)";
  let color = "#4ade80";

  if (isRunning) {
    label = "扫描中";
    bg = "rgba(234, 179, 8, 0.2)";
    color = "#facc15";
  } else if (isPaused) {
    label = "已暂停";
    bg = "rgba(107, 114, 128, 0.2)";
    color = "#9ca3af";
  }

  return (
    <span style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem", borderRadius: "999px", background: bg, color }}>
      {label}
    </span>
  );
}

export function StrmTaskCard({
  task,
  isRunning,
  onOpenRecords,
  onRun,
  onEdit,
  onDelete,
  onToggleActive,
}: StrmTaskCardProps) {
  const isPaused = !task.isActive || task.status === "paused";

  return (
    <div
      style={{
        background: "var(--bg-card, #1e1e1e)",
        border: "1px solid var(--border, #333)",
        borderRadius: "10px",
        padding: "1.25rem",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        opacity: isPaused ? 0.75 : 1,
        transition: "all 0.2s ease",
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.35rem" }}>
          <FolderSync size={18} style={{ color: isPaused ? "#888" : "#3b82f6" }} />
          <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>{task.name}</h3>
          <DeliveryModeBadge deliveryMode={task.deliveryMode} />
          <TaskStatusBadge isRunning={isRunning} isPaused={isPaused} />
        </div>

        <div style={{ fontSize: "0.85rem", color: "#aaa", display: "grid", gap: "0.25rem" }}>
          <div>
            网盘路径：
            <code style={{ background: "#2a2a2a", padding: "0.1rem 0.3rem", borderRadius: "4px" }}>
              {task.remotePath}
            </code>
            {" → "}
            本地输出：
            <code style={{ background: "#2a2a2a", padding: "0.1rem 0.3rem", borderRadius: "4px" }}>
              {task.localOutputDir}
            </code>
          </div>
          <div>
            模式：{resolveScanModeLabel(task.scanMode)} · 扫描间隔：每 {task.scanIntervalMinutes} 分钟 · 最小文件：
            {task.minFileSizeMb}MB
          </div>
          {task.lastScanAt && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem", color: "#888" }}>
              <Clock size={12} /> 上次扫描：{new Date(task.lastScanAt).toLocaleString()} ({task.lastScanStatus || "完成"})
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onToggleActive(task)}
          disabled={isRunning}
          title={isPaused ? "启用定时调度" : "暂停定时调度"}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", color: isPaused ? "#22c55e" : "#eab308" }}
        >
          {isPaused ? <Play size={14} /> : <Pause size={14} />}
          {isPaused ? "启用" : "暂停"}
        </button>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onEdit(task)}
          disabled={isRunning}
          title={isRunning ? "扫描中禁止修改配置" : "编辑任务参数"}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}
        >
          <Pencil size={13} /> 编辑
        </button>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onOpenRecords(task)}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}
        >
          <History size={13} /> 记录
        </button>

        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={isRunning}
          onClick={() => onRun(task.id)}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}
        >
          {isRunning ? (
            <>
              <RefreshCw size={13} className="animate-spin" /> 扫描中
            </>
          ) : (
            <>
              <Play size={13} /> 立即扫描
            </>
          )}
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={isRunning}
          onClick={() => onDelete(task.id, task.name)}
          title="删除 STRM 任务"
          style={{ padding: "0.4rem", color: isRunning ? "#555" : "#ef4444" }}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}

"use client";

import {
  ExternalLink,
  LoaderCircle,
  Play,
  Server,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";

import type { FrpTunnelLogItem } from "@media-track/shared";

export interface FrpTunnelLineViewItem {
  id: string;
  name: string;
  serverUrl: string;
  tunnelHost: string;
  localTargetUrl: string;
  autoStart: boolean;
  state: "Disconnected" | "Connecting" | "Connected" | "Reconnecting" | "Degraded";
  publicUrl: string | null;
  lastConnectedAt: string | null;
  connectedAt: string | null;
  sentBytes: number;
  receivedBytes: number;
  activeMediaStreamsCount?: number;
  lastError: string | null;
  recentLogs?: FrpTunnelLogItem[];
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function renderStateBadge(state: string) {
  if (state === "Connected") {
    return <span className="badge is-on">已连接</span>;
  }
  if (state === "Connecting" || state === "Reconnecting") {
    return <span className="badge is-warn">重连中</span>;
  }
  return <span className="badge is-error">已停止</span>;
}

export function FrpTunnelLineCard({
  line,
  isOperating,
  onOpenLogs,
  onToggleStartStop,
  onDelete,
}: {
  line: FrpTunnelLineViewItem;
  isOperating: boolean;
  onOpenLogs: () => void;
  onToggleStartStop: () => void;
  onDelete: () => void;
}) {
  const isRunning = line.state === "Connected" || line.state === "Connecting" || line.state === "Reconnecting";

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "8px",
        padding: "1rem 1.25rem",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "1rem",
      }}
    >
      <div style={{ display: "grid", gap: "0.4rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <Server size={16} />
          <strong style={{ fontSize: "1rem" }}>{line.name || line.id}</strong>

          {renderStateBadge(line.state)}

          {line.publicUrl && (
            <a
              href={line.publicUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary btn-sm"
              style={{
                fontSize: "0.78rem",
                padding: "0.15rem 0.45rem",
                display: "inline-flex",
                alignItems: "center",
                gap: "0.25rem",
              }}
            >
              {line.publicUrl} <ExternalLink size={12} />
            </a>
          )}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "1rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
          <span>服务器: <code>{line.serverUrl || "默认"}</code></span>
          <span>域名: <code>{line.tunnelHost || "auto"}</code></span>
          <span>上行流量: {formatBytes(line.sentBytes)}</span>
          <span>下行流量: {formatBytes(line.receivedBytes)}</span>
          {typeof line.activeMediaStreamsCount === "number" && (
            <span>活动流: {line.activeMediaStreamsCount} 路</span>
          )}
          {line.connectedAt && (
            <span>连通时间: {new Date(line.connectedAt).toLocaleTimeString()}</span>
          )}
        </div>

        {line.lastError && (
          <div style={{ fontSize: "0.8rem", color: "var(--color-danger, #ef4444)" }}>
            异常提示: {line.lastError}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onOpenLogs}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
        >
          <Terminal size={14} /> 运行日志
        </button>

        <button
          type="button"
          className={`btn ${isRunning ? "btn-secondary" : "btn-primary"} btn-sm`}
          disabled={isOperating}
          onClick={onToggleStartStop}
          style={{ minWidth: 64, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "0.25rem" }}
        >
          {isOperating ? (
            <LoaderCircle size={14} className="animate-spin" />
          ) : isRunning ? (
            <>
              <Square size={13} /> 停止
            </>
          ) : (
            <>
              <Play size={13} /> 启动
            </>
          )}
        </button>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={isOperating}
          onClick={onDelete}
          style={{ color: "var(--color-danger, #ef4444)" }}
          title="删除线路"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

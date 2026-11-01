"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw } from "lucide-react";

interface StrmRecordsDialogProps {
  task: { id: string; name: string };
  records: any[];
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

function renderTriggerBadge(source: string) {
  const isPinpoint = source === "pinpoint_ingest";
  const isManual = source === "manual";
  return (
    <span
      style={{
        padding: "0.15rem 0.4rem",
        borderRadius: "4px",
        fontSize: "0.75rem",
        background: isPinpoint
          ? "rgba(168, 85, 247, 0.2)"
          : isManual
            ? "rgba(59, 130, 246, 0.2)"
            : "rgba(107, 114, 128, 0.2)",
        color: isPinpoint ? "#c084fc" : isManual ? "#60a5fa" : "#9ca3af",
      }}
    >
      {isPinpoint ? "入库联动" : isManual ? "手动触发" : "定时调度"}
    </span>
  );
}

function renderStatusBadge(status: string) {
  const isOk = status === "succeeded";
  const isRunning = status === "running";
  return (
    <span
      style={{
        padding: "0.15rem 0.4rem",
        borderRadius: "4px",
        fontSize: "0.75rem",
        background: isOk
          ? "rgba(34, 197, 94, 0.2)"
          : isRunning
            ? "rgba(234, 179, 8, 0.2)"
            : "rgba(239, 68, 68, 0.2)",
        color: isOk ? "#4ade80" : isRunning ? "#facc15" : "#f87171",
      }}
    >
      {isOk ? "成功" : isRunning ? "运行中" : "失败"}
    </span>
  );
}

export function StrmRecordsDialog({
  task,
  records,
  loading,
  onRefresh,
  onClose,
}: StrmRecordsDialogProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        backdropFilter: "blur(6px)",
        padding: "1rem",
      }}
    >
      <div
        style={{
          background: "var(--bg-base, #18181b)",
          border: "1px solid var(--border, #333)",
          borderRadius: "12px",
          padding: "1.5rem",
          width: "100%",
          maxWidth: "780px",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1rem",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600 }}>
              执行记录 · {task.name}
            </h3>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "#888" }}>
              查看该任务的历史执行状态、耗时统计与实时扫描进度
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onRefresh}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            刷新
          </button>
        </div>

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            border: "1px solid #333",
            borderRadius: "8px",
            background: "#141416",
          }}
        >
          {records.length === 0 ? (
            <div style={{ padding: "3rem", textAlign: "center", color: "#666" }}>
              {loading ? "正在载入记录..." : "暂无执行记录"}
            </div>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.85rem",
                textAlign: "left",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid #333", background: "#1f1f23", color: "#aaa" }}>
                  <th style={{ padding: "0.6rem 0.8rem" }}>时间</th>
                  <th style={{ padding: "0.6rem 0.8rem" }}>触发源</th>
                  <th style={{ padding: "0.6rem 0.8rem" }}>状态</th>
                  <th style={{ padding: "0.6rem 0.8rem" }}>进度 / 阶段</th>
                  <th style={{ padding: "0.6rem 0.8rem" }}>统计 (扫/增/改/删)</th>
                  <th style={{ padding: "0.6rem 0.8rem" }}>耗时</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid #28282c" }}>
                    <td style={{ padding: "0.6rem 0.8rem", color: "#ccc", whiteSpace: "nowrap" }}>
                      {new Date(r.startedAt).toLocaleString()}
                    </td>
                    <td style={{ padding: "0.6rem 0.8rem" }}>
                      {renderTriggerBadge(r.triggerSource)}
                    </td>
                    <td style={{ padding: "0.6rem 0.8rem" }}>
                      {renderStatusBadge(r.status)}
                    </td>
                    <td style={{ padding: "0.6rem 0.8rem", maxWidth: "200px" }}>
                      {r.status === "running" && (
                        <div
                          style={{
                            width: "100%",
                            height: "4px",
                            background: "#333",
                            borderRadius: "2px",
                            overflow: "hidden",
                            marginBottom: "0.3rem",
                          }}
                        >
                          <div
                            style={{
                              width: `${r.currentProgressPercent}%`,
                              height: "100%",
                              background: "#3b82f6",
                              transition: "width 0.3s ease",
                            }}
                          />
                        </div>
                      )}
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: "#aaa",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={r.currentStepMessage || r.errorMessage || ""}
                      >
                        {r.currentStepMessage || (r.errorMessage ? `错误: ${r.errorMessage}` : "-")}
                      </div>
                    </td>
                    <td style={{ padding: "0.6rem 0.8rem", color: "#ddd" }}>
                      {r.scannedCount} / +{r.generatedCount} / ~{r.updatedCount} / -{r.removedCount}
                    </td>
                    <td style={{ padding: "0.6rem 0.8rem", color: "#888", whiteSpace: "nowrap" }}>
                      {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem" }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

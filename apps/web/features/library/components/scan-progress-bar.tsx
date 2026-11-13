"use client";

import { CheckCircle2, AlertCircle, Loader2, RefreshCw } from "lucide-react";
import type { LibraryScanProgressEvent } from "@media-track/contracts";

export function ScanProgressBar({
  event,
  onDismiss,
}: {
  event: LibraryScanProgressEvent | null;
  onDismiss?: () => void;
}) {
  if (!event) return null;

  const isCompleted = event.stage === "COMPLETED";
  const isFailed = event.stage === "FAILED";
  const isAborted = event.stage === "ABORTED";
  const isScanning = !isCompleted && !isFailed && !isAborted;

  return (
    <div
      style={{
        background: "var(--bg-surface, #1e1e24)",
        border: `1px solid ${isFailed ? "rgba(239, 68, 68, 0.4)" : isCompleted ? "rgba(34, 197, 94, 0.4)" : "var(--border, #333)"}`,
        borderRadius: "10px",
        padding: "0.85rem 1.25rem",
        marginBottom: "1.25rem",
        boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {isScanning && <Loader2 size={16} className="animate-spin" style={{ color: "var(--accent, #22c55e)" }} />}
          {isCompleted && <CheckCircle2 size={16} style={{ color: "#22c55e" }} />}
          {isFailed && <AlertCircle size={16} style={{ color: "#ef4444" }} />}
          {isAborted && <AlertCircle size={16} style={{ color: "#f59e0b" }} />}
          <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>
            {event.message}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem" }}>
          <span style={{ fontSize: "0.85rem", color: "var(--text-muted, #a1a1aa)", fontWeight: 500 }}>
            {event.percent}%
          </span>
          {(isCompleted || isFailed || isAborted) && onDismiss && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onDismiss}
              style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem" }}
            >
              关闭
            </button>
          )}
        </div>
      </div>

      {/* 进度条轨道 */}
      <div
        style={{
          width: "100%",
          height: "6px",
          background: "rgba(255, 255, 255, 0.1)",
          borderRadius: "999px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${event.percent}%`,
            height: "100%",
            background: isFailed ? "#ef4444" : "var(--accent, #22c55e)",
            transition: "width 0.3s ease",
            borderRadius: "999px",
          }}
        />
      </div>

      {event.currentTitle && isScanning && (
        <div style={{ marginTop: "0.4rem", fontSize: "0.75rem", color: "var(--text-muted, #a1a1aa)" }}>
          当前处理: <strong style={{ color: "var(--text, #f4f4f5)" }}>{event.currentTitle}</strong>
          {event.totalDiscovered > 0 && ` (${event.processedCount}/${event.totalDiscovered})`}
        </div>
      )}
    </div>
  );
}


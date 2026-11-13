"use client";

import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";
import type { BatchRematchResponse } from "@media-track/contracts";

export interface AiBatchReportModalProps {
  report: BatchRematchResponse;
  onClose: () => void;
}

export function AiBatchReportModal({ report, onClose }: AiBatchReportModalProps) {
  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.8)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "1rem",
      }}
    >
      <div
        style={{
          background: "var(--bg-surface, #18181b)",
          border: "1px solid var(--border, #333)",
          borderRadius: "14px",
          padding: "1.5rem",
          maxWidth: "540px",
          width: "100%",
          maxHeight: "80vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0, color: "var(--text, #f4f4f5)", display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <Sparkles size={18} style={{ color: "var(--accent, #22c55e)" }} /> AI 智能批量匹配报告
          </h3>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            style={{ padding: "0.25rem" }}
          >
            <X size={16} />
          </button>
        </div>

        <p style={{ fontSize: "0.88rem", color: "var(--text-muted, #a1a1aa)", marginBottom: "1rem" }}>
          共处理 {report.total} 部影视：成功精准匹配 <strong style={{ color: "#4ade80" }}>{report.succeeded}</strong> 部，未搜寻到匹配 <strong style={{ color: "#ef4444" }}>{report.failed}</strong> 部。
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "1.25rem" }}>
          {report.results.map((r) => (
            <div
              key={r.id}
              style={{
                padding: "0.6rem 0.8rem",
                borderRadius: "6px",
                background: r.success ? "rgba(34, 197, 94, 0.08)" : "rgba(239, 68, 68, 0.08)",
                border: `1px solid ${r.success ? "rgba(34, 197, 94, 0.25)" : "rgba(239, 68, 68, 0.25)"}`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: "0.82rem",
              }}
            >
              <span style={{ fontWeight: 600, color: "var(--text, #f4f4f5)" }}>
                {r.title || r.id}
              </span>
              <span style={{ color: r.success ? "#4ade80" : "#ef4444" }}>
                {r.success ? "✓ 匹配成功" : `✗ ${r.error || "未匹配"}`}
              </span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onClose}
            style={{ padding: "0.4rem 1.25rem" }}
          >
            好的
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

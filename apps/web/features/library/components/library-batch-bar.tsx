"use client";

import { Sparkles, Check, Trash2 } from "lucide-react";

export interface LibraryBatchBarProps {
  selectedCount: number;
  batchProcessing: boolean;
  confirmDelete: boolean;
  onBatchRematch: () => void;
  onBatchAccept: () => void;
  onBatchDelete: () => void;
  onCancel: () => void;
}

export function LibraryBatchBar({
  selectedCount,
  batchProcessing,
  confirmDelete,
  onBatchRematch,
  onBatchAccept,
  onBatchDelete,
  onCancel,
}: LibraryBatchBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: "2rem",
        left: "50%",
        transform: "translateX(-50%)",
        background: "rgba(24, 24, 27, 0.95)",
        backdropFilter: "blur(12px)",
        border: "1px solid var(--accent, #22c55e)",
        boxShadow: "0 20px 30px -10px rgba(0, 0, 0, 0.8)",
        borderRadius: "30px",
        padding: "0.6rem 1.25rem",
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        zIndex: 9990,
      }}
    >
      <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text, #f4f4f5)" }}>
        已选 <span style={{ color: "var(--accent, #22c55e)" }}>{selectedCount}</span> 项
      </span>

      <div style={{ display: "flex", gap: "0.45rem" }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={batchProcessing}
          onClick={onBatchRematch}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", borderRadius: "20px", padding: "0.3rem 0.85rem", fontSize: "0.8rem" }}
        >
          <Sparkles size={13} className={batchProcessing ? "animate-spin" : ""} />
          {batchProcessing ? "AI 匹配中..." : "AI 智能匹配"}
        </button>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={batchProcessing}
          onClick={onBatchAccept}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", borderRadius: "20px", padding: "0.3rem 0.85rem", fontSize: "0.8rem" }}
        >
          <Check size={13} /> 标为已审核
        </button>

        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={batchProcessing}
          onClick={onBatchDelete}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", borderRadius: "20px", padding: "0.3rem 0.85rem", fontSize: "0.8rem" }}
        >
          <Trash2 size={13} /> {confirmDelete ? "二次确认移出" : "移出库"}
        </button>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onCancel}
          style={{ borderRadius: "20px", padding: "0.3rem 0.65rem", fontSize: "0.8rem" }}
        >
          取消
        </button>
      </div>
    </div>
  );
}

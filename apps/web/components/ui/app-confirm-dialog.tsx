"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, AlertTriangle, X } from "lucide-react";

export interface ConfirmDialogSpec {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDanger?: boolean;
  hideCancel?: boolean;
}

export function AppConfirmDialog({
  spec,
  isPending = false,
  onConfirm,
  onCancel,
}: {
  spec: ConfirmDialogSpec | null;
  isPending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!spec) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isPending) {
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [spec, isPending, onCancel]);

  useEffect(() => {
    if (!spec) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [spec]);

  if (!spec || !mounted) return null;

  return createPortal(
    <div
      className="modal-backdrop app-confirm-backdrop"
      onClick={isPending ? undefined : onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-confirm-title"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.72)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "16px",
        animation: "fadeIn 0.15s ease-out",
      }}
    >
      <div
        className="panel app-confirm-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "420px",
          borderRadius: "14px",
          border: `1px solid ${spec.isDanger ? "rgba(239, 68, 68, 0.3)" : "var(--border)"}`,
          backgroundColor: "var(--bg-card)",
          color: "var(--text)",
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.65)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "18px 20px 14px",
            borderBottom: "1px solid var(--border-subtle)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            {spec.isDanger ? (
              <AlertTriangle size={18} style={{ color: "var(--color-danger)" }} />
            ) : (
              <AlertCircle size={18} style={{ color: "var(--accent)" }} />
            )}
            <h3
              id="app-confirm-title"
              style={{
                margin: 0,
                fontSize: "16px",
                fontWeight: 600,
                color: spec.isDanger ? "#fca5a5" : "var(--text)",
              }}
            >
              {spec.title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            aria-label="关闭"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: isPending ? "not-allowed" : "pointer",
              padding: "4px",
            }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: "18px 20px" }}>
          <p
            style={{
              margin: 0,
              fontSize: "13.5px",
              lineHeight: 1.6,
              color: "var(--text)",
              whiteSpace: "pre-line",
            }}
          >
            {spec.description}
          </p>
        </div>

        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--border-subtle)",
            backgroundColor: "rgba(0, 0, 0, 0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: "10px",
          }}
        >
          {!spec.hideCancel && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onCancel}
              disabled={isPending}
            >
              {spec.cancelLabel || "取消"}
            </button>
          )}
          <button
            type="button"
            className={`btn ${spec.isDanger ? "btn-danger" : "btn-primary"} btn-sm`}
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? "处理中..." : spec.confirmLabel || "确认"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

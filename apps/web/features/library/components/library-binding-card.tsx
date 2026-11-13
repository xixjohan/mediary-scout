"use client";

import { Wifi, Play, Trash2, Check, AlertCircle } from "lucide-react";
import type { LibraryPathBinding } from "@media-track/contracts";

export interface LibraryBindingCardProps {
  binding: LibraryPathBinding;
  isTesting: boolean;
  testResult?: { success: boolean; latencyMs?: number; fileCount?: number; error?: string } | undefined;
  isConfirmDelete: boolean;
  onTest: (bindingId: string) => void;
  onTriggerScan?: ((bindingId: string) => void) | undefined;
  onConfirmDeleteChange: (bindingId: string | null) => void;
  onDelete: (bindingId: string) => void;
  onUpdateConfig: (binding: LibraryPathBinding, patch: Partial<LibraryPathBinding>) => void;
  onCloseParentModal: () => void;
}

function resolveDeliveryLabel(deliveryMode: LibraryPathBinding["deliveryMode"]): string {
  if (deliveryMode === "redirect") return "302直连";
  if (deliveryMode === "proxy") return "代理中继";
  return "继承库";
}

function resolveDeliveryColor(deliveryMode: LibraryPathBinding["deliveryMode"]): string {
  if (deliveryMode === "redirect") return "#4ade80";
  if (deliveryMode === "proxy") return "#60a5fa";
  return "inherit";
}

interface TestResultBadgeProps {
  testResult?: { success: boolean; latencyMs?: number; fileCount?: number; error?: string } | undefined;
}

function TestResultBadge({ testResult }: TestResultBadgeProps) {
  if (!testResult) return null;

  return (
    <div
      style={{
        fontSize: "0.75rem",
        padding: "0.35rem 0.65rem",
        borderRadius: "6px",
        background: testResult.success ? "rgba(34, 197, 94, 0.1)" : "rgba(239, 68, 68, 0.1)",
        border: `1px solid ${testResult.success ? "rgba(34, 197, 94, 0.25)" : "rgba(239, 68, 68, 0.25)"}`,
        color: testResult.success ? "#4ade80" : "#ef4444",
        display: "flex",
        alignItems: "center",
        gap: "0.4rem",
      }}
    >
      {testResult.success ? (
        <>
          <Check size={13} />
          <span>连通正常 (响应耗时 {testResult.latencyMs}ms · 目录有效项目数: {testResult.fileCount ?? 0})</span>
        </>
      ) : (
        <>
          <AlertCircle size={13} />
          <span>连通异常: {testResult.error}</span>
        </>
      )}
    </div>
  );
}

export function LibraryBindingCard({
  binding: b,
  isTesting,
  testResult,
  isConfirmDelete,
  onTest,
  onTriggerScan,
  onConfirmDeleteChange,
  onDelete,
  onUpdateConfig,
  onCloseParentModal,
}: LibraryBindingCardProps) {
  const deliveryLabel = resolveDeliveryLabel(b.deliveryMode);
  const deliveryColor = resolveDeliveryColor(b.deliveryMode);

  return (
    <div
      style={{
        background: "rgba(255, 255, 255, 0.03)",
        border: "1px solid var(--border-subtle, #27272a)",
        borderRadius: "10px",
        padding: "1rem 1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
      }}
    >
      {/* 卡片头部：路径信息与操作 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: "0.76rem",
              fontWeight: 600,
              padding: "0.15rem 0.5rem",
              borderRadius: "4px",
              background: "rgba(255, 255, 255, 0.08)",
              color: "var(--text, #f4f4f5)",
            }}
          >
            {b.storageId}
          </span>
          <span style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--text, #f4f4f5)" }}>
            {b.remotePath}
          </span>
          <span style={{ fontSize: "0.74rem", padding: "0.1rem 0.4rem", borderRadius: "3px", background: "rgba(255,255,255,0.06)", color: "var(--text-muted, #a1a1aa)" }}>
            CID: {b.remoteFolderId}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={isTesting}
            onClick={() => onTest(b.id)}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", fontSize: "0.75rem", padding: "0.25rem 0.55rem" }}
            title="测试此网盘目录连通性与延迟"
          >
            <Wifi size={12} className={isTesting ? "animate-pulse" : ""} />
            {isTesting ? "探测中..." : "测试连通性"}
          </button>

          {onTriggerScan && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                onTriggerScan(b.id);
                onCloseParentModal();
              }}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", fontSize: "0.75rem", padding: "0.25rem 0.55rem" }}
              title="单独扫描此目录"
            >
              <Play size={12} /> 立即扫描
            </button>
          )}

          {isConfirmDelete && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onConfirmDeleteChange(null)}
              style={{ padding: "0.25rem 0.55rem", fontSize: "0.75rem" }}
            >
              取消
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => onDelete(b.id)}
            style={{ padding: "0.25rem 0.55rem", fontSize: "0.75rem" }}
            title="解绑此路径并自动清理影视库条目"
          >
            {isConfirmDelete ? "确定解绑？" : <Trash2 size={13} />}
          </button>
        </div>
      </div>

      {/* 连通性测试结果提示 */}
      <TestResultBadge testResult={testResult} />

      {/* 独立策略芯片控制条 */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "1rem", fontSize: "0.78rem", color: "var(--text-muted, #a1a1aa)" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", cursor: "pointer", color: "var(--text, #f4f4f5)" }}>
          <input
            type="checkbox"
            checked={b.scheduledScanEnabled}
            onChange={(e) => onUpdateConfig(b, { scheduledScanEnabled: e.target.checked })}
          />
          自动定时扫描 ({b.scanIntervalMinutes} 分钟)
        </label>

        <span style={{ color: "var(--border, #444)" }}>|</span>

        <span>
          模式: <strong style={{ color: "var(--text, #f4f4f5)" }}>{b.scanMode === "incremental_missing" ? "增量补缺" : "全量深扫"}</strong>
        </span>

        <span style={{ color: "var(--border, #444)" }}>|</span>

        <span>
          过滤: &ge; {b.minFileSizeMb} MB
        </span>

        <span style={{ color: "var(--border, #444)" }}>|</span>

        <span>
          投送: <strong style={{ color: deliveryColor }}>
            {deliveryLabel}
          </strong>
        </span>
      </div>
    </div>
  );
}

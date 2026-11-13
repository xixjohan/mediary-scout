"use client";

import { useState } from "react";
import { X, FolderOpen } from "lucide-react";
import type { BindingDeliveryMode, LibraryScanMode } from "@media-track/contracts";
import type { ConnectedStorageView } from "../../../lib/workflow-runtime";

export interface LibraryAddPathFormProps {
  libraryId: string;
  storages: ConnectedStorageView[];
  onCancel: () => void;
  onSuccess: () => void;
  onOpenFolderPicker: (storageId: string, folderId: string) => void;
  selectedRemoteFolderId: string;
  selectedRemotePath: string;
}

export function LibraryAddPathForm({
  libraryId,
  storages,
  onCancel,
  onSuccess,
  onOpenFolderPicker,
  selectedRemoteFolderId,
  selectedRemotePath,
}: LibraryAddPathFormProps) {
  const [storageId, setStorageId] = useState(storages[0]?.id || "");
  const [scheduledScan, setScheduledScan] = useState(true);
  const [interval, setInterval] = useState(360);
  const [scanMode, setScanMode] = useState<LibraryScanMode>("incremental_missing");
  const [minSize, setMinSize] = useState(100);
  const [excludeKeywords] = useState("sample,trailer");
  const [deliveryMode, setDeliveryMode] = useState<BindingDeliveryMode>("inherit");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storageId) return;
    setSubmitting(true);
    try {
      const keywords = excludeKeywords.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await fetch(`/api/library/${libraryId}/paths`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageId,
          remoteFolderId: selectedRemoteFolderId,
          remotePath: selectedRemotePath,
          scheduledScanEnabled: scheduledScan,
          scanIntervalMinutes: Number(interval),
          scanMode,
          minFileSizeMb: Number(minSize),
          excludeKeywords: keywords,
          deliveryMode,
        }),
      });

      if (res.ok) {
        onSuccess();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => { void handleSubmit(e); }}
      style={{
        background: "rgba(34, 197, 94, 0.04)",
        border: "1px solid rgba(34, 197, 94, 0.25)",
        borderRadius: "10px",
        padding: "1.25rem",
        marginBottom: "1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: "0.9rem", fontWeight: 600, color: "var(--accent, #22c55e)" }}>
          绑定新网盘目录
        </span>
        <button
          type="button"
          onClick={onCancel}
          style={{ background: "none", border: "none", color: "var(--text-muted, #a1a1aa)", cursor: "pointer" }}
        >
          <X size={16} />
        </button>
      </div>

      {/* 网盘与路径选择区 */}
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 2.5fr", gap: "0.9rem" }}>
        <div>
          <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 500, marginBottom: "0.3rem" }}>
            选择目标网盘
          </label>
          <select
            className="input"
            value={storageId}
            onChange={(e) => setStorageId(e.target.value)}
            style={{ width: "100%", padding: "0.45rem" }}
            required
          >
            {storages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.provider.toUpperCase()} {s.label ? `(${s.label})` : `(${s.id})`}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 500, marginBottom: "0.3rem" }}>
            网盘目标目录（支持可视化直选）
          </label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input
              type="text"
              className="input"
              value={selectedRemotePath}
              readOnly
              placeholder="点击右侧按钮浏览选择..."
              onClick={() => onOpenFolderPicker(storageId, selectedRemoteFolderId)}
              style={{ flex: 1, padding: "0.45rem", cursor: "pointer", background: "rgba(255, 255, 255, 0.04)" }}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => onOpenFolderPicker(storageId, selectedRemoteFolderId)}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", whiteSpace: "nowrap", padding: "0.45rem 0.85rem" }}
            >
              <FolderOpen size={15} /> 可视化浏览网盘...
            </button>
          </div>
          <div style={{ marginTop: "0.35rem", fontSize: "0.74rem", color: "var(--text-muted, #a1a1aa)" }}>
            选定目录 CID: <code style={{ color: "#4ade80" }}>{selectedRemoteFolderId}</code>
          </div>
        </div>
      </div>

      {/* 独立扫描配置网格 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "0.8rem" }}>
        <div>
          <label style={{ display: "block", fontSize: "0.78rem", fontWeight: 500, marginBottom: "0.25rem" }}>
            扫描模式
          </label>
          <select
            className="input"
            value={scanMode}
            onChange={(e) => setScanMode(e.target.value as LibraryScanMode)}
            style={{ width: "100%", padding: "0.4rem", fontSize: "0.82rem" }}
          >
            <option value="incremental_missing">增量扫描 (快照比对极速)</option>
            <option value="full_deep">全量深度扫描</option>
          </select>
        </div>

        <div>
          <label style={{ display: "block", fontSize: "0.78rem", fontWeight: 500, marginBottom: "0.25rem" }}>
            定时扫描周期 (分钟)
          </label>
          <input
            type="number"
            className="input"
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
            style={{ width: "100%", padding: "0.4rem", fontSize: "0.82rem" }}
          />
        </div>

        <div>
          <label style={{ display: "block", fontSize: "0.78rem", fontWeight: 500, marginBottom: "0.25rem" }}>
            最小文件大小 (MB)
          </label>
          <input
            type="number"
            className="input"
            value={minSize}
            onChange={(e) => setMinSize(Number(e.target.value))}
            style={{ width: "100%", padding: "0.4rem", fontSize: "0.82rem" }}
          />
        </div>

        <div>
          <label style={{ display: "block", fontSize: "0.78rem", fontWeight: 500, marginBottom: "0.25rem" }}>
            独立播放模式
          </label>
          <select
            className="input"
            value={deliveryMode}
            onChange={(e) => setDeliveryMode(e.target.value as BindingDeliveryMode)}
            style={{ width: "100%", padding: "0.4rem", fontSize: "0.82rem" }}
          >
            <option value="inherit">继承库默认设置</option>
            <option value="redirect">强制 302 直连</option>
            <option value="proxy">强制代理中继</option>
          </select>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: "0.2rem" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem", fontSize: "0.82rem", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={scheduledScan}
            onChange={(e) => setScheduledScan(e.target.checked)}
          />
          启用自动定时扫描守护
        </label>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
            {submitting ? "正在绑定..." : "确认绑定此路径"}
          </button>
        </div>
      </div>
    </form>
  );
}

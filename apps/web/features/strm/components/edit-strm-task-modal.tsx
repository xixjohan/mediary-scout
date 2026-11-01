"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, HardDrive, RefreshCw, X } from "lucide-react";
import type { StrmDeliveryMode, StrmScanMode, StrmTask } from "@media-track/workflow";
import { RemoteFolderPickerModal } from "./remote-folder-picker-modal";
import { LocalFolderPickerModal } from "./local-folder-picker-modal";

export interface EditStrmTaskModalProps {
  task: StrmTask;
  storages: { id: string; name: string; provider: string }[];
  onClose: () => void;
  onSuccess: (updatedName: string) => void;
}

export function EditStrmTaskModal({
  task,
  storages,
  onClose,
  onSuccess,
}: EditStrmTaskModalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [form, setForm] = useState({
    name: task.name,
    storageId: task.storageId,
    remoteFolderId: task.remoteFolderId,
    remotePath: task.remotePath,
    localOutputDir: task.localOutputDir,
    scanMode: task.scanMode,
    deliveryMode: task.deliveryMode,
    scanIntervalMinutes: task.scanIntervalMinutes,
    extensions: task.extensions,
    minFileSizeMb: task.minFileSizeMb,
    excludeKeywords: task.excludeKeywords || "",
    isActive: task.isActive,
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 拾取器弹窗状态
  const [showRemotePicker, setShowRemotePicker] = useState(false);
  const [showLocalPicker, setShowLocalPicker] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const res = await fetch(`/api/strm/tasks/${task.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "更新任务失败");
      }
      onSuccess(data.name || form.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;
  return createPortal(
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, backdropFilter: "blur(6px)" }}>
      <div style={{ background: "var(--bg-base, #18181b)", border: "1px solid var(--border, #333)", borderRadius: "12px", padding: "1.5rem", width: "100%", maxWidth: "580px", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600 }}>编辑 STRM 同步任务</h3>
          <button type="button" onClick={onClose} className="btn btn-ghost" style={{ padding: "0.25rem" }}>
            <X size={18} />
          </button>
        </div>

        {error && (
          <div style={{ padding: "0.75rem", background: "rgba(239, 68, 68, 0.15)", borderRadius: "6px", color: "#ef4444", fontSize: "0.85rem", marginBottom: "1rem" }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "grid", gap: "0.85rem" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>任务名称</label>
            <input
              type="text"
              required
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>关联网盘</label>
            <select
              className="input"
              value={form.storageId}
              onChange={(e) => setForm({ ...form, storageId: e.target.value })}
              style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
            >
              {storages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.provider})
                </option>
              ))}
            </select>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
              <label style={{ fontSize: "0.85rem", color: "#ccc" }}>远端网盘目录</label>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowRemotePicker(true)}
                style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem", color: "#60a5fa", padding: "0.15rem 0.4rem" }}
              >
                <HardDrive size={13} /> 可视化选择网盘目录
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "0.5rem" }}>
              <input
                type="text"
                required
                className="input"
                value={form.remoteFolderId}
                onChange={(e) => setForm({ ...form, remoteFolderId: e.target.value })}
                placeholder="目录 ID"
                style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
              />
              <input
                type="text"
                required
                className="input"
                value={form.remotePath}
                onChange={(e) => setForm({ ...form, remotePath: e.target.value })}
                placeholder="路径展示，如 /Media/Movies"
                style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
              />
            </div>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
              <label style={{ fontSize: "0.85rem", color: "#ccc" }}>本地 STRM 输出目录（绝对物理路径）</label>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowLocalPicker(true)}
                style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem", color: "#34d399", padding: "0.15rem 0.4rem" }}
              >
                <Folder size={13} /> 可视化选择本地目录
              </button>
            </div>
            <input
              type="text"
              required
              className="input"
              value={form.localOutputDir}
              onChange={(e) => setForm({ ...form, localOutputDir: e.target.value })}
              placeholder="如 /data/strm/movies"
              style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>扫描模式</label>
              <select
                className="input"
                value={form.scanMode}
                onChange={(e) => setForm({ ...form, scanMode: e.target.value as StrmScanMode })}
                style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
              >
                <option value="incremental_missing">增量补缺（仅补全新增）</option>
                <option value="incremental_update">增量更新（覆盖修改）</option>
                <option value="full_sync">全量同步（含空盘保护镜像）</option>
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>串流访问方式</label>
              <select
                className="input"
                value={form.deliveryMode}
                onChange={(e) => setForm({ ...form, deliveryMode: e.target.value as StrmDeliveryMode })}
                style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
              >
                <option value="redirect">302 重定向（客户端直连 CDN）</option>
                <option value="proxy">服务端代理（支持 HTTP 206 中继）</option>
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0.5rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>包含后缀</label>
              <input
                type="text"
                className="input"
                value={form.extensions}
                onChange={(e) => setForm({ ...form, extensions: e.target.value })}
                style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>最小体积 (MB)</label>
              <input
                type="number"
                className="input"
                value={form.minFileSizeMb}
                onChange={(e) => setForm({ ...form, minFileSizeMb: Number(e.target.value) })}
                style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
              />
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1rem" }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "正在保存..." : "保存修改"}
            </button>
          </div>
        </form>

        {/* 拾取器弹窗 */}
        {showRemotePicker && (
          <RemoteFolderPickerModal
            storageId={form.storageId}
            initialFolderId={form.remoteFolderId}
            onSelect={(folderId, fullPath) => {
              setForm((prev) => ({ ...prev, remoteFolderId: folderId, remotePath: fullPath }));
            }}
            onClose={() => setShowRemotePicker(false)}
          />
        )}

        {showLocalPicker && (
          <LocalFolderPickerModal
            initialPath={form.localOutputDir}
            onSelect={(selectedPath) => {
              setForm((prev) => ({ ...prev, localOutputDir: selectedPath }));
            }}
            onClose={() => setShowLocalPicker(false)}
          />
        )}
      </div>
    </div>,
    document.body
  );
}

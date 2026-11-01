"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Upload, Trash2, Code, Play, RefreshCw, AlertCircle, Box } from "lucide-react";
import type { ExtensionEntity } from "@media-track/workflow";
import { ExtensionEditorModal } from "./extension-editor-modal";
import { AppConfirmDialog } from "../../../components/ui/app-confirm-dialog";

export function ExtensionManagerView() {
  const [extensions, setExtensions] = useState<ExtensionEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modals state
  const [selectedExt, setSelectedExt] = useState<ExtensionEntity | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // New Extension Form
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // Import ZIP Form
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [deleteConfirmExt, setDeleteConfirmExt] = useState<{ id: string; name: string } | null>(null);

  const fetchExtensions = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/extensions");
      if (!res.ok) throw new Error("获取扩展列表失败");
      const data = (await res.json()) as ExtensionEntity[];
      setExtensions(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchExtensions();
  }, []);

  const handleCreateScaffold = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newId || !newName) return;
    setCreating(true);
    try {
      const res = await fetch("/api/extensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: newId, name: newName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建失败");
      setShowCreateModal(false);
      setNewId("");
      setNewName("");
      void fetchExtensions();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleImportZip = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!zipFile) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", zipFile);
      const res = await fetch("/api/extensions/import", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "导入失败");
      setShowImportModal(false);
      setZipFile(null);
      void fetchExtensions();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = (id: string, name: string) => {
    setDeleteConfirmExt({ id, name });
  };

  const confirmDelete = async (id: string, name: string) => {
try {
      const res = await fetch(`/api/extensions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("删除失败");
      void fetchExtensions();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      {/* Action Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontSize: "1.25rem", margin: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Box size={20} /> 自定义资源与搜索扩展
          </h2>
          <p style={{ margin: "0.25rem 0 0", color: "var(--text-muted)", fontSize: "0.85rem" }}>
            基于 Node.js 原生进程隔离沙箱（child_process.fork），支持热插拔搜索源、在线热编辑与备忘录快照回滚
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.6rem" }}>
          <button
            onClick={() => setShowImportModal(true)}
            className="btn btn-secondary"
            style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem" }}
          >
            <Upload size={14} /> 导入 ZIP 扩展包
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="btn btn-primary"
            style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem" }}
          >
            <Plus size={14} /> 新建扩展脚手架
          </button>
        </div>
      </div>

      {error && (
        <div className="card" style={{ borderColor: "var(--color-danger)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <AlertCircle size={16} color="var(--color-danger)" />
          <span style={{ fontSize: "0.9rem" }}>{error}</span>
          <button onClick={fetchExtensions} className="btn btn-ghost" style={{ marginLeft: "auto", fontSize: "0.8rem" }}>
            <RefreshCw size={12} /> 重试
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem", color: "var(--text-muted)" }}>
          正在加载扩展组件清单...
        </div>
      ) : extensions.length === 0 ? (
        <div
          className="card"
          style={{
            padding: "3rem 1.5rem",
            textAlign: "center",
            border: "1px dashed var(--border)",
            backgroundColor: "var(--bg-elevated)",
          }}
        >
          <Box size={36} style={{ margin: "0 auto 0.75rem", opacity: 0.5 }} />
          <h4 style={{ margin: "0 0 0.5rem" }}>暂无已安装的动态扩展</h4>
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.85rem" }}>
            您可以新建脚手架由 AI 对话助手自动编写，或从开源社区导入现成 ZIP 搜索源插件。
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {extensions.map((ext) => (
            <div
              key={ext.manifest.id}
              className="card"
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "1rem 1.25rem",
                border: "1px solid var(--border)",
                backgroundColor: "var(--bg-surface)",
              }}
            >
              <div style={{ display: "grid", gap: "0.25rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                  <strong>{ext.manifest.name}</strong>
                  <span className="badge" style={{ fontSize: "0.75rem" }}>v{ext.manifest.version}</span>
                  <span className="badge" style={{ fontSize: "0.75rem", textTransform: "uppercase" }}>{ext.manifest.type}</span>
                  {ext.manifest.enabled ? (
                    <span className="badge badge-success" style={{ fontSize: "0.75rem" }}>已启用</span>
                  ) : (
                    <span className="badge badge-neutral" style={{ fontSize: "0.75rem" }}>已停用</span>
                  )}
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", display: "flex", gap: "1rem" }}>
                  <span>ID: <code>{ext.manifest.id}</code></span>
                  <span>入口: <code>{ext.manifest.entry}</code></span>
                  {ext.manifest.author && <span>作者: {ext.manifest.author}</span>}
                </div>
              </div>

              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  onClick={() => setSelectedExt(ext)}
                  className="btn btn-secondary"
                  style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.8rem" }}
                >
                  <Code size={13} /> 代码与调试
                </button>
                <button
                  onClick={() => handleDelete(ext.manifest.id, ext.manifest.name)}
                  className="btn btn-ghost"
                  style={{ color: "var(--color-danger)", padding: "0.4rem" }}
                  title="彻底删除"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Editor & Debug Modal */}
      {selectedExt && (
        <ExtensionEditorModal
          extension={selectedExt}
          onClose={() => setSelectedExt(null)}
        />
      )}

      {/* Create Scaffolding Modal */}
      {showCreateModal && mounted &&
        createPortal(
          <div
            style={{
              position: "fixed",
              inset: 0,
              backgroundColor: "rgba(0, 0, 0, 0.7)",
              backdropFilter: "blur(6px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 9999,
              padding: "1rem",
            }}
          >
            <div className="card" style={{ width: "100%", maxWidth: "440px", padding: "1.25rem", backgroundColor: "var(--bg-surface)" }}>
              <h3 style={{ margin: "0 0 1rem", fontSize: "1.1rem" }}>新建扩展脚手架</h3>
              <form onSubmit={handleCreateScaffold} style={{ display: "grid", gap: "0.8rem" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.3rem" }}>扩展唯一 ID (仅英文字母与下划线)</label>
                  <input
                    type="text"
                    required
                    placeholder="如: ext_custom_pansou"
                    value={newId}
                    onChange={(e) => setNewId(e.target.value)}
                    className="input"
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.3rem" }}>扩展显示名称</label>
                  <input
                    type="text"
                    required
                    placeholder="如: 自定义聚合盘搜插件"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="input"
                    style={{ width: "100%" }}
                  />
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.5rem" }}>
                  <button type="button" onClick={() => setShowCreateModal(false)} className="btn btn-secondary">
                    取消
                  </button>
                  <button type="submit" disabled={creating} className="btn btn-primary">
                    {creating ? "生成中..." : "创建模板"}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}

      {/* Import ZIP Modal */}
      {showImportModal && mounted &&
        createPortal(
          <div
            style={{
              position: "fixed",
              inset: 0,
              backgroundColor: "rgba(0, 0, 0, 0.7)",
              backdropFilter: "blur(6px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 9999,
              padding: "1rem",
            }}
          >
            <div className="card" style={{ width: "100%", maxWidth: "440px", padding: "1.25rem", backgroundColor: "var(--bg-surface)" }}>
              <h3 style={{ margin: "0 0 1rem", fontSize: "1.1rem" }}>导入 ZIP 扩展包</h3>
              <form onSubmit={handleImportZip} style={{ display: "grid", gap: "0.8rem" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.3rem" }}>选择 .zip 压缩包 (内含 manifest.json 与 entry)</label>
                  <input
                    type="file"
                    required
                    accept=".zip"
                    onChange={(e) => setZipFile(e.target.files?.[0] || null)}
                    className="input"
                    style={{ width: "100%" }}
                  />
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.5rem" }}>
                  <button type="button" onClick={() => setShowImportModal(false)} className="btn btn-secondary">
                    取消
                  </button>
                  <button type="submit" disabled={importing || !zipFile} className="btn btn-primary">
                    {importing ? "正在解压校验..." : "开始导入"}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}
      <AppConfirmDialog
        spec={
          deleteConfirmExt
            ? {
                title: "删除扩展",
                description: `确定彻底删除扩展 [${deleteConfirmExt.name}] 及其所有源代码和快照历史吗？`,
                confirmLabel: "确认彻底删除",
                isDanger: true,
              }
            : null
        }
        onConfirm={async () => {
          if (!deleteConfirmExt) return;
          const { id, name } = deleteConfirmExt;
          setDeleteConfirmExt(null);
          await confirmDelete(id, name);
        }}
        onCancel={() => setDeleteConfirmExt(null)}
      />
    </div>
  );
}

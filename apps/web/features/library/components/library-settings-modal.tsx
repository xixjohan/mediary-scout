"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Settings, Plus, Folder, X } from "lucide-react";
import type { MediaLibrary, LibraryPathBinding, PathConnectionTestResult } from "@media-track/contracts";
import type { ConnectedStorageView } from "../../../lib/workflow-runtime";
import { RemoteFolderPickerModal } from "../../storage-drives/components/storage/remote-folder-picker-modal";
import { LibraryBaseInfoForm } from "./library-base-info-form";
import { LibraryAddPathForm } from "./library-add-path-form";
import { LibraryBindingCard } from "./library-binding-card";

export interface LibrarySettingsModalProps {
  library: MediaLibrary;
  storages: ConnectedStorageView[];
  onClose: () => void;
  onUpdated: () => void;
  onTriggerScan?: ((bindingId?: string) => void) | undefined;
}

export function LibrarySettingsModal({
  library,
  storages,
  onClose,
  onUpdated,
  onTriggerScan,
}: LibrarySettingsModalProps) {
  const [bindings, setBindings] = useState<LibraryPathBinding[]>([]);
  const [loading, setLoading] = useState(true);

  // 添加路径绑定弹窗与目录选择器状态
  const [showAddForm, setShowAddForm] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [pickerStorageId, setPickerStorageId] = useState(storages[0]?.id || "");
  const [selectedFolderId, setSelectedFolderId] = useState("0");
  const [selectedPath, setSelectedPath] = useState("/");

  // 路径解绑二次确认状态
  const [confirmDeleteBindingId, setConfirmDeleteBindingId] = useState<string | null>(null);

  // 路径连通性测试状态
  const [testingPathId, setTestingPathId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, PathConnectionTestResult>>({});

  const fetchBindings = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/library/${library.id}/paths`);
      if (res.ok) {
        const json = await res.json();
        setBindings(json.bindings || []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchBindings();
  }, [library.id]);

  const handleTestPathConnection = async (bindingId: string) => {
    setTestingPathId(bindingId);
    try {
      const res = await fetch(`/api/library/${library.id}/paths/${bindingId}/test`, {
        method: "POST",
      });
      const json = (await res.json()) as PathConnectionTestResult;
      setTestResults((prev) => ({ ...prev, [bindingId]: json }));
    } catch (err: unknown) {
      setTestResults((prev) => ({
        ...prev,
        [bindingId]: {
          success: false,
          latencyMs: 0,
          error: err instanceof Error ? err.message : "测试请求超时",
        },
      }));
    } finally {
      setTestingPathId(null);
    }
  };

  const handleDeleteBinding = async (bindingId: string) => {
    if (confirmDeleteBindingId !== bindingId) {
      setConfirmDeleteBindingId(bindingId);
      return;
    }
    setConfirmDeleteBindingId(null);
    await fetch(`/api/library/${library.id}/paths?bindingId=${bindingId}`, {
      method: "DELETE",
    });
    void fetchBindings();
    onUpdated();
  };

  const handleUpdateBindingConfig = async (binding: LibraryPathBinding, patch: Partial<LibraryPathBinding>) => {
    await fetch(`/api/library/${library.id}/paths`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bindingId: binding.id,
        ...patch,
      }),
    });
    void fetchBindings();
  };

  const handleOpenFolderPicker = (storageId: string, folderId: string) => {
    setPickerStorageId(storageId);
    setSelectedFolderId(folderId);
    setShowFolderPicker(true);
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        backdropFilter: "blur(10px)",
        padding: "1rem",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--bg-surface, #18181b)",
          border: "1px solid var(--border, #333)",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "840px",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.7)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部标题栏 */}
        <div
          style={{
            padding: "1.1rem 1.5rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid var(--border-subtle, #27272a)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <Settings size={20} style={{ color: "var(--accent, #22c55e)" }} />
            <h2 style={{ fontSize: "1.15rem", fontWeight: 700, margin: 0, color: "var(--text, #f4f4f5)" }}>
              影视库配置与网盘路径绑定
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            style={{ padding: "0.3rem" }}
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        {/* 核心滚动内容区域 */}
        <div style={{ flex: 1, overflowY: "auto", padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {/* 影视库基础信息模块 */}
          <LibraryBaseInfoForm library={library} onUpdated={onUpdated} />

          {/* 绑定的网盘目录模块 */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.9rem" }}>
              <div>
                <h3 style={{ fontSize: "0.95rem", fontWeight: 600, margin: 0, color: "var(--text, #f4f4f5)" }}>
                  绑定的网盘目录与独立扫描配置
                </h3>
                <p style={{ margin: "0.2rem 0 0 0", fontSize: "0.8rem", color: "var(--text-muted, #a1a1aa)" }}>
                  支持将多个网盘的不同目录绑定到同一个库，各路径支持独立配置定时扫描与增量策略
                </p>
              </div>

              {!showAddForm && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setShowAddForm(true)}
                  style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
                >
                  <Plus size={15} /> 添加绑定路径
                </button>
              )}
            </div>

            {/* 可视化新增路径表单面板 */}
            {showAddForm && (
              <LibraryAddPathForm
                libraryId={library.id}
                storages={storages}
                selectedRemoteFolderId={selectedFolderId}
                selectedRemotePath={selectedPath}
                onCancel={() => setShowAddForm(false)}
                onOpenFolderPicker={handleOpenFolderPicker}
                onSuccess={() => {
                  setShowAddForm(false);
                  setSelectedPath("/");
                  setSelectedFolderId("0");
                  void fetchBindings();
                  onUpdated();
                }}
              />
            )}

            {/* 已绑定的网盘路径列表 */}
            {loading ? (
              <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted, #a1a1aa)" }}>
                正在加载绑定的路径...
              </div>
            ) : bindings.length === 0 && !showAddForm ? (
              <div
                style={{
                  border: "1px dashed var(--border, #333)",
                  borderRadius: "10px",
                  padding: "2.5rem 1rem",
                  textAlign: "center",
                  color: "var(--text-muted, #a1a1aa)",
                }}
              >
                <Folder size={32} style={{ margin: "0 auto 0.75rem auto", opacity: 0.5 }} />
                <p style={{ margin: 0, fontSize: "0.9rem" }}>暂未绑定网盘路径，请点击上方「添加绑定路径」开启可视化目录选择</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
                {bindings.map((b) => (
                  <LibraryBindingCard
                    key={b.id}
                    binding={b}
                    isTesting={testingPathId === b.id}
                    testResult={testResults[b.id]}
                    isConfirmDelete={confirmDeleteBindingId === b.id}
                    onTest={handleTestPathConnection}
                    onTriggerScan={onTriggerScan}
                    onConfirmDeleteChange={setConfirmDeleteBindingId}
                    onDelete={handleDeleteBinding}
                    onUpdateConfig={handleUpdateBindingConfig}
                    onCloseParentModal={onClose}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 底部关闭栏 */}
        <div
          style={{
            padding: "0.9rem 1.5rem",
            borderTop: "1px solid var(--border-subtle, #27272a)",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button type="button" className="btn btn-primary" onClick={onClose} style={{ minWidth: "90px" }}>
            完成
          </button>
        </div>
      </div>

      {/* 可视化网盘目录选择弹窗 (Portal 挂载) */}
      {showFolderPicker && (
        <RemoteFolderPickerModal
          storageId={pickerStorageId}
          initialFolderId={selectedFolderId}
          title="可视化选择网盘影视目录"
          onSelect={(folderId, fullPath) => {
            setSelectedFolderId(folderId);
            setSelectedPath(fullPath);
          }}
          onClose={() => setShowFolderPicker(false)}
        />
      )}
    </div>,
    document.body
  );
}

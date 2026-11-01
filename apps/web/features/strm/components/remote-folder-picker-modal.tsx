"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Folder, FolderPlus, HardDrive, Loader2, RefreshCw, X } from "lucide-react";
import type { DriveDirectoryListing, DriveFileItem } from "@media-track/workflow";

export interface RemoteFolderPickerModalProps {
  storageId: string;
  initialFolderId?: string;
  onSelect: (folderId: string, fullPath: string) => void;
  onClose: () => void;
}

interface CrumbItem {
  id: string;
  name: string;
}

export function RemoteFolderPickerModal({
  storageId,
  initialFolderId = "0",
  onSelect,
  onClose,
}: RemoteFolderPickerModalProps) {
  const [currentDirId, setCurrentDirId] = useState(initialFolderId || "0");
  const [breadcrumbs, setBreadcrumbs] = useState<CrumbItem[]>([{ id: "0", name: "网盘根目录" }]);
  const [folders, setFolders] = useState<DriveFileItem[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const fetchDirectory = async (dirId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/storage/files?storageId=${encodeURIComponent(storageId)}&dirId=${encodeURIComponent(dirId)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "读取网盘目录失败");
      }
      const data: DriveDirectoryListing = await res.json();
      // 仅保留文件夹
      const folderList = (data.items || []).filter((it) => it.isFolder);
      setFolders(folderList);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchDirectory(currentDirId);
  }, [currentDirId, storageId]);

  const handleEnterFolder = (folder: DriveFileItem) => {
    setSelectedFolder(null);
    setCurrentDirId(folder.id);
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
  };

  const handleNavigateCrumb = (index: number) => {
    const target = breadcrumbs[index];
    if (!target) return;
    setSelectedFolder(null);
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
    setCurrentDirId(target.id);
  };

  const getCalculatedPath = () => {
    if (selectedFolder) {
      const parentParts = breadcrumbs.slice(1).map((b) => b.name);
      return "/" + [...parentParts, selectedFolder.name].join("/");
    }
    const parts = breadcrumbs.slice(1).map((b) => b.name);
    return parts.length > 0 ? "/" + parts.join("/") : "/";
  };

  const handleConfirm = () => {
    if (selectedFolder) {
      onSelect(selectedFolder.id, getCalculatedPath());
    } else {
      onSelect(currentDirId, getCalculatedPath());
    }
    onClose();
  };

  if (!mounted) return null;
  return createPortal(
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, backdropFilter: "blur(6px)" }}>
      <div style={{ background: "var(--bg-card, #18181b)", border: "1px solid var(--border, #333)", borderRadius: "12px", width: "100%", maxWidth: "580px", maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* 标题栏 */}
        <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border, #333)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <HardDrive size={18} style={{ color: "#3b82f6" }} />
            <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>可视化选择网盘目录</h3>
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost" style={{ padding: "0.25rem" }}>
            <X size={18} />
          </button>
        </div>

        {/* 面包屑导航栏 */}
        <div style={{ padding: "0.6rem 1.25rem", background: "rgba(255,255,255,0.03)", borderBottom: "1px solid var(--border, #333)", display: "flex", alignItems: "center", gap: "0.25rem", overflowX: "auto", fontSize: "0.85rem" }}>
          {breadcrumbs.map((crumb, idx) => (
            <div key={crumb.id + idx} style={{ display: "inline-flex", alignItems: "center", whiteSpace: "nowrap" }}>
              {idx > 0 && <ChevronRight size={14} style={{ color: "#666", margin: "0 0.2rem" }} />}
              <button
                type="button"
                onClick={() => handleNavigateCrumb(idx)}
                style={{
                  background: "none",
                  border: "none",
                  color: idx === breadcrumbs.length - 1 && !selectedFolder ? "#60a5fa" : "#aaa",
                  cursor: "pointer",
                  padding: "0.2rem 0.4rem",
                  borderRadius: "4px",
                  fontWeight: idx === breadcrumbs.length - 1 ? 600 : 400,
                }}
              >
                {crumb.name}
              </button>
            </div>
          ))}
        </div>

        {/* 目录内容列表 */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0.75rem 1.25rem", minHeight: "260px", maxHeight: "380px" }}>
          {loading ? (
            <div style={{ textAlign: "center", padding: "3rem", color: "#888" }}>
              <Loader2 size={24} className="animate-spin" style={{ margin: "0 auto 0.5rem" }} />
              正在读取网盘目录...
            </div>
          ) : error ? (
            <div style={{ textAlign: "center", padding: "2rem", color: "#ef4444", fontSize: "0.9rem" }}>
              {error}
              <div style={{ marginTop: "0.75rem" }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => fetchDirectory(currentDirId)}>
                  <RefreshCw size={13} style={{ marginRight: "0.25rem" }} /> 重试
                </button>
              </div>
            </div>
          ) : folders.length === 0 ? (
            <div style={{ textAlign: "center", padding: "3rem 1rem", color: "#888", fontSize: "0.9rem" }}>
              当前目录下没有子文件夹。您可以直接点击下方「选择当前目录」进行关联。
            </div>
          ) : (
            <div style={{ display: "grid", gap: "0.4rem" }}>
              {folders.map((folder) => {
                const isSelected = selectedFolder?.id === folder.id;
                return (
                  <div
                    key={folder.id}
                    onClick={() => setSelectedFolder({ id: folder.id, name: folder.name })}
                    onDoubleClick={() => handleEnterFolder(folder)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "0.5rem 0.75rem",
                      borderRadius: "6px",
                      cursor: "pointer",
                      background: isSelected ? "rgba(59, 130, 246, 0.2)" : "rgba(255,255,255,0.02)",
                      border: isSelected ? "1px solid #3b82f6" : "1px solid transparent",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <Folder size={16} style={{ color: isSelected ? "#60a5fa" : "#eab308" }} />
                      <span style={{ fontSize: "0.9rem", color: isSelected ? "#fff" : "#ccc" }}>
                        {folder.name}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEnterFolder(folder);
                      }}
                      className="btn btn-ghost btn-sm"
                      style={{ padding: "0.15rem 0.5rem", fontSize: "0.75rem", color: "#aaa" }}
                    >
                      进入子级 →
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部确认与状态 */}
        <div style={{ padding: "0.85rem 1.25rem", borderTop: "1px solid var(--border, #333)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(0,0,0,0.2)" }}>
          <div style={{ fontSize: "0.82rem", color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "340px" }}>
            已选路径: <code style={{ color: "#60a5fa", background: "#222", padding: "0.1rem 0.3rem", borderRadius: "4px" }}>{getCalculatedPath()}</code>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={handleConfirm} disabled={loading}>
              选择此目录
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

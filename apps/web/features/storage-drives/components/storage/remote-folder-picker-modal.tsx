"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Folder, HardDrive, Loader2, RefreshCw, X } from "lucide-react";
import type { DriveDirectoryListing, DriveFileItem } from "@media-track/workflow";

export interface RemoteFolderPickerModalProps {
  storageId: string;
  initialFolderId?: string;
  title?: string;
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
  title = "可视化选择网盘目录",
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

  useEffect(() => {
    setMounted(true);
  }, []);

  const fetchDirectory = async (dirId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/storage/files?storageId=${encodeURIComponent(storageId)}&dirId=${encodeURIComponent(dirId)}`
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error((data["error"] as string) || "读取网盘目录失败");
      }
      const data: DriveDirectoryListing = await res.json();
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
    <div
      className="storage-offline-modal-overlay"
      onClick={onClose}
      role="presentation"
      style={{ zIndex: 10050 }}
    >
      <div
        className="storage-offline-modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-folder-picker-title"
        style={{ maxWidth: "620px" }}
      >
        {/* 标题栏 */}
        <header className="storage-offline-modal-header">
          <div className="storage-offline-title-row">
            <HardDrive size={18} className="storage-offline-head-icon" />
            <h3 id="remote-folder-picker-title" style={{ fontSize: "1.05rem", fontWeight: 600, margin: 0 }}>
              {title}
            </h3>
          </div>
          <button
            type="button"
            className="storage-offline-modal-close"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </header>

        {/* 面包屑导航栏 */}
        <div
          style={{
            padding: "0.5rem 1rem",
            background: "var(--bg-surface)",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: "0.25rem",
            overflowX: "auto",
            fontSize: "0.85rem",
          }}
        >
          {breadcrumbs.map((crumb, idx) => (
            <div key={crumb.id + idx} style={{ display: "inline-flex", alignItems: "center", whiteSpace: "nowrap" }}>
              {idx > 0 && <ChevronRight size={14} style={{ color: "var(--text-muted)", margin: "0 0.15rem" }} />}
              <button
                type="button"
                onClick={() => handleNavigateCrumb(idx)}
                style={{
                  background: "none",
                  border: "none",
                  color:
                    idx === breadcrumbs.length - 1 && !selectedFolder
                      ? "var(--accent)"
                      : "var(--text-muted)",
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

        {/* 目录列表 */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "0.75rem 1rem",
            minHeight: "260px",
            maxHeight: "380px",
          }}
        >
          {loading ? (
            <div style={{ textAlign: "center", padding: "3rem 1rem", color: "var(--text-muted)" }}>
              <Loader2 size={24} className="spin" style={{ margin: "0 auto 0.5rem", display: "block" }} />
              正在读取网盘目录…
            </div>
          ) : error ? (
            <div style={{ textAlign: "center", padding: "2rem 1rem", color: "var(--color-danger)", fontSize: "0.9rem" }}>
              {error}
              <div style={{ marginTop: "0.75rem" }}>
                <button
                  type="button"
                  className="storage-btn secondary"
                  style={{ fontSize: "0.82rem", padding: "0.3rem 0.6rem" }}
                  onClick={() => void fetchDirectory(currentDirId)}
                >
                  <RefreshCw size={13} style={{ marginRight: "0.25rem" }} /> 重试
                </button>
              </div>
            </div>
          ) : folders.length === 0 ? (
            <div style={{ textAlign: "center", padding: "3rem 1rem", color: "var(--text-muted)", fontSize: "0.9rem" }}>
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
                      padding: "0.45rem 0.75rem",
                      borderRadius: "6px",
                      cursor: "pointer",
                      background: isSelected
                        ? "var(--accent-subtle)"
                        : "var(--bg-surface)",
                      border: isSelected
                        ? "1px solid var(--accent)"
                        : "1px solid transparent",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", overflow: "hidden" }}>
                      <Folder
                        size={16}
                        style={{
                          color: isSelected ? "var(--accent)" : "var(--color-warning)",
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          fontSize: "0.88rem",
                          color: isSelected ? "var(--text)" : "var(--text-muted)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {folder.name}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEnterFolder(folder);
                      }}
                      className="storage-btn secondary"
                      style={{
                        padding: "0.2rem 0.5rem",
                        fontSize: "0.75rem",
                        lineHeight: 1,
                        borderRadius: "4px",
                      }}
                    >
                      进入子级 →
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部确认栏 */}
        <footer
          className="storage-offline-modal-footer"
          style={{ justifyContent: "space-between", alignItems: "center" }}
        >
          <div
            style={{
              fontSize: "0.82rem",
              color: "var(--text-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: "360px",
            }}
          >
            目标:{" "}
            <code
              style={{
                color: "var(--accent)",
                background: "var(--bg-card)",
                padding: "0.15rem 0.4rem",
                borderRadius: "4px",
              }}
            >
              {getCalculatedPath()}
            </code>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" className="storage-btn" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="storage-btn primary"
              onClick={handleConfirm}
              disabled={loading}
            >
              确定选择
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body
  );
}

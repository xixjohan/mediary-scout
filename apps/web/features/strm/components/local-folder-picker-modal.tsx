"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, FolderPlus, HardDrive, Loader2, RefreshCw, X } from "lucide-react";

export interface LocalFolderPickerModalProps {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

interface DirEntry {
  name: string;
  fullPath: string;
  configPath?: string;
  isDriveRoot?: boolean;
}

export function LocalFolderPickerModal({
  initialPath = "",
  onSelect,
  onClose,
}: LocalFolderPickerModalProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [directories, setDirectories] = useState<DirEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>(initialPath);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // 新建子文件夹输入控制
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creating, setCreating] = useState(false);

  const fetchDirectory = async (targetPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = targetPath
        ? `/api/system/fs-browse?path=${encodeURIComponent(targetPath)}`
        : "/api/system/fs-browse";
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "读取服务端目录失败");
      }
      setCurrentPath(data.currentPath || "");
      setParentPath(data.parentPath || null);
      setCanWrite(Boolean(data.canWrite));
      setDirectories(data.directories || []);
      if (data.currentPath) setSelectedPath(data.currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchDirectory(initialPath);
  }, [initialPath]);

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim() || !currentPath) return;
    setCreating(true);
    try {
      const res = await fetch("/api/system/fs-browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPath: currentPath, folderName: newFolderName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "新建文件夹失败");
      setNewFolderName("");
      setShowNewFolder(false);
      void fetchDirectory(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handlePreset = (preset: string) => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/system/fs-browse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "ensure-output", outputPath: preset }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "STRM 输出目录不可用");
        const finalPath = data.resolvedPath || data.configPath || preset;
        setSelectedPath(finalPath);
        await fetchDirectory(finalPath);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
  };

  const handleConfirm = () => {
    if (selectedPath) {
      onSelect(selectedPath);
    }
    onClose();
  };

  if (!mounted) return null;
  return createPortal(
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, backdropFilter: "blur(6px)" }}>
      <div style={{ background: "var(--bg-card, #18181b)", border: "1px solid var(--border, #333)", borderRadius: "12px", width: "100%", maxWidth: "600px", maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* 头部标题 */}
        <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border, #333)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Folder size={18} style={{ color: "#22c55e" }} />
            <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>可视化选择本地 STRM 存储目录</h3>
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost" style={{ padding: "0.25rem" }}>
            <X size={18} />
          </button>
        </div>

        {/* 常用预设快捷按钮 */}
        <div style={{ padding: "0.6rem 1.25rem", background: "rgba(255,255,255,0.02)", borderBottom: "1px solid var(--border, #333)", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.8rem", color: "#888" }}>常用推荐：</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => handlePreset("/app/data/strm/movies")}
            style={{ fontSize: "0.75rem", background: "rgba(59, 130, 246, 0.15)", color: "#60a5fa" }}
          >
            电影 (/app/data/strm/movies)
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => handlePreset("/app/data/strm/tv")}
            style={{ fontSize: "0.75rem", background: "rgba(168, 85, 247, 0.15)", color: "#c084fc" }}
          >
            剧集 (/app/data/strm/tv)
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => handlePreset("/app/data/strm/anime")}
            style={{ fontSize: "0.75rem", background: "rgba(168, 85, 247, 0.15)", color: "#c084fc" }}
          >
            动漫 (/app/data/strm/anime)
          </button>
        </div>

        {/* 路径导航与操作栏 */}
        <div style={{ padding: "0.6rem 1.25rem", borderBottom: "1px solid var(--border, #333)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#1c1c1f", gap: "0.5rem" }}>
          <div style={{ fontSize: "0.85rem", color: "#ccc", display: "flex", alignItems: "center", gap: "0.35rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {parentPath && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => { void fetchDirectory(parentPath); }}
                style={{ padding: "0.15rem 0.5rem", fontSize: "0.75rem" }}
              >
                ↑ 返回上一级
              </button>
            )}
            <span style={{ color: "#888" }}>当前位置:</span>
            <code style={{ color: "#34d399", background: "#111", padding: "0.15rem 0.4rem", borderRadius: "4px" }}>
              {currentPath || "根盘符 / 挂载列表"}
            </code>
          </div>

          {currentPath && canWrite && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShowNewFolder(!showNewFolder)}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem", color: "#60a5fa" }}
            >
              <FolderPlus size={14} /> 新建子目录
            </button>
          )}
        </div>

        {/* 新建子目录输入条 */}
        {showNewFolder && (
          <form onSubmit={handleCreateFolder} style={{ padding: "0.5rem 1.25rem", background: "rgba(59, 130, 246, 0.1)", borderBottom: "1px solid #333", display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              type="text"
              required
              placeholder="新文件夹名称，如 movies 或 tv"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              style={{ flex: 1, padding: "0.3rem 0.6rem", fontSize: "0.85rem", background: "#222", border: "1px solid #444", borderRadius: "4px", color: "#fff" }}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={creating} style={{ fontSize: "0.75rem" }}>
              {creating ? "创建中..." : "确认创建"}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowNewFolder(false)} style={{ fontSize: "0.75rem" }}>
              取消
            </button>
          </form>
        )}

        {/* 目录列表 */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0.75rem 1.25rem", minHeight: "260px", maxHeight: "380px" }}>
          {loading ? (
            <div style={{ textAlign: "center", padding: "3rem", color: "#888" }}>
              <Loader2 size={24} className="animate-spin" style={{ margin: "0 auto 0.5rem" }} />
              正在读取文件系统...
            </div>
          ) : error ? (
            <div style={{ textAlign: "center", padding: "2rem", color: "#ef4444", fontSize: "0.9rem" }}>
              {error}
              <div style={{ marginTop: "0.75rem" }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { void fetchDirectory(""); }}>
                  <RefreshCw size={13} style={{ marginRight: "0.25rem" }} /> 返回根目录
                </button>
              </div>
            </div>
          ) : directories.length === 0 ? (
            <div style={{ textAlign: "center", padding: "3rem 1rem", color: "#888", fontSize: "0.9rem" }}>
              该目录下暂无其他子文件夹。您可以直接点击右下角「选择此目录」或者点击上方「新建子目录」。
            </div>
          ) : (
            <div style={{ display: "grid", gap: "0.35rem" }}>
              {directories.map((dir) => {
                const isSelected = selectedPath === dir.fullPath;
                return (
                  <div
                    key={dir.fullPath}
                    onClick={() => setSelectedPath(dir.fullPath)}
                    onDoubleClick={() => { void fetchDirectory(dir.fullPath); }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "0.5rem 0.75rem",
                      borderRadius: "6px",
                      cursor: "pointer",
                      background: isSelected ? "rgba(34, 197, 94, 0.2)" : "rgba(255,255,255,0.02)",
                      border: isSelected ? "1px solid #22c55e" : "1px solid transparent",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      {dir.isDriveRoot ? (
                        <HardDrive size={16} style={{ color: "#38bdf8" }} />
                      ) : (
                        <Folder size={16} style={{ color: isSelected ? "#4ade80" : "#fbbf24" }} />
                      )}
                      <span style={{ fontSize: "0.9rem", color: isSelected ? "#fff" : "#ccc" }}>
                        {dir.name}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void fetchDirectory(dir.fullPath);
                      }}
                      className="btn btn-ghost btn-sm"
                      style={{ padding: "0.15rem 0.5rem", fontSize: "0.75rem", color: "#aaa" }}
                    >
                      进入目录 →
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部确认栏 */}
        <div style={{ padding: "0.85rem 1.25rem", borderTop: "1px solid var(--border, #333)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(0,0,0,0.2)" }}>
          <div style={{ fontSize: "0.82rem", color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "340px" }}>
            已选路径: <code style={{ color: "#4ade80", background: "#222", padding: "0.1rem 0.3rem", borderRadius: "4px" }}>{selectedPath || "未选择"}</code>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={handleConfirm} disabled={!selectedPath || loading}>
              选择此目录
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

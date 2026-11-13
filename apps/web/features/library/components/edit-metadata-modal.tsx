"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Edit3, FileText, Lock, RefreshCw, X, Check, AlertCircle } from "lucide-react";
import type { LibraryMediaItem, LibraryEpisode } from "@media-track/contracts";

export interface EditMetadataModalProps {
  item: LibraryMediaItem;
  episodes: LibraryEpisode[];
  onClose: () => void;
  onSaved: () => void;
}

export function EditMetadataModal({ item, episodes, onClose, onSaved }: EditMetadataModalProps) {
  const [title, setTitle] = useState(item.title);
  const [originalTitle, setOriginalTitle] = useState(item.originalTitle || "");
  const [releaseYear, setReleaseYear] = useState(item.releaseYear ? String(item.releaseYear) : "");
  const [tmdbId, setTmdbId] = useState(item.tmdbId ? String(item.tmdbId) : "");
  const [overview, setOverview] = useState(item.overview || "");
  const [isLocked, setIsLocked] = useState(item.isMetadataLocked);
  const [saving, setSaving] = useState(false);
  const [rematching, setRematching] = useState(false);
  const [renameTargetEpId, setRenameTargetEpId] = useState<string | null>(null);
  const [renamingEpName, setRenamingEpName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // 保存元数据
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/library/items/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          originalTitle,
          releaseYear: releaseYear ? Number(releaseYear) : undefined,
          tmdbId: tmdbId ? Number(tmdbId) : undefined,
          overview,
          isMetadataLocked: isLocked,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "保存失败");
      }
      setMsg({ type: "success", text: "元数据已更新并锁定保护" });
      setTimeout(() => {
        onSaved();
        onClose();
      }, 800);
    } catch (err: unknown) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "保存异常" });
    } finally {
      setSaving(false);
    }
  };

  // 重新匹配刮削信息
  const handleRematch = async () => {
    if (!tmdbId && !title) return;
    setRematching(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/library/items/${item.id}/rematch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId: tmdbId ? Number(tmdbId) : undefined,
          title: !tmdbId ? title : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "重新匹配失败");
      if (data.item) {
        setTitle(data.item.title);
        setOriginalTitle(data.item.originalTitle || "");
        setReleaseYear(data.item.releaseYear ? String(data.item.releaseYear) : "");
        setTmdbId(data.item.tmdbId ? String(data.item.tmdbId) : "");
        setOverview(data.item.overview || "");
        setIsLocked(true);
        setMsg({ type: "success", text: "成功从官方源同步最新元数据" });
        onSaved();
      }
    } catch (err: unknown) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "重新匹配失败" });
    } finally {
      setRematching(false);
    }
  };

  // 网盘端物理文件重命名
  const handleRenameFile = async (ep: LibraryEpisode) => {
    if (!renamingEpName.trim()) return;
    setRenaming(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/library/items/${item.id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episodeId: ep.id,
          newFileName: renamingEpName.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "重命名网盘物理文件失败");
      setMsg({ type: "success", text: `网盘端文件名已成功更新为: ${renamingEpName.trim()}` });
      setRenameTargetEpId(null);
      onSaved();
    } catch (err: unknown) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "重命名操作失败" });
    } finally {
      setRenaming(false);
    }
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
        backdropFilter: "blur(6px)",
        padding: "1rem",
      }}
    >
      <div
        style={{
          background: "var(--bg-surface, #1e1e24)",
          border: "1px solid var(--border, #333)",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "680px",
          maxHeight: "90vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5)",
        }}
      >
        {/* 头部 */}
        <div
          style={{
            padding: "1rem 1.25rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid var(--border-subtle, #27272a)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Edit3 size={18} style={{ color: "var(--accent, #22c55e)" }} />
            <span style={{ fontSize: "1.05rem", fontWeight: 600 }}>修改元数据与网盘端文件名</span>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} style={{ padding: "0.2rem" }}>
            <X size={16} />
          </button>
        </div>

        {/* 内容区 */}
        <div style={{ padding: "1.25rem", overflowY: "auto", flex: 1 }}>
          {msg && (
            <div
              style={{
                padding: "0.6rem 0.85rem",
                borderRadius: "6px",
                marginBottom: "1rem",
                fontSize: "0.85rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                background: msg.type === "success" ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)",
                color: msg.type === "success" ? "#4ade80" : "#f87171",
                border: `1px solid ${msg.type === "success" ? "rgba(34, 197, 94, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
              }}
            >
              {msg.type === "success" ? <Check size={16} /> : <AlertCircle size={16} />}
              {msg.text}
            </div>
          )}

          <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 500, marginBottom: "0.3rem" }}>
                影视中文标题
              </label>
              <input
                type="text"
                className="input"
                style={{ width: "100%", padding: "0.5rem 0.75rem" }}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 500, marginBottom: "0.3rem" }}>
                  TMDB ID (自动刮削识别码)
                </label>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <input
                    type="number"
                    className="input"
                    style={{ flex: 1, padding: "0.5rem 0.75rem" }}
                    placeholder="如: 209867"
                    value={tmdbId}
                    onChange={(e) => setTmdbId(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleRematch}
                    disabled={rematching}
                    title="重新根据 TMDB ID 或标题重新刮削"
                    style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
                  >
                    <RefreshCw size={13} className={rematching ? "animate-spin" : ""} />
                    重新匹配
                  </button>
                </div>
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 500, marginBottom: "0.3rem" }}>
                  上映年份
                </label>
                <input
                  type="number"
                  className="input"
                  style={{ width: "100%", padding: "0.5rem 0.75rem" }}
                  placeholder="如: 2023"
                  value={releaseYear}
                  onChange={(e) => setReleaseYear(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 500, marginBottom: "0.3rem" }}>
                外文原名
              </label>
              <input
                type="text"
                className="input"
                style={{ width: "100%", padding: "0.5rem 0.75rem" }}
                value={originalTitle}
                onChange={(e) => setOriginalTitle(e.target.value)}
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 500, marginBottom: "0.3rem" }}>
                剧情简介
              </label>
              <textarea
                className="input"
                rows={3}
                style={{ width: "100%", padding: "0.5rem 0.75rem", resize: "vertical" }}
                value={overview}
                onChange={(e) => setOverview(e.target.value)}
              />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.5rem 0" }}>
              <input
                type="checkbox"
                id="isLocked"
                checked={isLocked}
                onChange={(e) => setIsLocked(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              <label htmlFor="isLocked" style={{ fontSize: "0.85rem", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <Lock size={14} style={{ color: "#eab308" }} />
                锁定元数据（锁定后全量或增量扫描绝不覆盖当前设置）
              </label>
            </div>

            {/* 网盘物理文件列表与重命名区 */}
            <div style={{ marginTop: "1rem", borderTop: "1px solid var(--border-subtle, #27272a)", paddingTop: "1rem" }}>
              <h4 style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.6rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <FileText size={15} style={{ color: "var(--accent, #22c55e)" }} />
                绑定的网盘物理文件与重命名
              </h4>
              <p style={{ fontSize: "0.75rem", color: "var(--text-muted, #a1a1aa)", marginBottom: "0.75rem" }}>
                可直接修改网盘端的真实文件名，便于 Emby/Plex 刮削或保持网盘整洁规范。
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", maxHeight: "200px", overflowY: "auto" }}>
                {episodes.map((ep) => {
                  const isRenamingThis = renameTargetEpId === ep.id;
                  return (
                    <div
                      key={ep.id}
                      style={{
                        padding: "0.6rem 0.8rem",
                        background: "rgba(255, 255, 255, 0.03)",
                        border: "1px solid var(--border-subtle, #27272a)",
                        borderRadius: "8px",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ overflow: "hidden", marginRight: "0.5rem" }}>
                          <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "#38bdf8", marginRight: "0.4rem" }}>
                            E{String(ep.episodeNumber).padStart(2, "0")}
                          </span>
                          <span style={{ fontSize: "0.8rem", color: "var(--text, #f4f4f5)" }} title={ep.fileName}>
                            {ep.fileName}
                          </span>
                        </div>
                        {!isRenamingThis && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                              setRenameTargetEpId(ep.id);
                              setRenamingEpName(ep.episodeName || ep.fileName);
                            }}
                            style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem", flexShrink: 0 }}
                          >
                            改名
                          </button>
                        )}
                      </div>

                      {isRenamingThis && (
                        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                          <input
                            type="text"
                            className="input"
                            value={renamingEpName}
                            onChange={(e) => setRenamingEpName(e.target.value)}
                            style={{ flex: 1, padding: "0.3rem 0.5rem", fontSize: "0.8rem" }}
                            placeholder="输入网盘端规范新文件名"
                          />
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => handleRenameFile(ep)}
                            disabled={renaming}
                            style={{ padding: "0.3rem 0.6rem", fontSize: "0.75rem" }}
                          >
                            {renaming ? "重命名中..." : "确认"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setRenameTargetEpId(null)}
                            style={{ padding: "0.3rem 0.6rem", fontSize: "0.75rem" }}
                          >
                            取消
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1rem" }}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "保存中..." : "保存修改"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body
  );
}


"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { FolderPlus, X } from "lucide-react";
import type { MediaLibraryType, LibraryDeliveryMode } from "@media-track/contracts";

export function CreateLibraryModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [libraryType, setLibraryType] = useState<MediaLibraryType>("movie");
  const [defaultDeliveryMode, setDefaultDeliveryMode] = useState<LibraryDeliveryMode>("redirect");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          libraryType,
          defaultDeliveryMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建影视库失败");
      onCreated();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "创建异常");
    } finally {
      setSubmitting(false);
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
          maxWidth: "460px",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.7)",
        }}
      >
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
            <FolderPlus size={18} style={{ color: "var(--accent, #22c55e)" }} />
            <span style={{ fontSize: "1.05rem", fontWeight: 600 }}>新建影视库</span>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} style={{ padding: "0.2rem" }}>
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          {error && (
            <div style={{ padding: "0.5rem 0.75rem", borderRadius: "6px", background: "rgba(239, 68, 68, 0.15)", color: "#f87171", fontSize: "0.85rem" }}>
              {error}
            </div>
          )}

          <div>
            <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 500, marginBottom: "0.3rem" }}>
              影视库名称
            </label>
            <input
              type="text"
              className="input"
              placeholder="如: 精选电影 / 追番动漫"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ width: "100%", padding: "0.5rem 0.75rem" }}
              required
              autoFocus
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 500, marginBottom: "0.3rem" }}>
              内容分类
            </label>
            <select
              className="input"
              value={libraryType}
              onChange={(e) => setLibraryType(e.target.value as MediaLibraryType)}
              style={{ width: "100%", padding: "0.5rem 0.75rem" }}
            >
              <option value="movie">电影 (Movie)</option>
              <option value="tv">电视剧 (TV Series)</option>
              <option value="anime">动漫番剧 (Anime)</option>
              <option value="other">综合 / 其他</option>
            </select>
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 500, marginBottom: "0.3rem" }}>
              默认播放投送策略
            </label>
            <select
              className="input"
              value={defaultDeliveryMode}
              onChange={(e) => setDefaultDeliveryMode(e.target.value as LibraryDeliveryMode)}
              style={{ width: "100%", padding: "0.5rem 0.75rem" }}
            >
              <option value="redirect">302 CDN 直连 (零服务器带宽消耗)</option>
              <option value="proxy">服务器分片代理 (破除一切防盗链与跨域限制)</option>
            </select>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", marginTop: "0.5rem" }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "创建中..." : "立即创建"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

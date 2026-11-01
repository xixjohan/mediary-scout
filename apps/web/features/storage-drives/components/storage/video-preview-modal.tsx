"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Film, X } from "lucide-react";
import type { DriveFileItem } from "@media-track/workflow";

export function VideoPreviewModal({
  item,
  storageId,
  onClose,
}: {
  item: DriveFileItem;
  storageId: string;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [copied, setCopied] = useState(false);
  const streamUrl = `/api/strm/play/${storageId}/${item.id}?name=${encodeURIComponent(item.name)}`;

  const copyAbsoluteLink = () => {
    const fullUrl = `${window.location.origin}${streamUrl}`;
    void navigator.clipboard.writeText(fullUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (!mounted) return null;
  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.8)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999, backdropFilter: "blur(6px)",
        padding: "1rem",
      }}
    >
      <div
        style={{
          background: "var(--bg-surface, #18181b)",
          border: "1px solid var(--border, #333)",
          borderRadius: "12px",
          width: "100%",
          maxWidth: "800px",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* 头部 */}
        <div
          style={{
            padding: "0.85rem 1.25rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid var(--border-subtle, #27272a)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", overflow: "hidden" }}>
            <Film size={18} style={{ flexShrink: 0, color: "var(--accent, #22c55e)" }} />
            <span
              style={{
                fontSize: "0.95rem",
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={item.name}
            >
              {item.name}
            </span>
          </div>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            style={{ padding: "0.2rem" }}
          >
            <X size={16} />
          </button>
        </div>

        {/* 视频播放器 */}
        <div style={{ background: "#000", display: "flex", justifyContent: "center", alignItems: "center", minHeight: "360px", maxHeight: "60vh" }}>
          <video
            controls
            autoPlay
            src={streamUrl}
            style={{ width: "100%", maxHeight: "60vh", outline: "none" }}
          >
            您的浏览器不支持视频播放，请复制直链到 VLC 或 PotPlayer 中播放。
          </video>
        </div>

        {/* 底部信息与复制按钮 */}
        <div
          style={{
            padding: "0.75rem 1.25rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "1rem",
            background: "var(--bg-hover, #202023)",
          }}
        >
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted, #a1a1aa)" }}>
            支持 HTTP 206 断点续传与网盘 CDN 302 极速直连
          </span>

          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={copyAbsoluteLink}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "已复制直链" : "复制 STRM 播放链"}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onClose}
            >
              完成
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

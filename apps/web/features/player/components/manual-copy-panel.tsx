"use client";

/**
 * 手动复制兜底面板。
 *
 * 当 Clipboard API 与 `document.execCommand("copy")` 都不可用时（极少数浏览器策略），
 * 直接给出可选中的地址，避免用户遇到「点了没反应」。
 */
export interface ManualCopyPanelProps {
  url: string;
  onClose: () => void;
}

export function ManualCopyPanel({ url, onClose }: ManualCopyPanelProps) {
  return (
    <div
      style={{
        position: "absolute",
        top: 68,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 40,
        width: "min(560px, calc(100% - 32px))",
        padding: "0.75rem 0.9rem",
        borderRadius: "10px",
        background: "rgba(18, 18, 18, 0.94)",
        border: "1px solid rgba(255, 255, 255, 0.18)",
        color: "#f4f4f5",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.45)",
      }}
      data-testid="manual-copy-panel"
    >
      <div style={{ fontSize: "0.78rem", color: "#a1a1aa", marginBottom: "0.4rem" }}>
        浏览器拦截了自动复制，请按 Ctrl/⌘ + C 复制下面的地址
      </div>
      <input
        readOnly
        value={url}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        aria-label="播放地址"
        style={{
          width: "100%",
          fontSize: "0.78rem",
          padding: "0.4rem 0.5rem",
          borderRadius: "6px",
          border: "1px solid rgba(255, 255, 255, 0.2)",
          background: "rgba(255, 255, 255, 0.06)",
          color: "#f4f4f5",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.4rem" }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onClose}
          style={{ fontSize: "0.75rem" }}
        >
          关闭
        </button>
      </div>
    </div>
  );
}

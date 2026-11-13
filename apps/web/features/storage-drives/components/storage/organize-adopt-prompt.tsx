"use client";

/**
 * 「尚未纳入媒体库」确认条。
 *
 * 整理需要该片处于追踪态；盘里已有的内容没有运行记录，因此需要先纳入。
 * 这里必须显式说明「不会触发下载」，否则用户会担心点了就开始自动追更。
 */
export interface OrganizeAdoptPromptProps {
  /** 为 null 时不渲染：由组件内部判断，避免在父组件里写 `&&` 增加复杂度预算。 */
  prompt: { directoryName: string } | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function OrganizeAdoptPrompt({
  prompt,
  busy,
  onConfirm,
  onCancel,
}: OrganizeAdoptPromptProps) {
  if (!prompt) return null;
  return (
    <div
      className="storage-adopt-prompt"
      data-testid="organize-adopt-prompt"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        flexWrap: "wrap",
        padding: "0.75rem 1rem",
        margin: "0.75rem 0",
        borderRadius: "10px",
        border: "1px solid rgba(250, 204, 21, 0.35)",
        background: "rgba(250, 204, 21, 0.08)",
        color: "#fde68a",
        fontSize: "0.85rem",
      }}
    >
      <span>
        「{prompt.directoryName}」尚未纳入媒体库。纳入后即可整理与归档，
        <strong style={{ color: "#fef3c7" }}>不会触发下载或追更</strong>。
      </span>
      <span style={{ display: "inline-flex", gap: "0.5rem", marginLeft: "auto" }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onConfirm}
          disabled={busy}
          style={{ fontSize: "0.8rem" }}
        >
          {busy ? "处理中…" : "纳入并整理"}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onCancel}
          disabled={busy}
          style={{ fontSize: "0.8rem" }}
        >
          取消
        </button>
      </span>
    </div>
  );
}

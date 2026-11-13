"use client";

/**
 * 「N 个文件缺少扩展名」提示条。
 *
 * 115 转存偶尔会把文件名截断在发布组后缀上（`...AAC-ColorTV`），扩展名丢失后
 * 整理器认不出这些文件。这里提供一键补后缀：服务端会先读文件头确认容器格式
 * （ftyp / EBML / RIFF+AVI / FLV / TS）再改名，判定不出来就跳过——**不猜格式**。
 */
export interface OrganizeUnrecognizedPromptProps {
  /** 为 null 时不渲染：由组件内部判断，避免在父组件里写 `&&` 增加复杂度预算。 */
  prompt: { count: number } | null;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}

export function OrganizeUnrecognizedPrompt({
  prompt,
  busy,
  onConfirm,
  onDismiss,
}: OrganizeUnrecognizedPromptProps) {
  if (!prompt) return null;
  return (
    <div
      className="storage-unrecognized-prompt"
      data-testid="organize-unrecognized-prompt"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        flexWrap: "wrap",
        padding: "0.75rem 1rem",
        margin: "0.75rem 0",
        borderRadius: "10px",
        border: "1px solid rgba(56, 189, 248, 0.35)",
        background: "rgba(56, 189, 248, 0.08)",
        color: "#bae6fd",
        fontSize: "0.85rem",
      }}
    >
      <span>
        有 <strong style={{ color: "#e0f2fe" }}>{prompt.count}</strong> 个文件缺少扩展名，未参与整理。
        补全后会先读取文件头确认真实格式再改名，
        <strong style={{ color: "#e0f2fe" }}>无法确认格式的文件会原样保留</strong>。
      </span>
      <span style={{ display: "inline-flex", gap: "0.5rem", marginLeft: "auto" }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onConfirm}
          disabled={busy}
          style={{ fontSize: "0.8rem" }}
        >
          {busy ? "识别中…" : "一键补全扩展名"}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onDismiss}
          disabled={busy}
          style={{ fontSize: "0.8rem" }}
        >
          稍后处理
        </button>
      </span>
    </div>
  );
}

"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
} from "lucide-react";
import type { ApiKeyPermissionModule } from "@media-track/shared";
import { copyText } from "../../../lib/copy-text";

export interface RevealedApiKeyModalProps {
  revealedKey: string;
  revealedKeyName: string;
  revealedKeyPermissions: string[];
  revealedAllowApi: boolean;
  revealedAllowMcp: boolean;
  catalog: ApiKeyPermissionModule[];
  onClose: () => void;
  onCopiedToast?: (msg: string, isError?: boolean) => void;
}

function buildMcpSnippets(revealedKey: string, origin: string) {
  const mcpUrl = `${origin}/api/mcp`;
  const baseMcpServer = {
    mcpServers: {
      "mediary-scout": {
        url: mcpUrl,
        headers: { Authorization: `Bearer ${revealedKey}` },
      },
    },
  };
  const cursorJson = JSON.stringify(baseMcpServer, null, 2);
  const clineJson = JSON.stringify(
    {
      mcpServers: {
        "mediary-scout": {
          url: mcpUrl,
          headers: { Authorization: `Bearer ${revealedKey}` },
          disabled: false,
          autoApprove: [
            "discoverMedia",
            "searchMedia",
            "queryStatus",
            "queryLibrary",
            "subscribeMedia",
            "listStorageFiles",
            "submitOfflineTask",
            "triggerAcquisition",
            "getSystemHealth",
          ],
        },
      },
    },
    null,
    2
  );
  return { cursorJson, claudeJson: cursorJson, clineJson };
}

function resolveActiveSnippet(
  tab: "key" | "cursor" | "claude" | "cline",
  revealedKey: string,
  snippets: ReturnType<typeof buildMcpSnippets>
) {
  switch (tab) {
    case "cursor":
      return {
        snippet: snippets.cursorJson,
        description: "Cursor IDE 配置文件。可粘贴至项目根目录的 `.cursor/mcp.json` 或 Cursor 设置中的 Features → MCP Servers。",
        guidePath: ".cursor/mcp.json",
      };
    case "claude":
      return {
        snippet: snippets.claudeJson,
        description: "Anthropic Claude Desktop 配置文件。可保存至 Claude 的配置路径。",
        guidePath: "macOS: ~/Library/Application Support/Claude/claude_desktop_config.json | Windows: %APPDATA%\\Claude\\claude_desktop_config.json",
      };
    case "cline":
      return {
        snippet: snippets.clineJson,
        description: "VS Code 扩展 Cline / Roo Code 配置文件。粘贴至插件设置里的 MCP Servers。",
        guidePath: "cline_mcp_settings.json",
      };
    case "key":
    default:
      return {
        snippet: revealedKey,
        description: "系统生成的原始 API Key。可用于 HTTP Header `Authorization: Bearer <Key>` 或第三方脚本。",
        guidePath: "",
      };
  }
}

export function RevealedApiKeyModal({
  revealedKey,
  revealedKeyName,
  revealedKeyPermissions,
  revealedAllowMcp,
  catalog,
  onClose,
  onCopiedToast,
}: RevealedApiKeyModalProps) {
  const [revealedTab, setRevealedTab] = useState<"key" | "cursor" | "claude" | "cline">("key");
  const [copied, setCopied] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const snippets = buildMcpSnippets(revealedKey, origin);
  const { snippet: activeSnippet, description: activeDescription, guidePath: activeGuidePath } =
    resolveActiveSnippet(revealedTab, revealedKey, snippets);

  const hasMcpPermissions =
    revealedKeyPermissions.includes("*") ||
    catalog.some((m) =>
      m.leaves.some((l) => l.supportsMcp && revealedKeyPermissions.includes(l.id))
    );

  const handleCopy = (text: string) => {
    void copyText(text).then((ok) => {
      if (!ok) {
        onCopiedToast?.("复制失败，请手动全选复制", true);
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "1rem",
      }}
    >
      <div
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: "12px",
          padding: "1.75rem",
          width: "100%",
          maxWidth: "680px",
          maxHeight: "92vh",
          overflowY: "auto",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "1.25rem" }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              background: "var(--bg-hover)",
              color: "var(--accent)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: "0.75rem",
            }}
          >
            <KeyRound size={24} />
          </div>
          <h3 style={{ margin: "0 0 0.4rem", fontSize: "1.25rem", fontWeight: 600 }}>API Key 已就绪</h3>
          <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-muted)" }}>
            名称: <strong>{revealedKeyName}</strong>
          </p>
        </div>

        <div
          className="notice is-warn"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "0.5rem",
            fontSize: "0.85rem",
            marginBottom: "1rem",
          }}
        >
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong>请立即复制并妥善保存此配置！</strong> 出于安全考虑，离开此窗口后，完整密钥将不再显示（数据库仅保留加盐哈希值）。
          </div>
        </div>

        <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
          <button
            type="button"
            className={`btn btn-sm ${revealedTab === "key" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setRevealedTab("key")}
          >
            纯文本 Key
          </button>
          {revealedAllowMcp && hasMcpPermissions && (
            <>
              <button
                type="button"
                className={`btn btn-sm ${revealedTab === "cursor" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setRevealedTab("cursor")}
              >
                Cursor (.cursor/mcp.json)
              </button>
              <button
                type="button"
                className={`btn btn-sm ${revealedTab === "claude" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setRevealedTab("claude")}
              >
                Claude Desktop
              </button>
              <button
                type="button"
                className={`btn btn-sm ${revealedTab === "cline" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setRevealedTab("cline")}
              >
                Cline / Roo Code
              </button>
            </>
          )}
        </div>

        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
          {activeDescription}
        </p>

        {activeGuidePath && (
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
            目标文件: <code style={{ color: "var(--accent)" }}>{activeGuidePath}</code>
          </div>
        )}

        <div
          style={{
            position: "relative",
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            padding: "0.75rem",
            marginBottom: "1.25rem",
          }}
        >
          <pre
            style={{
              margin: 0,
              fontSize: "0.85rem",
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              maxHeight: "220px",
              overflowY: "auto",
            }}
          >
            {activeSnippet}
          </pre>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => handleCopy(activeSnippet)}
            style={{
              position: "absolute",
              top: "0.5rem",
              right: "0.5rem",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.25rem",
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "已复制" : revealedTab === "key" ? "复制 Key" : "复制 JSON 配置"}
          </button>
        </div>

        <button
          type="button"
          className="btn btn-primary"
          onClick={onClose}
          style={{ width: "100%", justifyContent: "center" }}
        >
          我已复制并妥善保存
        </button>
      </div>
    </div>,
    document.body
  );
}

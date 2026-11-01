"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  ExternalLink,
  Info,
  Server,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";

export interface ApiKeyGuideTarget {
  name: string;
  keyPlaceholder: string;
  allowApi?: boolean;
  allowMcp?: boolean;
}

interface ApiKeyGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetKey?: ApiKeyGuideTarget | null;
}

export function ApiKeyGuideModal({
  isOpen,
  onClose,
  targetKey,
}: ApiKeyGuideModalProps) {
  const [activeTab, setActiveTab] = useState<"cursor" | "claude" | "cline" | "curl">("cursor");
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isOpen) {
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prevOverflow;
      };
    }
  }, [isOpen]);

  if (!isOpen || !mounted) return null;

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const mcpUrl = `${origin}/api/mcp`;
  const keyDisplay = targetKey?.keyPlaceholder ? `<${targetKey.keyPlaceholder}>` : "YOUR_API_KEY_HERE";

  const cursorJson = JSON.stringify(
    {
      mcpServers: {
        "mediary-scout": {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${keyDisplay}`,
          },
        },
      },
    },
    null,
    2
  );

  const claudeJson = JSON.stringify(
    {
      mcpServers: {
        "mediary-scout": {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${keyDisplay}`,
          },
        },
      },
    },
    null,
    2
  );

  const clineJson = JSON.stringify(
    {
      mcpServers: {
        "mediary-scout": {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${keyDisplay}`,
          },
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

  const curlSnippet = `# 1. 验证 MCP 服务健康与协议握手
curl -X POST "${mcpUrl}" \\
  -H "Authorization: Bearer ${keyDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 2. 调用媒体库 REST API 示例
curl -X GET "${origin}/api/titles?limit=10" \\
  -H "Authorization: Bearer ${keyDisplay}" \\
  -H "Content-Type: application/json"`;

  let currentSnippet = cursorJson;
  let targetPath = ".cursor/mcp.json (项目根目录) 或 Cursor 设置 -> Features -> MCP Servers";
  let tabDescription = "适用 Cursor IDE。支持智能感知、工具自动注册及在 Composer 对话中直接调用 Mediary Scout 媒体检索与采集能力。";

  if (activeTab === "claude") {
    currentSnippet = claudeJson;
    targetPath =
      "macOS: ~/Library/Application Support/Claude/claude_desktop_config.json\nWindows: %APPDATA%\\Claude\\claude_desktop_config.json";
    tabDescription = "适用 Anthropic Claude 桌面客户端。配置后重启 Claude Desktop 即可在右下角查看已挂载的 9 项 MCP 工具。";
  } else if (activeTab === "cline") {
    currentSnippet = clineJson;
    targetPath = "VS Code 扩展设置 -> Cline / Roo Code -> MCP Servers -> 配置文件 (cline_mcp_settings.json)";
    tabDescription = "适用 VS Code Cline / Roo Code 插件。内置自动授权白名单，无需每次调用都手动点击确认。";
  } else if (activeTab === "curl") {
    currentSnippet = curlSnippet;
    targetPath = "终端命令行 (Bash / Zsh / PowerShell / 自动化脚本)";
    tabDescription = "标准 HTTP REST 与 MCP JSON-RPC 调用范式，便于在 Shell 脚本或第三方程序中自动化集成。";
  }

  const handleCopy = () => {
    void navigator.clipboard.writeText(currentSnippet).then(() => {
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
          maxWidth: "720px",
          maxHeight: "92vh",
          overflowY: "auto",
        }}
      >
        {/* 头部标题与关闭按钮 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: "8px",
                background: "rgba(168, 85, 247, 0.15)",
                color: "#a855f7",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Server size={20} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 600 }}>
                {targetKey ? `客户端接入示例: ${targetKey.name}` : "外部客户端 / MCP Agent 导入示例与接入指南"}
              </h3>
              <p style={{ margin: "0.2rem 0 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                支持 Cursor、Claude Desktop、Cline (Roo Code) 及标准 REST API / JSON-RPC
              </p>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            style={{ padding: "0.25rem", border: "none", background: "transparent" }}
          >
            <X size={18} />
          </button>
        </div>

        {/* 密钥作用域提示 */}
        {targetKey ? (
          <div
            style={{
              background: "var(--bg-hover)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "8px",
              padding: "0.6rem 0.85rem",
              marginBottom: "1rem",
              fontSize: "0.82rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.75rem",
            }}
          >
            <div>
              针对 Key: <strong>{targetKey.name}</strong> (<code>{targetKey.keyPlaceholder}</code>)
              <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginTop: "0.15rem" }}>
                出于安全规范，完整密钥仅在新建时明文揭示一次。导入时请将 <code>{keyDisplay}</code> 替换为您实际保存的密钥。
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.35rem", flexShrink: 0 }}>
              {targetKey.allowApi !== false && (
                <span
                  className="badge"
                  style={{
                    fontSize: "0.7rem",
                    background: "rgba(59, 130, 246, 0.15)",
                    color: "#3b82f6",
                    border: "1px solid rgba(59, 130, 246, 0.3)",
                  }}
                >
                  REST API 可用
                </span>
              )}
              {targetKey.allowMcp !== false ? (
                <span
                  className="badge"
                  style={{
                    fontSize: "0.7rem",
                    background: "rgba(168, 85, 247, 0.15)",
                    color: "#a855f7",
                    border: "1px solid rgba(168, 85, 247, 0.3)",
                  }}
                >
                  MCP 服务可用
                </span>
              ) : (
                <span
                  className="badge is-error"
                  style={{ fontSize: "0.7rem" }}
                  title="此 Key 创建时未勾选 MCP 协议通道，外部 Agent 调用会被拦截"
                >
                  MCP 未启用
                </span>
              )}
            </div>
          </div>
        ) : (
          <div
            className="notice is-info"
            style={{
              marginBottom: "1rem",
              fontSize: "0.82rem",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <Info size={16} style={{ flexShrink: 0 }} />
            <div>
              通用配置指南：导入配置时请将 <code>YOUR_API_KEY_HERE</code> 替换为您在当前列表创建的有效 API Key。
            </div>
          </div>
        )}

        {/* 协议不匹配告警 */}
        {targetKey && activeTab !== "curl" && targetKey.allowMcp === false && (
          <div
            className="notice is-error"
            style={{
              fontSize: "0.8rem",
              marginBottom: "0.75rem",
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
            }}
          >
            <AlertTriangle size={15} style={{ flexShrink: 0 }} />
            <div>
              当前 Key <strong>未开放 MCP 协议权限</strong>。配置到 AI 客户端后，MCP 初始化握手与工具调用将被拒绝。
            </div>
          </div>
        )}

        {targetKey && activeTab === "curl" && targetKey.allowApi === false && (
          <div
            className="notice is-warn"
            style={{
              fontSize: "0.8rem",
              marginBottom: "0.75rem",
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
            }}
          >
            <AlertTriangle size={15} style={{ flexShrink: 0 }} />
            <div>
              当前 Key <strong>未开放 REST API 权限</strong>，调用 <code>/api/titles</code> 等接口将被拒绝，但 MCP 协议仍受支持。
            </div>
          </div>
        )}

        {/* Tab 导航 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.4rem",
            marginBottom: "0.75rem",
            borderBottom: "1px solid var(--border-subtle)",
            paddingBottom: "0.5rem",
          }}
        >
          <button
            type="button"
            className={`btn btn-sm ${activeTab === "cursor" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setActiveTab("cursor")}
          >
            Cursor (.cursor/mcp.json)
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === "claude" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setActiveTab("claude")}
          >
            Claude Desktop
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === "cline" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setActiveTab("cline")}
          >
            Cline / Roo Code
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === "curl" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setActiveTab("curl")}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
          >
            <Terminal size={13} /> REST API / curl
          </button>
        </div>

        {/* 说明与路径指示 */}
        <p style={{ margin: "0 0 0.4rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
          {tabDescription}
        </p>
        <div
          style={{
            fontFamily: "monospace",
            fontSize: "0.75rem",
            color: "var(--text-secondary)",
            background: "var(--bg-hover)",
            padding: "0.35rem 0.6rem",
            borderRadius: "6px",
            marginBottom: "0.75rem",
            whiteSpace: "pre-line",
          }}
        >
          配置路径: {targetPath}
        </div>

        {/* 代码展示与复制区 */}
        <div
          style={{
            background: "var(--bg-hover)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "8px",
            padding: "0.75rem 1rem",
            marginBottom: "1.25rem",
            position: "relative",
          }}
        >
          <pre
            style={{
              margin: 0,
              fontSize: "0.82rem",
              wordBreak: "break-all",
              whiteSpace: "pre-wrap",
              fontFamily: "monospace",
              maxHeight: "260px",
              overflowY: "auto",
            }}
          >
            {currentSnippet}
          </pre>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.6rem" }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleCopy}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "已复制到剪贴板" : "复制配置内容"}
            </button>
          </div>
        </div>

        {/* 底部按钮 */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

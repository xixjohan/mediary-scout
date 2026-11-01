"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { AppConfirmDialog } from "../../../components/ui/app-confirm-dialog";
import {
  AlertTriangle,
  Check,
  Cpu,
  ExternalLink,
  Plus,
  RefreshCw,
  Trash2,
  Wifi,
  X,
} from "lucide-react";

interface McpToolItem {
  name: string;
  description?: string;
  enabled: boolean;
}

interface McpServerItem {
  id: string;
  name: string;
  transportType: "sse" | "streamable_http";
  url: string;
  isActive: boolean;
  tools?: McpToolItem[];
}

export function McpServerDrawer({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [servers, setServers] = useState<McpServerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 添加服务器弹窗
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState<{
    name: string;
    transportType: "sse" | "streamable_http";
    url: string;
  }>({
    name: "",
    transportType: "sse",
    url: "http://localhost:3001/sse",
  });
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const [isPending, startTransition] = useTransition();
  const [mounted, setMounted] = useState(false);
  const [deleteConfirmServer, setDeleteConfirmServer] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const flash = (msg: string, isError = false) => {
    if (isError) {
      setErrorMessage(msg);
      setTimeout(() => setErrorMessage(null), 5000);
    } else {
      setSuccessMessage(msg);
      setTimeout(() => setSuccessMessage(null), 4000);
    }
  };

  const fetchServers = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/assistant/mcp-servers");
      if (res.ok) {
        const data = await res.json();
        setServers(Array.isArray(data) ? data : []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void fetchServers();
    }
  }, [isOpen]);

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/assistant/mcp-servers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transportType: addForm.transportType,
          url: addForm.url.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestResult({
          ok: true,
          message: `连接成功！探测到 ${data.toolsCount ?? 0} 个 MCP 扩展工具。`,
        });
      } else {
        setTestResult({
          ok: false,
          message: `连接失败: ${data.errorMessage || "请检查服务是否启动或协议是否匹配"}`,
        });
      }
    } catch (e) {
      setTestResult({
        ok: false,
        message: `网络探测异常: ${String(e)}`,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleCreateServer = (e: React.FormEvent) => {
    e.preventDefault();
    if (!addForm.name.trim() || !addForm.url.trim()) {
      flash("请完整填写服务名称与端点地址", true);
      return;
    }

    startTransition(async () => {
      try {
        const res = await fetch("/api/assistant/mcp-servers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: addForm.name.trim(),
            transportType: addForm.transportType,
            url: addForm.url.trim(),
          }),
        });
        const data = await res.json();
        if (res.ok) {
          setShowAddModal(false);
          setAddForm({ name: "", transportType: "sse", url: "http://localhost:3001/sse" });
          setTestResult(null);
          flash(`成功接入 MCP 服务: ${data.name || "新服务"}`);
          void fetchServers();
        } else {
          flash(data?.error || "添加失败", true);
        }
      } catch (e) {
        flash(String(e), true);
      }
    });
  };

  const handleDeleteServer = (id: string, name: string) => {
    setDeleteConfirmServer({ id, name });
  };

  const handleToggleTool = async (serverId: string, toolName: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/assistant/mcp-servers/${serverId}/toggle-tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName, enabled }),
      });
      if (res.ok) {
        // 本地局部更新
        setServers((prev) =>
          prev.map((s) => {
            if (s.id !== serverId || !s.tools) return s;
            return {
              ...s,
              tools: s.tools.map((t) => (t.name === toolName ? { ...t, enabled } : t)),
            };
          })
        );
      }
    } catch {
      // ignore
    }
  };

  if (!isOpen || !mounted) return null;

  return (
    <>
      {createPortal(
        <div
          style={{
            position: "fixed",
            inset: 0,
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(4px)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 9999,
      }}
    >
      <div
        style={{
          background: "var(--bg-surface)",
          borderLeft: "1px solid var(--border)",
          width: "100%",
          maxWidth: "480px",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          boxShadow: "-4px 0 24px rgba(0,0,0,0.4)",
        }}
      >
        {/* 抽屉头部 */}
        <div
          style={{
            padding: "1rem 1.25rem",
            borderBottom: "1px solid var(--border-subtle)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Cpu size={18} style={{ color: "var(--accent)" }} />
            <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>外部 MCP 工具编排</h3>
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

        {/* 提示消息 */}
        {errorMessage && (
          <div className="notice is-error" style={{ margin: "0.75rem 1.25rem 0", fontSize: "0.85rem" }}>
            {errorMessage}
          </div>
        )}
        {successMessage && (
          <div className="notice is-success" style={{ margin: "0.75rem 1.25rem 0", fontSize: "0.85rem" }}>
            {successMessage}
          </div>
        )}

        {/* 抽屉内容区 */}
        <div style={{ flex: 1, overflowY: "auto", padding: "1.25rem", display: "grid", gap: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
              接入支持 Model Context Protocol 的外部服务
            </span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setShowAddModal(true);
                setTestResult(null);
              }}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
            >
              <Plus size={14} /> 接入服务
            </button>
          </div>

          {loading && servers.length === 0 ? (
            <div className="skeleton" style={{ height: 120, borderRadius: 8 }} />
          ) : servers.length === 0 ? (
            <div style={{ textAlign: "center", padding: "3rem 1rem", color: "var(--text-muted)" }}>
              <Cpu size={36} style={{ opacity: 0.25, marginBottom: "0.5rem" }} />
              <p style={{ margin: 0, fontSize: "0.9rem" }}>暂无已关联的外部 MCP 服务</p>
              <p style={{ margin: "0.3rem 0 0", fontSize: "0.8rem" }}>
                支持通过 SSE 或 HTTP 挂载本地文件系统、B站视频解析等 MCP Server。
              </p>
            </div>
          ) : (
            <div style={{ display: "grid", gap: "0.85rem" }}>
              {servers.map((server) => (
                <div
                  key={server.id}
                  style={{
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "8px",
                    padding: "0.85rem",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <strong>{server.name}</strong>
                      <span className="badge" style={{ textTransform: "uppercase", fontSize: "0.7rem" }}>
                        {server.transportType}
                      </span>
                    </div>

                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleDeleteServer(server.id, server.name)}
                      style={{ color: "var(--color-danger, #ef4444)", padding: "0.15rem 0.35rem" }}
                      title="解绑服务"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>

                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", wordBreak: "break-all", marginBottom: "0.6rem" }}>
                    <code>{server.url}</code>
                  </div>

                  {/* 工具列表 */}
                  {server.tools && server.tools.length > 0 && (
                    <div style={{ display: "grid", gap: "0.35rem", borderTop: "1px solid var(--border-subtle)", paddingTop: "0.5rem" }}>
                      <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-muted)" }}>
                        挂载工具 ({server.tools.filter((t) => t.enabled).length}/{server.tools.length}):
                      </span>
                      {server.tools.map((t) => (
                        <label
                          key={t.name}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            fontSize: "0.8rem",
                            cursor: "pointer",
                            padding: "0.15rem 0",
                          }}
                        >
                          <span>
                            <code>{t.name}</code>
                            {t.description && (
                              <span style={{ marginLeft: 6, color: "var(--text-muted)", fontSize: "0.75rem" }}>
                                {t.description}
                              </span>
                            )}
                          </span>
                          <input
                            type="checkbox"
                            checked={t.enabled}
                            onChange={(e) => void handleToggleTool(server.id, t.name, e.target.checked)}
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 弹窗：接入 MCP 服务器 */}
        {showAddModal && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.75)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10000,
              backdropFilter: "blur(6px)",
            }}
          >
            <div
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border)",
                borderRadius: "12px",
                padding: "1.5rem",
                width: "100%",
                maxWidth: "460px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>接入外部 MCP 服务</h3>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowAddModal(false)}
                  style={{ padding: "0.2rem" }}
                >
                  <X size={16} />
                </button>
              </div>

              {testResult && (
                <div
                  style={{
                    padding: "0.6rem 0.85rem",
                    borderRadius: "6px",
                    fontSize: "0.8rem",
                    marginBottom: "1rem",
                    background: testResult.ok ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)",
                    color: testResult.ok ? "var(--accent, #22c55e)" : "var(--color-danger, #ef4444)",
                  }}
                >
                  {testResult.message}
                </div>
              )}

              <form onSubmit={handleCreateServer} style={{ display: "grid", gap: "0.85rem" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.3rem" }}>服务名称</label>
                  <input
                    type="text"
                    className="input"
                    value={addForm.name}
                    onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                    placeholder="例如: Bilibili Tools / File System"
                    required
                    style={{ width: "100%" }}
                  />
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.3rem" }}>传输协议类型</label>
                  <select
                    className="input"
                    value={addForm.transportType}
                    onChange={(e) => setAddForm({ ...addForm, transportType: e.target.value as any })}
                    style={{ width: "100%" }}
                  >
                    <option value="sse">Server-Sent Events (SSE)</option>
                    <option value="streamable_http">Streamable HTTP (JSON-RPC 2.0)</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.3rem" }}>服务端点 URL</label>
                  <input
                    type="text"
                    className="input"
                    value={addForm.url}
                    onChange={(e) => setAddForm({ ...addForm, url: e.target.value })}
                    placeholder="http://localhost:3001/sse"
                    required
                    style={{ width: "100%" }}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.5rem" }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={testing || !addForm.url.trim()}
                    onClick={handleTestConnection}
                    style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
                  >
                    <Wifi size={13} /> {testing ? "探测中..." : "测试连接"}
                  </button>

                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setShowAddModal(false)}
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary btn-sm"
                      disabled={isPending}
                    >
                      {isPending ? "保存中..." : "确认接入"}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )}
      <AppConfirmDialog
        spec={
          deleteConfirmServer
            ? {
                title: "解绑 MCP 服务",
                description: `确认解绑 MCP 服务「${deleteConfirmServer.name}」吗？\n解绑后助理将无法再调用该服务下的工具。`,
                confirmLabel: "确认解绑",
                isDanger: true,
              }
            : null
        }
        isPending={isPending}
        onConfirm={() => {
          if (!deleteConfirmServer) return;
          const { id, name } = deleteConfirmServer;
          startTransition(async () => {
            try {
              const res = await fetch(`/api/assistant/mcp-servers/${id}`, {
                method: "DELETE",
              });
              if (res.ok) {
                flash(`已移除 MCP 服务: ${name}`);
                setDeleteConfirmServer(null);
                void fetchServers();
              } else {
                flash("删除失败", true);
              }
            } catch (e) {
              flash(String(e), true);
            }
          });
        }}
        onCancel={() => setDeleteConfirmServer(null)}
      />
    </>
  );
}

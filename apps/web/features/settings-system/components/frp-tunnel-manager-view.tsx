"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock,
  ExternalLink,
  Globe,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Server,
  Square,
  Terminal,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import type { FrpTunnelLineStatus, FrpTunnelLogItem } from "@media-track/shared";
import { createPortal } from "react-dom";
import { FrpTunnelLineCard, type FrpTunnelLineViewItem } from "./frp-tunnel-line-card";
import { UserActionConfirmDialog } from "./user-action-confirm-dialog";

type TunnelLineViewItem = FrpTunnelLineViewItem;

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(val >= 100 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function FrpTunnelManagerView() {
  const [lines, setLines] = useState<TunnelLineViewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 新建穿透线路弹窗
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState({
    name: "",
    serverUrl: "https://",
    tunnelHost: "",
    apiKey: "",
    localTargetUrl: "http://localhost:3000",
  });

  // 日志查看弹窗
  const [logModalLine, setLogModalLine] = useState<TunnelLineViewItem | null>(null);
  const [logs, setLogs] = useState<FrpTunnelLogItem[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const [isPending, startTransition] = useTransition();
  const [actionLineId, setActionLineId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [deleteConfirmLine, setDeleteConfirmLine] = useState<TunnelLineViewItem | null>(null);

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

  const fetchLines = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/tunnel/lines");
      if (res.ok) {
        const data = await res.json();
        setLines(Array.isArray(data) ? data : []);
      } else {
        const err = await res.json().catch(() => null);
        flash(err?.error || "加载穿透线路失败", true);
      }
    } catch (e) {
      flash(String(e), true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchLines();
  }, []);

  const handleToggleStartStop = (line: TunnelLineViewItem) => {
    const isRunning = line.state === "Connected" || line.state === "Connecting" || line.state === "Reconnecting";
    const endpoint = isRunning ? `/api/tunnel/lines/${line.id}/stop` : `/api/tunnel/lines/${line.id}/start`;

    setActionLineId(line.id);
    startTransition(async () => {
      try {
        const res = await fetch(endpoint, { method: "POST" });
        if (res.ok) {
          flash(`已${isRunning ? "停止" : "启动"}穿透线路: ${line.name || line.id}`);
          void fetchLines();
        } else {
          const err = await res.json().catch(() => null);
          flash(err?.error || `${isRunning ? "停止" : "启动"}失败`, true);
        }
      } catch (e) {
        flash(String(e), true);
      } finally {
        setActionLineId(null);
      }
    });
  };

  const handleDeleteLine = (line: TunnelLineViewItem) => {
    setDeleteConfirmLine(line);
  };

  const handleOpenLogs = async (line: TunnelLineViewItem) => {
    setLogModalLine(line);
    setLogs(line.recentLogs || []);
    setLogsLoading(true);
    try {
      const res = await fetch(`/api/tunnel/lines/${line.id}/logs`);
      if (res.ok) {
        const data = await res.json();
        setLogs(Array.isArray(data) ? data : []);
      }
    } catch {
      // ignore
    } finally {
      setLogsLoading(false);
    }
  };

  const handleCreateLine = (e: React.FormEvent) => {
    e.preventDefault();
    if (!addForm.name.trim() || !addForm.serverUrl.trim() || !addForm.tunnelHost.trim()) {
      flash("请完整填写线路名称、服务端地址与穿透域名", true);
      return;
    }

    startTransition(async () => {
      try {
        const res = await fetch("/api/tunnel/lines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(addForm),
        });
        const data = await res.json();
        if (res.ok) {
          setShowAddModal(false);
          setAddForm({
            name: "",
            serverUrl: "https://",
            tunnelHost: "",
            apiKey: "",
            localTargetUrl: "http://localhost:3000",
          });
          flash(`成功添加穿透线路: ${data.name || data.id}`);
          void fetchLines();
        } else {
          flash(data?.error || "添加线路失败", true);
        }
      } catch (err) {
        flash(String(err), true);
      }
    });
  };

  return (
    <div className="frp-tunnel-manager">
      {/* 提示条 */}
      {errorMessage && (
        <div className="notice is-error" style={{ marginBottom: "1rem" }}>
          <AlertTriangle size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          {errorMessage}
        </div>
      )}
      {successMessage && (
        <div className="notice is-success" style={{ marginBottom: "1rem" }}>
          <Check size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          {successMessage}
        </div>
      )}

      {/* 顶部工具栏 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <p className="panel-note" style={{ margin: 0 }}>
          纯 Node.js 原生运行的轻量反向穿透客户端（内存开销 &lt; 30MB），支持 4K 原盘 302 零上行直连分发与自愈故障转移。
        </p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void fetchLines()}
            disabled={loading}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> 刷新
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setShowAddModal(true)}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
          >
            <Plus size={14} /> 添加穿透线路
          </button>
        </div>
      </div>

      {/* 线路列表 */}
      {loading && lines.length === 0 ? (
        <div className="skeleton" style={{ height: 140, borderRadius: 8 }} />
      ) : lines.length === 0 ? (
        <div className="panel" style={{ textAlign: "center", padding: "2.5rem 1rem", color: "var(--text-muted)" }}>
          <Globe size={36} style={{ opacity: 0.3, marginBottom: "0.5rem" }} />
          <p style={{ margin: "0 0 0.5rem" }}>暂无已配置的 ProxyByCF FRP 穿透线路</p>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setShowAddModal(true)}
          >
            立即添加第一条穿透线路
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.85rem" }}>
          {lines.map((line) => (
            <FrpTunnelLineCard
              key={line.id}
              line={line}
              isOperating={actionLineId === line.id && isPending}
              onOpenLogs={() => handleOpenLogs(line)}
              onToggleStartStop={() => { void handleToggleStartStop(line); }}
              onDelete={() => { void handleDeleteLine(line); }}
            />
          ))}
        </div>
      )}

      {/* 弹窗：添加穿透线路 */}
      {showAddModal && mounted &&
        createPortal(
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
            }}
          >
          <div
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              borderRadius: "12px",
              padding: "1.5rem",
              width: "100%",
              maxWidth: "540px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 600 }}>添加 ProxyByCF FRP 穿透线路</h3>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setShowAddModal(false)}
                style={{ padding: "0.2rem" }}
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleCreateLine} style={{ display: "grid", gap: "0.85rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.3rem" }}>线路名称</label>
                <input
                  type="text"
                  className="input"
                  value={addForm.name}
                  onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                  placeholder="例如: 广州家庭 NAS / 办公室主节点"
                  required
                  style={{ width: "100%" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.3rem" }}>
                  穿透服务端地址 (ProxyByCF Server URL)
                </label>
                <input
                  type="text"
                  className="input"
                  value={addForm.serverUrl}
                  onChange={(e) => setAddForm({ ...addForm, serverUrl: e.target.value })}
                  placeholder="https://frp.yourdomain.com"
                  required
                  style={{ width: "100%" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.3rem" }}>
                  自定义穿透公网域名 (Tunnel Host)
                </label>
                <input
                  type="text"
                  className="input"
                  value={addForm.tunnelHost}
                  onChange={(e) => setAddForm({ ...addForm, tunnelHost: e.target.value })}
                  placeholder="scout.home.yourdomain.com"
                  required
                  style={{ width: "100%" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.3rem" }}>
                  服务端鉴权密钥 (API Key，可选)
                </label>
                <input
                  type="password"
                  className="input"
                  value={addForm.apiKey}
                  onChange={(e) => setAddForm({ ...addForm, apiKey: e.target.value })}
                  placeholder="若穿透服务端配置了 TOKEN 则在此填写"
                  style={{ width: "100%" }}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "0.5rem" }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowAddModal(false)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isPending}
                >
                  {isPending ? "保存中..." : "保存并接入"}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* 弹窗：运行日志 */}
      {logModalLine && mounted &&
        createPortal(
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
            }}
          >
          <div
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              borderRadius: "12px",
              padding: "1.5rem",
              width: "100%",
              maxWidth: "680px",
              maxHeight: "85vh",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>
                穿透运行日志: {logModalLine.name || logModalLine.id}
              </h3>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setLogModalLine(null)}
                style={{ padding: "0.2rem" }}
              >
                <X size={16} />
              </button>
            </div>

            <div
              style={{
                flex: 1,
                overflowY: "auto",
                background: "var(--bg-hover)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "8px",
                padding: "0.75rem",
                fontFamily: "monospace",
                fontSize: "0.8rem",
                display: "grid",
                gap: "0.35rem",
                minHeight: "260px",
              }}
            >
              {logsLoading ? (
                <div style={{ color: "var(--text-muted)", textAlign: "center", padding: "1rem" }}>
                  加载日志中...
                </div>
              ) : logs.length === 0 ? (
                <div style={{ color: "var(--text-muted)", textAlign: "center", padding: "1rem" }}>
                  暂无日志记录
                </div>
              ) : (
                logs.map((log, idx) => (
                  <div key={idx} style={{ display: "flex", gap: "0.5rem" }}>
                    <span style={{ color: "var(--text-muted)" }}>[{log.timestamp.slice(11, 19)}]</span>
                    <span
                      style={{
                        color:
                          log.level === "ERROR"
                            ? "var(--color-danger, #ef4444)"
                            : log.level === "WARN"
                              ? "var(--warning, #f59e0b)"
                              : "var(--text)",
                        fontWeight: log.level === "ERROR" ? 600 : "normal",
                      }}
                    >
                      [{log.level}]
                    </span>
                    <span style={{ wordBreak: "break-all" }}>{log.message}</span>
                  </div>
                ))
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem" }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleOpenLogs(logModalLine)}
              >
                刷新日志
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 删除线路确认弹窗 */}
      <UserActionConfirmDialog
        spec={
          deleteConfirmLine
            ? {
                title: "删除穿透线路",
                description: `确认删除穿透线路「${deleteConfirmLine.name || deleteConfirmLine.id}」吗？\n删除后该线路将被立即停止并移除配置。`,
                confirmLabel: "确认删除",
                isDanger: true,
              }
            : null
        }
        isPending={isPending}
        onConfirm={() => {
          if (!deleteConfirmLine) return;
          const line = deleteConfirmLine;
          setActionLineId(line.id);
          startTransition(async () => {
            try {
              const res = await fetch(`/api/tunnel/lines/${line.id}`, { method: "DELETE" });
              if (res.ok) {
                flash(`已删除穿透线路: ${line.name || line.id}`);
                setDeleteConfirmLine(null);
                void fetchLines();
              } else {
                const err = await res.json().catch(() => null);
                flash(err?.error || "删除失败", true);
              }
            } catch (e) {
              flash(String(e), true);
            } finally {
              setActionLineId(null);
            }
          });
        }}
        onCancel={() => setDeleteConfirmLine(null)}
      />
    </div>
  );
}

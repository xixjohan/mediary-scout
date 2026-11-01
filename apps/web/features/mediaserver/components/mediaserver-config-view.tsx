"use client";

import { useEffect, useState } from "react";
import { AppConfirmDialog } from "../../../components/ui/app-confirm-dialog";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Film,
  History,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  Tv,
  Wifi,
  XCircle,
} from "lucide-react";
import type { MediaLibrary, MediaServerType, PathMapping } from "@media-track/workflow";
import { MediaServerRecordsDialog } from "./mediaserver-records-dialog";
import { EditMediaServerModal } from "./edit-mediaserver-modal";
import { AddMediaServerModal } from "./add-mediaserver-modal";

interface MediaServerViewItem {
  id: string;
  name: string;
  serverType: MediaServerType;
  hostUrl: string;
  hasToken: boolean;
  pathMappings: PathMapping[];
  isActive: boolean;
  lastSyncAt: string | null;
}

interface MediaServerCardItemProps {
  server: MediaServerViewItem;
  isRefreshing: boolean;
  isExpanded: boolean;
  libraries: MediaLibrary[];
  isLoadingLibs: boolean;
  onToggleExpand: () => void;
  onOpenRecords: () => void;
  onEdit: () => void;
  onManualRefresh: (targetPath?: string) => void;
  onDelete: () => void;
  onResyncLibraries: () => void;
}

function MediaServerCardItem({
  server,
  isRefreshing,
  isExpanded,
  libraries,
  isLoadingLibs,
  onToggleExpand,
  onOpenRecords,
  onEdit,
  onManualRefresh,
  onDelete,
  onResyncLibraries,
}: MediaServerCardItemProps) {
  const isPlex = server.serverType === "plex";

  return (
    <div
      style={{
        background: "var(--bg-card, #1e1e1e)",
        border: "1px solid var(--border, #333)",
        borderRadius: "10px",
        padding: "1.25rem",
        display: "grid",
        gap: "0.85rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.35rem" }}>
            <Server size={18} style={{ color: isPlex ? "#e5a00d" : "#52b54b" }} />
            <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>{server.name}</h3>
            <span
              style={{
                fontSize: "0.75rem",
                padding: "0.15rem 0.5rem",
                borderRadius: "999px",
                background: isPlex ? "rgba(229, 160, 13, 0.2)" : "rgba(82, 181, 75, 0.2)",
                color: isPlex ? "#e5a00d" : "#52b54b",
                fontWeight: 600,
                textTransform: "uppercase",
              }}
            >
              {server.serverType}
            </span>
            <span
              style={{
                fontSize: "0.75rem",
                padding: "0.15rem 0.5rem",
                borderRadius: "999px",
                background: server.isActive ? "rgba(34, 197, 94, 0.2)" : "rgba(107, 114, 128, 0.2)",
                color: server.isActive ? "#4ade80" : "#9ca3af",
              }}
            >
              {server.isActive ? "已启用联动" : "未启用"}
            </span>
          </div>

          <div style={{ fontSize: "0.85rem", color: "#aaa", display: "grid", gap: "0.25rem" }}>
            <div>
              主机地址：<code style={{ background: "#2a2a2a", padding: "0.1rem 0.3rem", borderRadius: "4px" }}>{server.hostUrl}</code>
            </div>

            {server.pathMappings.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
                <span>路径映射：</span>
                {server.pathMappings.map((m) => (
                  <span
                    key={m.id}
                    style={{
                      background: "#2a2a2a",
                      padding: "0.15rem 0.4rem",
                      borderRadius: "4px",
                      fontSize: "0.8rem",
                    }}
                  >
                    <code>{m.localPath}</code> ➔ <code>{m.remotePath}</code>
                  </span>
                ))}
              </div>
            )}

            {server.lastSyncAt && (
              <div style={{ color: "#777", display: "flex", alignItems: "center", gap: "0.3rem" }}>
                <Clock size={12} /> 上次刷新时间：{new Date(server.lastSyncAt).toLocaleString()}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onToggleExpand}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
          >
            <Sparkles size={14} style={{ color: "#60a5fa" }} />
            媒体库列表 {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onOpenRecords}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
          >
            <History size={14} />
            记录
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onEdit}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
            title="编辑配置"
          >
            <Pencil size={14} />
            编辑
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={isRefreshing}
            onClick={() => onManualRefresh()}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
          >
            <RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} />
            {isRefreshing ? "刷新中..." : "全库刷新"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onDelete}
            style={{ color: "#ef4444" }}
            title="删除配置"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {isExpanded && (
        <div style={{ background: "rgba(0,0,0,0.25)", border: "1px solid #333", borderRadius: "8px", padding: "0.85rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "#ccc" }}>
              Plex/Emby 远程媒体库分区（Sections）：
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onResyncLibraries}
              style={{ fontSize: "0.75rem", color: "#60a5fa" }}
            >
              重新同步 ↺
            </button>
          </div>

          {isLoadingLibs ? (
            <div style={{ padding: "1rem", textAlign: "center", color: "#888", fontSize: "0.85rem" }}>
              <RefreshCw size={16} className="animate-spin" style={{ margin: "0 auto 0.25rem" }} />
              正在连接服务器拉取媒体库列表...
            </div>
          ) : libraries.length === 0 ? (
            <div style={{ padding: "0.75rem", color: "#888", fontSize: "0.85rem" }}>
              未探测到远程媒体库分区，请确认 Token 权限或服务器内是否有创建电影/电视剧库。
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "0.5rem" }}>
              {libraries.map((lib) => (
                <div
                  key={lib.id}
                  style={{
                    background: "#222",
                    border: "1px solid #3a3a3a",
                    borderRadius: "6px",
                    padding: "0.6rem 0.75rem",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.88rem", fontWeight: 600 }}>
                      {lib.type === "movie" ? <Film size={14} style={{ color: "#38bdf8" }} /> : <Tv size={14} style={{ color: "#c084fc" }} />}
                      <span>{lib.name}</span>
                      <span style={{ fontSize: "0.7rem", color: "#888" }}>(ID: {lib.id})</span>
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "#777", marginTop: "0.2rem" }}>
                      挂载: <code>{lib.locations[0] || "未指定"}</code>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onManualRefresh(lib.locations[0])}
                    disabled={isRefreshing}
                    style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
                  >
                    局部扫描
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  );
}

export function MediaServerConfigView() {
  const [servers, setServers] = useState<MediaServerViewItem[]>([]);
  const [deleteConfirmServer, setDeleteConfirmServer] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 展开查看媒体服务器库状态
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);
  const [serverLibrariesMap, setServerLibrariesMap] = useState<Record<string, MediaLibrary[]>>({});
  const [loadingLibrariesMap, setLoadingLibrariesMap] = useState<Record<string, boolean>>({});

  // 刷新历史记录弹窗
  const [selectedServerForRecords, setSelectedServerForRecords] = useState<MediaServerViewItem | null>(null);
  const [editingServer, setEditingServer] = useState<MediaServerViewItem | null>(null);
  const [serverRecords, setServerRecords] = useState<any[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);

  const openRecordsModal = async (server: MediaServerViewItem) => {
    setSelectedServerForRecords(server);
    setRecordsLoading(true);
    try {
      const res = await fetch(`/api/mediaserver/configs/${server.id}/records`);
      if (res.ok) {
        const data = await res.json();
        setServerRecords(data.records || []);
      }
    } catch {
      // ignore
    } finally {
      setRecordsLoading(false);
    }
  };

  // 添加服务器弹窗
  const [showAddModal, setShowAddModal] = useState(false);

  const fetchServers = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/mediaserver/configs");
      if (res.ok) {
        const data = await res.json();
        setServers(data);
      }
    } catch {
      setErrorMessage("获取媒体服务器配置失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchServers();
  }, []);

  const handleToggleExpandLibraries = async (server: MediaServerViewItem) => {
    if (expandedServerId === server.id) {
      setExpandedServerId(null);
      return;
    }

    setExpandedServerId(server.id);
    if (!serverLibrariesMap[server.id]) {
      setLoadingLibrariesMap((prev) => ({ ...prev, [server.id]: true }));
      try {
        const res = await fetch(`/api/mediaserver/configs/${server.id}/libraries`);
        const data = await res.json();
        if (res.ok && data.ok) {
          setServerLibrariesMap((prev) => ({ ...prev, [server.id]: data.libraries || [] }));
        }
      } catch {
        // ignore
      } finally {
        setLoadingLibrariesMap((prev) => ({ ...prev, [server.id]: false }));
      }
    }
  };

  const handleDeleteServer = (id: string, name: string) => {
    setDeleteConfirmServer({ id, name });
  };

  const confirmDeleteServer = async (id: string, name: string) => {
try {
      const res = await fetch(`/api/mediaserver/configs/${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setActionMessage(`已删除媒体服务器: ${name}`);
        void fetchServers();
      } else {
        const data = await res.json();
        throw new Error(data.error || "删除失败");
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleManualRefresh = async (configId: string, name: string, targetPath?: string) => {
    setRefreshingId(configId);
    setErrorMessage(null);
    setActionMessage(null);

    try {
      const res = await fetch("/api/mediaserver/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configId, ...(targetPath ? { targetPath } : {}) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.errorMessage || data.error || "刷新媒体库失败");
      }
      setActionMessage(
        `媒体服务器「${name}」刷新成功！刷新媒体库: ${data.sectionsRefreshed.join(", ")}`,
      );
      void fetchServers();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingId(null);
    }
  };

  return (
    <div className="mediaserver-view-container" style={{ padding: "1.5rem" }}>
      {/* 头部导航与操作 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.5rem" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <Link href="/settings" className="btn btn-secondary btn-sm" style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
              <ArrowLeft size={14} /> 返回设置
            </Link>
            <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>影视库配置 (Plex / Emby / Jellyfin)</h1>
          </div>
          <p style={{ color: "var(--text-muted, #888)", margin: 0, fontSize: "0.9rem" }}>
            借鉴 MoviePilot 方案：关联本地影视服务器，支持入库后自动局部刷新、批量防抖聚合与容器路径映射转换。
          </p>
        </div>
        <div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setShowAddModal(true);
            }}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
          >
            <Plus size={15} /> 添加媒体服务器
          </button>
        </div>
      </div>

      {/* 消息提示 */}
      {actionMessage && (
        <div style={{ padding: "0.75rem 1rem", background: "rgba(34, 197, 94, 0.15)", border: "1px solid rgba(34, 197, 94, 0.3)", borderRadius: "8px", color: "#22c55e", marginBottom: "1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <CheckCircle2 size={16} /> {actionMessage}
        </div>
      )}
      {errorMessage && (
        <div style={{ padding: "0.75rem 1rem", background: "rgba(239, 68, 68, 0.15)", border: "1px solid rgba(239, 68, 68, 0.3)", borderRadius: "8px", color: "#ef4444", marginBottom: "1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <XCircle size={16} /> {errorMessage}
        </div>
      )}

      {/* 服务器列表 */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem", color: "#888" }}>
          <RefreshCw size={24} className="animate-spin" style={{ margin: "0 auto 0.5rem" }} />
          正在加载媒体服务器配置...
        </div>
      ) : servers.length === 0 ? (
        <div style={{ textAlign: "center", padding: "4rem 2rem", background: "var(--bg-card, #1a1a1a)", borderRadius: "12px", border: "1px dashed var(--border, #333)" }}>
          <Tv size={40} style={{ margin: "0 auto 1rem", color: "#666" }} />
          <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.1rem" }}>暂未配置媒体服务器</h3>
          <p style={{ color: "#888", fontSize: "0.9rem", maxWidth: "480px", margin: "0 auto 1.5rem" }}>
            关联 Plex、Emby 或 Jellyfin 影视库后，当影片自动入库或 STRM 更新时，系统将通过精准路径映射，自动触发后端媒体库局部静默扫描。
          </p>
          <button type="button" className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            <Plus size={15} /> 立即添加服务器
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {servers.map((server) => (
            <MediaServerCardItem
              key={server.id}
              server={server}
              isRefreshing={refreshingId === server.id}
              isExpanded={expandedServerId === server.id}
              libraries={serverLibrariesMap[server.id] || []}
              isLoadingLibs={Boolean(loadingLibrariesMap[server.id])}
              onToggleExpand={() => { void handleToggleExpandLibraries(server); }}
              onOpenRecords={() => { void openRecordsModal(server); }}
              onEdit={() => setEditingServer(server)}
              onManualRefresh={(targetPath) => { void handleManualRefresh(server.id, server.name, targetPath); }}
              onDelete={() => { void handleDeleteServer(server.id, server.name); }}
              onResyncLibraries={() => {
                setServerLibrariesMap((prev) => {
                  const copy = { ...prev };
                  delete copy[server.id];
                  return copy;
                });
                void handleToggleExpandLibraries(server);
              }}
            />
          ))}
        </div>
      )}

      {editingServer && (
        <EditMediaServerModal
          server={editingServer}
          onClose={() => setEditingServer(null)}
          onSuccess={(name) => {
            setEditingServer(null);
            setActionMessage(`成功更新媒体服务器配置: ${name}`);
            void fetchServers();
          }}
        />
      )}
      {/* Modal: 添加媒体服务器 */}
      {showAddModal && (
        <AddMediaServerModal
          onClose={() => setShowAddModal(false)}
          onSuccess={(name) => {
            setShowAddModal(false);
            setActionMessage(`成功添加媒体服务器: ${name}`);
            void fetchServers();
          }}
        />
      )}

      {/* Modal: 媒体服务器刷新历史记录 */}
      {selectedServerForRecords && (
        <MediaServerRecordsDialog
          server={selectedServerForRecords}
          records={serverRecords}
          loading={recordsLoading}
          onRefresh={() => { void openRecordsModal(selectedServerForRecords); }}
          onClose={() => setSelectedServerForRecords(null)}
        />
      )}
      <AppConfirmDialog
        spec={
          deleteConfirmServer
            ? {
                title: "删除媒体服务器配置",
                description: `确认删除媒体服务器「${deleteConfirmServer.name}」的配置吗？\n删除后已关联的 STRM 追更或同步任务将失去推送目标。`,
                confirmLabel: "确认删除",
                isDanger: true,
              }
            : null
        }
        onConfirm={async () => {
          if (!deleteConfirmServer) return;
          const { id, name } = deleteConfirmServer;
          setDeleteConfirmServer(null);
          await confirmDeleteServer(id, name);
        }}
        onCancel={() => setDeleteConfirmServer(null)}
      />
    </div>
  );
}

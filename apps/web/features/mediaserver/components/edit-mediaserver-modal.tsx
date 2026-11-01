"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Film, Folder, Plus, Sparkles, Trash2, Tv, Wifi, X } from "lucide-react";
import type { MediaLibrary, MediaServerType, PathMapping } from "@media-track/workflow";
import { LocalFolderPickerModal } from "../../strm/components/local-folder-picker-modal";

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

export function EditMediaServerModal({
  server,
  onClose,
  onSuccess,
}: {
  server: MediaServerViewItem;
  onClose: () => void;
  onSuccess: (updatedName: string) => void;
}) {
  const [form, setForm] = useState({
    name: server.name,
    serverType: server.serverType,
    hostUrl: server.hostUrl,
    apiToken: "", // 留空表示不修改已有 token
    pathMappings: server.pathMappings.length > 0
      ? [...server.pathMappings]
      : [{ id: `m_${Date.now()}`, localPath: "/data/strm/movies", remotePath: "/media/movies" }],
    isActive: server.isActive,
  });

  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 媒体库拉取与同步
  const [detectedLibraries, setDetectedLibraries] = useState<MediaLibrary[]>([]);
  const [loadingLibraries, setLoadingLibraries] = useState(false);

  // 本地目录拾取器
  const [activePickerMappingId, setActivePickerMappingId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const fetchLibraries = async () => {
    setLoadingLibraries(true);
    try {
      const res = await fetch(`/api/mediaserver/configs/${server.id}/libraries`);
      const data = await res.json();
      if (res.ok && data.ok) {
        setDetectedLibraries(data.libraries || []);
      }
    } catch {
      // 容错降级
    } finally {
      setLoadingLibraries(false);
    }
  };

  useEffect(() => {
    void fetchLibraries();
  }, [server.id]);

  const handleAddMapping = () => {
    setForm((prev) => ({
      ...prev,
      pathMappings: [
        ...prev.pathMappings,
        { id: `m_${Date.now()}`, localPath: "", remotePath: "" },
      ],
    }));
  };

  const handleRemoveMapping = (id: string) => {
    setForm((prev) => ({
      ...prev,
      pathMappings: prev.pathMappings.filter((m) => m.id !== id),
    }));
  };

  const handleApplyLibraryMapping = (lib: MediaLibrary) => {
    const remoteLoc = lib.locations[0] || (lib.type === "movie" ? "/media/movies" : "/media/tv");
    const guessedLocal = lib.type === "movie" ? "/data/strm/movies" : "/data/strm/tv";

    setForm((prev) => {
      const exists = prev.pathMappings.some((m) => m.remotePath === remoteLoc);
      if (exists) return prev;
      return {
        ...prev,
        pathMappings: [
          ...prev.pathMappings.filter((m) => m.localPath || m.remotePath),
          { id: `m_${Date.now()}`, localPath: guessedLocal, remotePath: remoteLoc },
        ],
      };
    });
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/mediaserver/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverType: form.serverType,
          hostUrl: form.hostUrl.trim(),
          apiToken: form.apiToken.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestResult({
          ok: true,
          message: `连接成功！版本: ${data.version || "未知"}，主机: ${data.serverName || "正常"}`,
        });
        void fetchLibraries();
      } else {
        setTestResult({
          ok: false,
          message: `连接失败: ${data.errorMessage || "请检查主机地址与 Token"}`,
        });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: `网络异常: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const payload: Record<string, any> = {
        name: form.name.trim(),
        serverType: form.serverType,
        hostUrl: form.hostUrl.trim(),
        pathMappings: form.pathMappings.filter((m) => m.localPath.trim() && m.remotePath.trim()),
        isActive: form.isActive,
      };
      if (form.apiToken.trim()) {
        payload.apiToken = form.apiToken.trim();
      }

      const res = await fetch(`/api/mediaserver/configs/${server.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "更新失败");
      }
      onSuccess(data.name || form.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!mounted) return null;
  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999, backdropFilter: "blur(6px)",
      }}
    >
      <div
        style={{
          background: "var(--bg-base, #18181b)",
          border: "1px solid var(--border, #333)",
          borderRadius: "12px",
          padding: "1.5rem",
          width: "100%",
          maxWidth: "620px",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600 }}>编辑媒体服务器配置</h3>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            style={{ padding: "0.2rem" }}
          >
            <X size={16} />
          </button>
        </div>

        {error && (
          <div style={{ padding: "0.75rem", background: "rgba(239, 68, 68, 0.15)", borderRadius: "6px", color: "#ef4444", fontSize: "0.85rem", marginBottom: "1rem" }}>
            {error}
          </div>
        )}

        {testResult && (
          <div
            style={{
              padding: "0.75rem",
              borderRadius: "6px",
              fontSize: "0.85rem",
              marginBottom: "1rem",
              background: testResult.ok ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)",
              color: testResult.ok ? "#22c55e" : "#ef4444",
            }}
          >
            {testResult.message}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "grid", gap: "0.85rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "0.5rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>服务器类型</label>
              <select
                className="input"
                value={form.serverType}
                onChange={(e) => setForm({ ...form, serverType: e.target.value as MediaServerType })}
                style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
              >
                <option value="plex">Plex</option>
                <option value="emby">Emby</option>
                <option value="jellyfin">Jellyfin</option>
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>服务器名称</label>
              <input
                type="text"
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
              />
            </div>
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>主机地址 (Host URL)</label>
            <input
              type="text"
              className="input"
              value={form.hostUrl}
              onChange={(e) => setForm({ ...form, hostUrl: e.target.value })}
              required
              style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>
              API Token (X-Plex-Token 或 API 密钥)
            </label>
            <input
              type="password"
              className="input"
              value={form.apiToken}
              onChange={(e) => setForm({ ...form, apiToken: e.target.value })}
              placeholder={server.hasToken ? "已保存加密凭据（留空保持不变）" : "请输入 API Token"}
              style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
            />
          </div>

          {/* 远程媒体库列表与快速映射向导 */}
          <div style={{ background: "rgba(59, 130, 246, 0.08)", border: "1px solid rgba(59, 130, 246, 0.25)", borderRadius: "8px", padding: "0.75rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", color: "#60a5fa", fontSize: "0.85rem", fontWeight: 600 }}>
                <Sparkles size={15} /> 远程媒体库同步与向导：
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void fetchLibraries()}
                disabled={loadingLibraries}
                style={{ fontSize: "0.75rem", padding: "0.15rem 0.4rem", color: "#60a5fa" }}
              >
                {loadingLibraries ? "正在拉取..." : "刷新媒体库 ↺"}
              </button>
            </div>
            {detectedLibraries.length === 0 ? (
              <p style={{ margin: 0, fontSize: "0.8rem", color: "#888" }}>
                点击右上角「刷新媒体库」可从远程 Plex/Emby 拉取最新分类并一键建立映射。
              </p>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                {detectedLibraries.map((lib) => (
                  <button
                    key={lib.id}
                    type="button"
                    onClick={() => handleApplyLibraryMapping(lib)}
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: "0.78rem", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
                  >
                    {lib.type === "movie" ? <Film size={12} /> : <Tv size={12} />}
                    {lib.name} ({lib.locations[0] || "未指定路径"}) +
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
              <label style={{ fontSize: "0.85rem", margin: 0, color: "#ccc" }}>路径映射 (Path Mappings)</label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleAddMapping}
                style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem" }}
              >
                <Plus size={12} /> 添加规则
              </button>
            </div>

            <div style={{ display: "grid", gap: "0.5rem" }}>
              {form.pathMappings.map((m, idx) => (
                <div
                  key={m.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                  }}
                >
                  <div style={{ flex: 1, display: "flex", gap: "0.25rem" }}>
                    <input
                      type="text"
                      className="input"
                      value={m.localPath}
                      placeholder="本地 STRM 目录，如 /data/strm/movies"
                      onChange={(e) => {
                        const updated = [...form.pathMappings];
                        updated[idx] = { ...m, localPath: e.target.value };
                        setForm({ ...form, pathMappings: updated });
                      }}
                      style={{ flex: 1, padding: "0.4rem", borderRadius: "4px", background: "#222", border: "1px solid #444", color: "#fff", fontSize: "0.85rem" }}
                    />
                    <button
                      type="button"
                      onClick={() => setActivePickerMappingId(m.id)}
                      title="可视化选择本地目录"
                      className="btn btn-secondary btn-sm"
                      style={{ padding: "0.35rem 0.5rem" }}
                    >
                      <Folder size={13} style={{ color: "#34d399" }} />
                    </button>
                  </div>
                  <span style={{ color: "#888", fontSize: "0.8rem" }}>➔</span>
                  <input
                    type="text"
                    className="input"
                    value={m.remotePath}
                    placeholder="媒体服务器容器映射路径，如 /media/movies"
                    onChange={(e) => {
                      const updated = [...form.pathMappings];
                      updated[idx] = { ...m, remotePath: e.target.value };
                      setForm({ ...form, pathMappings: updated });
                    }}
                    style={{ flex: 1, padding: "0.4rem", borderRadius: "4px", background: "#222", border: "1px solid #444", color: "#fff", fontSize: "0.85rem" }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handleRemoveMapping(m.id)}
                    style={{ padding: "0.35rem", color: "#ef4444" }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: "0.5rem",
              paddingTop: "0.75rem",
              borderTop: "1px solid #333",
            }}
          >
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => { void handleTest(); }}
              disabled={testing}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
            >
              <Wifi size={14} /> {testing ? "测试中..." : "测试连接"}
            </button>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? "保存中..." : "保存修改"}
              </button>
            </div>
          </div>
        </form>

        {/* 映射行的本地物理目录选择器 */}
        {activePickerMappingId && (
          <LocalFolderPickerModal
            initialPath={form.pathMappings.find((m) => m.id === activePickerMappingId)?.localPath || "/data/strm"}
            onSelect={(selectedPath) => {
              setForm((prev) => ({
                ...prev,
                pathMappings: prev.pathMappings.map((m) =>
                  m.id === activePickerMappingId ? { ...m, localPath: selectedPath } : m,
                ),
              }));
              setActivePickerMappingId(null);
            }}
            onClose={() => setActivePickerMappingId(null)}
          />
        )}
      </div>
    </div>,
    document.body
  );
}

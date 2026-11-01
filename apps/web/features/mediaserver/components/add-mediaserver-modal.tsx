"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, Film, Plus, Sparkles, Trash2, Tv, Wifi, X } from "lucide-react";
import type { MediaLibrary, MediaServerType, PathMapping } from "@media-track/workflow";
import { LocalFolderPickerModal } from "../../strm/components/local-folder-picker-modal";

export function AddMediaServerModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (name: string) => void;
}) {
  const [addForm, setAddForm] = useState<{
    name: string;
    serverType: MediaServerType;
    hostUrl: string;
    apiToken: string;
    pathMappings: PathMapping[];
  }>({
    name: "",
    serverType: "plex",
    hostUrl: "http://192.168.1.100:32400",
    apiToken: "",
    pathMappings: [{ id: "m_1", localPath: "/data/strm/movies", remotePath: "/media/movies" }],
  });

  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testingForm, setTestingForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detectedLibraries, setDetectedLibraries] = useState<MediaLibrary[]>([]);
  const [loadingLibraries, setLoadingLibraries] = useState(false);

  // 本地目录拾取器状态
  const [activePickerMappingId, setActivePickerMappingId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const handleAddMapping = () => {
    setAddForm((prev) => ({
      ...prev,
      pathMappings: [
        ...prev.pathMappings,
        { id: `m_${Date.now()}`, localPath: "", remotePath: "" },
      ],
    }));
  };

  const handleRemoveMapping = (id: string) => {
    setAddForm((prev) => ({
      ...prev,
      pathMappings: prev.pathMappings.filter((m) => m.id !== id),
    }));
  };

  const handleApplyLibraryMapping = (lib: MediaLibrary) => {
    const remoteLoc = lib.locations[0] || (lib.type === "movie" ? "/media/movies" : "/media/tv");
    const guessedLocal = lib.type === "movie" ? "/data/strm/movies" : "/data/strm/tv";

    setAddForm((prev) => {
      // 检查是否已有对应 remotePath
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

  const handleTestAndProbe = async () => {
    if (!addForm.hostUrl || !addForm.apiToken) {
      setTestResult({ ok: false, message: "请先填写主机地址和 Token" });
      return;
    }
    setTestingForm(true);
    setLoadingLibraries(true);
    setTestResult(null);

    try {
      // 1. 探活测试
      const testRes = await fetch("/api/mediaserver/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverType: addForm.serverType,
          hostUrl: addForm.hostUrl,
          apiToken: addForm.apiToken,
        }),
      });
      const testData = await testRes.json();

      if (!testRes.ok || !testData.ok) {
        throw new Error(testData.errorMessage || testData.error || "连接失败");
      }

      // 2. 探测拉取远程媒体库列表
      const probeRes = await fetch("/api/mediaserver/probe-libraries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverType: addForm.serverType,
          hostUrl: addForm.hostUrl,
          apiToken: addForm.apiToken,
        }),
      });
      const probeData = await probeRes.json();
      const libs: MediaLibrary[] = Array.isArray(probeData.libraries) ? probeData.libraries : [];
      setDetectedLibraries(libs);

      setTestResult({
        ok: true,
        message: `连接成功！版本: ${testData.version || "正常"}，检测到 ${libs.length} 个媒体库。`,
      });
    } catch (err) {
      setTestResult({
        ok: false,
        message: `连接异常: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setTestingForm(false);
      setLoadingLibraries(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/mediaserver/configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: addForm.name,
          serverType: addForm.serverType,
          hostUrl: addForm.hostUrl,
          apiToken: addForm.apiToken,
          pathMappings: addForm.pathMappings.filter((m) => m.localPath && m.remotePath),
          isActive: true,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "保存失败");
      }

      onSuccess(addForm.name);
    } catch (err) {
      setTestResult({ ok: false, message: `保存失败: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;
  return createPortal(
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
      <div style={{ background: "var(--bg-base, #18181b)", border: "1px solid var(--border, #333)", borderRadius: "12px", padding: "1.5rem", width: "100%", maxWidth: "620px", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600 }}>添加媒体服务器</h3>
          <button type="button" onClick={onClose} className="btn btn-ghost" style={{ padding: "0.25rem" }}>
            <X size={18} />
          </button>
        </div>

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

        <form onSubmit={handleSave} style={{ display: "grid", gap: "0.85rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "0.5rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>服务器类型</label>
              <select
                className="input"
                value={addForm.serverType}
                onChange={(e) => setAddForm({ ...addForm, serverType: e.target.value as MediaServerType })}
                style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
              >
                <option value="plex">Plex Media Server</option>
                <option value="emby">Emby</option>
                <option value="jellyfin">Jellyfin</option>
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>服务器名称</label>
              <input
                type="text"
                required
                className="input"
                value={addForm.name}
                onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                placeholder="如：客厅 Plex"
                style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
              />
            </div>
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>主机地址 (Host URL)</label>
            <input
              type="text"
              required
              className="input"
              value={addForm.hostUrl}
              onChange={(e) => setAddForm({ ...addForm, hostUrl: e.target.value })}
              placeholder="如 http://192.168.1.100:32400 或 http://192.168.1.100:8096"
              style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc" }}>
              {addForm.serverType === "plex" ? "X-Plex-Token" : "API Key / Token"}
            </label>
            <input
              type="password"
              required
              className="input"
              value={addForm.apiToken}
              onChange={(e) => setAddForm({ ...addForm, apiToken: e.target.value })}
              placeholder="请输入访问凭据（安全落盘加密）"
              style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff" }}
            />
          </div>

          {/* 探测到的媒体库与智能映射向导 */}
          {detectedLibraries.length > 0 && (
            <div style={{ background: "rgba(59, 130, 246, 0.08)", border: "1px solid rgba(59, 130, 246, 0.25)", borderRadius: "8px", padding: "0.75rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", marginBottom: "0.5rem", color: "#60a5fa", fontSize: "0.85rem", fontWeight: 600 }}>
                <Sparkles size={15} /> 检测到远程媒体库（点击一键关联映射）：
              </div>
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
            </div>
          )}

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
              <label style={{ fontSize: "0.85rem", color: "#ccc" }}>
                路径映射 (Local STRM ➔ Remote Server Path)
              </label>
              <button
                type="button"
                onClick={handleAddMapping}
                className="btn btn-secondary btn-sm"
                style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
              >
                + 添加一组映射
              </button>
            </div>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {addForm.pathMappings.map((m, index) => (
                <div key={m.id} style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                  <div style={{ flex: 1, display: "flex", gap: "0.25rem" }}>
                    <input
                      type="text"
                      placeholder="本地 STRM 目录，如 /data/strm/movies"
                      value={m.localPath}
                      onChange={(e) => {
                        const updated = [...addForm.pathMappings];
                        updated[index]!.localPath = e.target.value;
                        setAddForm({ ...addForm, pathMappings: updated });
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
                  <span>➔</span>
                  <input
                    type="text"
                    placeholder="媒体服务器容器映射路径，如 /media/movies"
                    value={m.remotePath}
                    onChange={(e) => {
                      const updated = [...addForm.pathMappings];
                      updated[index]!.remotePath = e.target.value;
                      setAddForm({ ...addForm, pathMappings: updated });
                    }}
                    style={{ flex: 1, padding: "0.4rem", borderRadius: "4px", background: "#222", border: "1px solid #444", color: "#fff", fontSize: "0.85rem" }}
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveMapping(m.id)}
                    className="btn btn-ghost"
                    style={{ padding: "0.35rem", color: "#ef4444" }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "1rem", paddingTop: "0.75rem", borderTop: "1px solid #333" }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => { void handleTestAndProbe(); }}
              disabled={testingForm}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
            >
              <Wifi size={14} /> {testingForm ? "测试并拉取媒体库中..." : "测试连接并拉取媒体库"}
            </button>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "保存中..." : "保存配置"}
              </button>
            </div>
          </div>
        </form>

        {/* 映射行的本地物理目录选择器 */}
        {activePickerMappingId && (
          <LocalFolderPickerModal
            initialPath={addForm.pathMappings.find((m) => m.id === activePickerMappingId)?.localPath || "/data/strm"}
            onSelect={(selectedPath) => {
              setAddForm((prev) => ({
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

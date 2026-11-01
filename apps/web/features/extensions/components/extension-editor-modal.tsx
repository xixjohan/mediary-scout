"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AppConfirmDialog } from "../../../components/ui/app-confirm-dialog";
import { Play, RotateCcw, Save, X, Terminal, Clock } from "lucide-react";
import type { ExtensionEntity, SandboxExecutionResult, DynamicProviderSearchResult } from "@media-track/workflow";

interface SnapshotItem {
  id: string;
  createdAt: number;
  author?: string;
  file: string;
}

function CodeTabPane({
  code,
  loadingCode,
  onChange,
}: {
  code: string;
  loadingCode: boolean;
  onChange: (val: string) => void;
}) {
  if (loadingCode) {
    return (
      <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>
        正在读取扩展源代码...
      </div>
    );
  }
  return (
    <div style={{ flex: 1, padding: "0.75rem", display: "flex", flexDirection: "column" }}>
      <textarea
        value={code}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: 1,
          width: "100%",
          fontFamily: "Consolas, Monaco, monospace",
          fontSize: "0.85rem",
          lineHeight: "1.5",
          backgroundColor: "#111418",
          color: "#e2e8f0",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          padding: "0.75rem",
          resize: "none",
          outline: "none",
        }}
        spellCheck={false}
      />
    </div>
  );
}

function DebugTabPane({
  keyword,
  debugging,
  debugResult,
  onKeywordChange,
  onRun,
}: {
  keyword: string;
  debugging: boolean;
  debugResult: SandboxExecutionResult<DynamicProviderSearchResult> | null;
  onKeywordChange: (val: string) => void;
  onRun: () => void;
}) {
  return (
    <div style={{ flex: 1, padding: "1.25rem", overflowY: "auto", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
        <input
          type="text"
          value={keyword}
          onChange={(e) => onKeywordChange(e.target.value)}
          placeholder="输入测试搜索关键词..."
          className="input"
          style={{ flex: 1 }}
        />
        <button
          onClick={onRun}
          disabled={debugging}
          className="btn btn-primary"
          style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
        >
          <Play size={14} /> {debugging ? "沙箱执行中..." : "执行搜索测试"}
        </button>
      </div>

      {debugResult && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--bg-elevated)",
            padding: "1rem",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <Terminal size={16} />
              <strong>沙箱执行反馈</strong>
              <span className={`badge ${debugResult.success ? "badge-success" : "badge-error"}`}>
                {debugResult.success ? "SUCCESS" : "ERROR"}
              </span>
            </div>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
              耗时: {debugResult.durationMs}ms
              {debugResult.memoryUsageBytes ? ` · 内存: ${(debugResult.memoryUsageBytes / 1024 / 1024).toFixed(1)}MB` : ""}
            </span>
          </div>

          {debugResult.error && (
            <div style={{ color: "var(--color-danger)", padding: "0.5rem 0", fontSize: "0.85rem" }}>
              执行异常: {debugResult.error}
            </div>
          )}

          {debugResult.data && (
            <div>
              <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                匹配资源条数: {debugResult.data.candidates?.length ?? 0} 条
              </div>
              <pre
                style={{
                  backgroundColor: "#111418",
                  padding: "0.75rem",
                  borderRadius: "var(--radius-sm)",
                  maxHeight: "240px",
                  overflowY: "auto",
                  fontSize: "0.8rem",
                  color: "#e2e8f0",
                }}
              >
                {JSON.stringify(debugResult.data, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SnapshotsTabPane({
  snapshots,
  loadingSnapshots,
  onRollback,
}: {
  snapshots: SnapshotItem[];
  loadingSnapshots: boolean;
  onRollback: (snapshotId: string) => void;
}) {
  if (loadingSnapshots) {
    return <div style={{ padding: "1.25rem", color: "var(--text-muted)" }}>正在读取历史快照...</div>;
  }
  if (snapshots.length === 0) {
    return <div style={{ padding: "1.25rem", color: "var(--text-muted)" }}>暂无历史快照，保存代码时将自动创建。</div>;
  }
  return (
    <div style={{ flex: 1, padding: "1.25rem", overflowY: "auto", display: "grid", gap: "0.6rem" }}>
      {snapshots.map((s) => (
        <div
          key={s.id}
          style={{
            padding: "0.75rem 1rem",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--bg-elevated)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <strong>快照: {s.id.slice(0, 12)}</strong>
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
              {new Date(s.createdAt).toLocaleString()} · 文件: {s.file}
            </div>
          </div>
          <button
            onClick={() => onRollback(s.id)}
            className="btn btn-secondary"
            style={{ fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "0.3rem" }}
          >
            <RotateCcw size={13} /> 回滚至该版本
          </button>
        </div>
      ))}
    </div>
  );
}

export function ExtensionEditorModal({
  extension,
  onClose,
}: {
  extension: ExtensionEntity;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"code" | "debug" | "snapshots">("code");
  const [code, setCode] = useState<string>("");
  const [loadingCode, setLoadingCode] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  // Debug run
  const [keyword, setKeyword] = useState("庆余年");
  const [debugging, setDebugging] = useState(false);
  const [debugResult, setDebugResult] = useState<SandboxExecutionResult<DynamicProviderSearchResult> | null>(null);

  // Snapshots
  const [snapshots, setSnapshots] = useState<SnapshotItem[]>([]);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);
  const [rollbackStatus, setRollbackStatus] = useState<string | null>(null);
  const [rollbackSnapshotId, setRollbackSnapshotId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // 1. 加载代码
  useEffect(() => {
    let active = true;
    const fetchCode = async () => {
      setLoadingCode(true);
      try {
        const res = await fetch(`/api/extensions/${encodeURIComponent(extension.manifest.id)}/code`);
        const json = await res.json();
        if (active && json.content) {
          setCode(json.content);
        }
      } catch (err) {
        console.error("加载代码失败:", err);
      } finally {
        if (active) setLoadingCode(false);
      }
    };
    void fetchCode();
    return () => {
      active = false;
    };
  }, [extension.manifest.id]);

  // 2. 保存代码
  const handleSaveCode = async () => {
    setSaving(true);
    setSaveStatus(null);
    try {
      const res = await fetch(`/api/extensions/${encodeURIComponent(extension.manifest.id)}/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: extension.manifest.entry, content: code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存失败");
      setSaveStatus(`✅ 代码已保存并生成快照 (${data.snapshotId?.slice(0, 8)})`);
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err) {
      setSaveStatus(`❌ ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  // 3. 执行沙箱调试
  const handleDebugRun = async () => {
    setDebugging(true);
    setDebugResult(null);
    try {
      const res = await fetch(`/api/extensions/${encodeURIComponent(extension.manifest.id)}/debug-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword }),
      });
      const data = (await res.json()) as SandboxExecutionResult<DynamicProviderSearchResult>;
      setDebugResult(data);
    } catch (err) {
      setDebugResult({
        success: false,
        error: (err as Error).message,
        durationMs: 0,
      });
    } finally {
      setDebugging(false);
    }
  };

  // 4. 加载快照历史
  const handleLoadSnapshots = async () => {
    setActiveTab("snapshots");
    setLoadingSnapshots(true);
    try {
      const res = await fetch(`/api/extensions/${encodeURIComponent(extension.manifest.id)}/snapshots`);
      const data = await res.json();
      if (data.snapshots) {
        setSnapshots(data.snapshots);
      }
    } catch (err) {
      console.error("加载快照列表失败:", err);
    } finally {
      setLoadingSnapshots(false);
    }
  };

  // 5. 回滚指定快照
  const handleRollback = (snapshotId: string) => {
    setRollbackSnapshotId(snapshotId);
  };

  const executeRollback = async (snapshotId: string) => {
setRollbackStatus(null);
    try {
      const res = await fetch(`/api/extensions/${encodeURIComponent(extension.manifest.id)}/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: extension.manifest.entry, snapshotId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "回滚失败");
      setRollbackStatus(`✅ 已回滚至快照 ${snapshotId.slice(0, 8)}`);
      const codeRes = await fetch(`/api/extensions/${encodeURIComponent(extension.manifest.id)}/code`);
      const codeJson = await codeRes.json();
      if (codeJson.content) {
        setCode(codeJson.content);
      }
      setTimeout(() => setRollbackStatus(null), 3000);
    } catch (err) {
      setRollbackStatus(`❌ ${(err as Error).message}`);
    }
  };

  if (!mounted) return null;

  return (
    <>
      {createPortal(
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            backdropFilter: "blur(6px)",
            padding: "1rem",
          }}
        >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: "880px",
          height: "85vh",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-heavy)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "1rem 1.25rem",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "1.1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span>📦 扩展代码调试与备忘录:</span>
              <code>{extension.manifest.name}</code>
              <span className="badge" style={{ fontSize: "0.75rem" }}>{extension.manifest.id}</span>
            </h3>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
              入口文件: <code>{extension.manifest.entry}</code> · 原生沙箱 Fork 进程隔离保护
            </p>
          </div>
          <button onClick={onClose} className="btn btn-ghost" style={{ padding: "0.4rem" }}>
            <X size={18} />
          </button>
        </div>

        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            padding: "0.5rem 1.25rem",
            borderBottom: "1px solid var(--border)",
            backgroundColor: "var(--bg-elevated)",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => setActiveTab("code")}
            className={`btn ${activeTab === "code" ? "btn-primary" : "btn-ghost"}`}
            style={{ fontSize: "0.85rem", padding: "0.3rem 0.8rem" }}
          >
            💻 代码热编辑
          </button>
          <button
            onClick={() => setActiveTab("debug")}
            className={`btn ${activeTab === "debug" ? "btn-primary" : "btn-ghost"}`}
            style={{ fontSize: "0.85rem", padding: "0.3rem 0.8rem" }}
          >
            <Play size={13} style={{ marginRight: "0.3rem" }} /> 沙箱调试探针
          </button>
          <button
            onClick={() => { void handleLoadSnapshots(); }}
            className={`btn ${activeTab === "snapshots" ? "btn-primary" : "btn-ghost"}`}
            style={{ fontSize: "0.85rem", padding: "0.3rem 0.8rem" }}
          >
            <Clock size={13} style={{ marginRight: "0.3rem" }} /> 备忘录快照历史
          </button>

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {saveStatus && <span style={{ fontSize: "0.8rem" }}>{saveStatus}</span>}
            {rollbackStatus && <span style={{ fontSize: "0.8rem" }}>{rollbackStatus}</span>}
            {activeTab === "code" && (
              <button
                onClick={() => { void handleSaveCode(); }}
                disabled={saving || loadingCode}
                className="btn btn-primary"
                style={{ fontSize: "0.85rem", padding: "0.3rem 0.8rem", display: "flex", alignItems: "center", gap: "0.3rem" }}
              >
                <Save size={13} /> {saving ? "保存中..." : "保存更改"}
              </button>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {activeTab === "code" && (
            <CodeTabPane
              code={code}
              loadingCode={loadingCode}
              onChange={(val) => setCode(val)}
            />
          )}

          {activeTab === "debug" && (
            <DebugTabPane
              keyword={keyword}
              debugging={debugging}
              debugResult={debugResult}
              onKeywordChange={(val) => setKeyword(val)}
              onRun={() => { void handleDebugRun(); }}
            />
          )}

          {activeTab === "snapshots" && (
            <SnapshotsTabPane
              snapshots={snapshots}
              loadingSnapshots={loadingSnapshots}
              onRollback={(snapshotId) => { void handleRollback(snapshotId); }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  )}
      <AppConfirmDialog
        spec={
          rollbackSnapshotId
            ? {
                title: "回滚代码快照",
                description: `确定回滚至快照 ${rollbackSnapshotId.slice(0, 8)} 吗？当前未保存的修改将被覆盖。`,
                confirmLabel: "确认回滚",
                isDanger: true,
              }
            : null
        }
        onConfirm={async () => {
          if (!rollbackSnapshotId) return;
          const sid = rollbackSnapshotId;
          setRollbackSnapshotId(null);
          await executeRollback(sid);
        }}
        onCancel={() => setRollbackSnapshotId(null)}
      />
    </>
  );
}

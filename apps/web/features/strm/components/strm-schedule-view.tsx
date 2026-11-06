"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  FolderSync,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";
import type { StrmTask } from "@media-track/workflow";
import { StrmRecordsDialog } from "./strm-records-dialog";
import { StrmTaskCard } from "./strm-task-card";
import { EditStrmTaskModal } from "./edit-strm-task-modal";
import { StrmCreateTaskModal } from "./create-strm-task-modal";

interface StorageItem {
  id: string;
  name: string;
  provider: string;
}

function StrmDeleteConfirmDialog({
  taskName,
  purgeLocalFiles,
  deleteBusy,
  onTogglePurge,
  onCancel,
  onConfirm,
}: {
  taskName: string;
  purgeLocalFiles: boolean;
  deleteBusy: boolean;
  onTogglePurge: (val: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return createPortal(
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
      <div style={{ background: "var(--bg-base, #18181b)", border: "1px solid var(--border, #333)", borderRadius: "12px", padding: "1.5rem", width: "100%", maxWidth: "450px" }}>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "1.15rem", color: "#ef4444", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Trash2 size={18} /> 确认删除 STRM 同步任务
        </h3>
        <p style={{ color: "#ccc", fontSize: "0.9rem", margin: "0 0 1rem" }}>
          您确认要删除任务「<strong>{taskName}</strong>」吗？删除后系统将停止该任务的定时扫描。
        </p>

        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", color: "#fbbf24", marginBottom: "1.25rem", cursor: "pointer", background: "rgba(234, 179, 8, 0.1)", padding: "0.5rem 0.75rem", borderRadius: "6px" }}>
          <input
            type="checkbox"
            checked={purgeLocalFiles}
            onChange={(e) => onTogglePurge(e.target.checked)}
          />
          <span>同时清理本地目录中由该任务生成的 .strm 文件</span>
        </label>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={deleteBusy}>
            取消
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={deleteBusy}>
            {deleteBusy ? "正在删除..." : "确认删除"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function StrmReplaceBaseUrlModal({
  tasks,
  onClose,
  onSuccess,
}: {
  tasks: StrmTask[];
  onClose: () => void;
  onSuccess: (resultMsg: string) => void;
}) {
  const taskDirs = Array.from(new Set(tasks.map((t) => t.localOutputDir?.trim()).filter(Boolean) as string[]));
  const defaultUrl = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";

  const [newBaseUrl, setNewBaseUrl] = useState(defaultUrl);
  const [useCustomDir, setUseCustomDir] = useState(false);
  const [customDirectory, setCustomDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const payload: { newBaseUrl: string; directoryPath?: string } = {
        newBaseUrl: newBaseUrl.trim(),
      };
      if (useCustomDir && customDirectory.trim()) {
        payload.directoryPath = customDirectory.trim();
      }

      const res = await fetch("/api/strm/replace-base-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "替换基址失败");
      const dirCount = data.directories?.length ?? (useCustomDir ? 1 : taskDirs.length);
      onSuccess(`替换完成：已扫描 ${dirCount} 个任务目录下的 ${data.total} 个 .strm 文件，秒级更新 ${data.updated} 个，失败 ${data.errors?.length || 0} 个（0 网盘 API 调用）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
      <div style={{ background: "var(--bg-base, #18181b)", border: "1px solid var(--border, #333)", borderRadius: "12px", padding: "1.5rem", width: "100%", maxWidth: "540px" }}>
        <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.2rem", fontWeight: 600 }}>极速批量修改播放基址</h3>
        <p style={{ color: "#888", fontSize: "0.85rem", marginBottom: "1rem" }}>
          当内网 IP 变动或启用公网域名 / FRP 穿透时，使用正则秒级重写本地所有 .strm 文件前缀。不发起任何网盘 API 请求，纯本地磁盘毫秒级完成。
        </p>

        {error && (
          <div style={{ padding: "0.75rem", background: "rgba(239, 68, 68, 0.15)", borderRadius: "6px", color: "#ef4444", fontSize: "0.85rem", marginBottom: "1rem" }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "grid", gap: "0.95rem" }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
              <label style={{ fontSize: "0.85rem", color: "#ccc", fontWeight: 500 }}>
                目标 STRM 输出目录
              </label>
              <button
                type="button"
                onClick={() => setUseCustomDir(!useCustomDir)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#60a5fa",
                  fontSize: "0.75rem",
                  cursor: "pointer",
                  textDecoration: "underline",
                  padding: 0,
                }}
              >
                {useCustomDir ? "切换回全部任务目录" : "自定义特定目录"}
              </button>
            </div>

            {!useCustomDir ? (
              <div style={{ padding: "0.75rem", background: "rgba(255, 255, 255, 0.04)", border: "1px solid #333", borderRadius: "8px" }}>
                <div style={{ fontSize: "0.78rem", color: "#9ca3af", marginBottom: "0.4rem" }}>
                  ⚡ 已自动汇聚当前全部任务输出路径（共 {taskDirs.length} 个目录）：
                </div>
                {taskDirs.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                    {taskDirs.map((dir) => (
                      <div
                        key={dir}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.4rem",
                          fontSize: "0.8rem",
                          color: "#60a5fa",
                          background: "rgba(59, 130, 246, 0.1)",
                          padding: "0.3rem 0.5rem",
                          borderRadius: "4px",
                          border: "1px solid rgba(59, 130, 246, 0.25)",
                          fontFamily: "monospace",
                          wordBreak: "break-all",
                        }}
                      >
                        <span>📁</span>
                        <span>{dir}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: "0.8rem", color: "#facc15" }}>
                    ⚠️ 尚未配置任何 STRM 任务，可点击右上角「自定义特定目录」手动输入路径。
                  </div>
                )}
              </div>
            ) : (
              <div>
                <input
                  type="text"
                  required
                  className="input"
                  value={customDirectory}
                  onChange={(e) => setCustomDirectory(e.target.value)}
                  placeholder="输入本地特定目录，如 E:\\LinuxWork\\Test 或 /data/strm"
                  style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff", fontSize: "0.85rem" }}
                />
                <span style={{ fontSize: "0.75rem", color: "#888", marginTop: "0.2rem", display: "block" }}>
                  提示：将仅重写此目录及其子文件夹下的 .strm 文件
                </span>
              </div>
            )}
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", color: "#ccc", fontWeight: 500 }}>
              新播放基址 (New Base URL)
            </label>
            <input
              type="text"
              required
              className="input"
              value={newBaseUrl}
              onChange={(e) => setNewBaseUrl(e.target.value)}
              placeholder="如 http://192.168.1.100:3000 或 https://media.example.com"
              style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "#222", border: "1px solid #444", color: "#fff", fontSize: "0.85rem" }}
            />
            <span style={{ fontSize: "0.75rem", color: "#888", marginTop: "0.2rem", display: "block" }}>
              当前页面访问基址已默认回填，可直接使用或替换为局域网 IP / 公网反代域名
            </span>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              关闭
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || (!useCustomDir && taskDirs.length === 0 && !customDirectory.trim())}
            >
              {busy ? "正在极速替换..." : "开始批量替换"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

export function StrmScheduleView({ storages }: { storages: StorageItem[] }) {
  const [tasks, setTasks] = useState<StrmTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 编辑任务模态框状态
  const [editingTask, setEditingTask] = useState<StrmTask | null>(null);

  // 删除任务确认对话框状态
  const [deletingTask, setDeletingTask] = useState<{ id: string; name: string } | null>(null);
  const [purgeLocalFiles, setPurgeLocalFiles] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // 新建任务弹窗及基址替换
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showReplaceModal, setShowReplaceModal] = useState(false);

  // 执行记录弹窗与实时进度
  const [selectedTaskForRecords, setSelectedTaskForRecords] = useState<StrmTask | null>(null);
  const [taskRecords, setTaskRecords] = useState<any[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);

  const openRecordsModal = async (task: StrmTask) => {
    setSelectedTaskForRecords(task);
    setRecordsLoading(true);
    try {
      const res = await fetch(`/api/strm/tasks/${task.id}/records`);
      if (res.ok) {
        const data = await res.json();
        setTaskRecords(data.records || []);
      }
    } catch {
      // ignore
    } finally {
      setRecordsLoading(false);
    }
  };

  const fetchTasks = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/strm/tasks");
      if (res.ok) {
        const data = await res.json();
        setTasks(data);
      }
    } catch {
      setErrorMessage("获取 STRM 任务列表失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchTasks();
  }, []);

  const handleToggleActive = async (task: StrmTask) => {
    try {
      const isCurrentlyPaused = task.status === "paused" || task.isActive === false;
      const nextActive = isCurrentlyPaused;
      const res = await fetch(`/api/strm/tasks/${task.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isActive: nextActive,
          status: nextActive ? "idle" : "paused",
        }),
      });
      if (res.ok) {
        setActionMessage(`任务「${task.name}」已${nextActive ? "启用" : "暂停"}`);
        void fetchTasks();
      } else {
        const data = await res.json();
        throw new Error(data.error || "切换状态失败");
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingTask) return;
    setDeleteBusy(true);
    setErrorMessage(null);
    try {
      const url = `/api/strm/tasks/${deletingTask.id}?purgeFiles=${purgeLocalFiles ? "true" : "false"}`;
      const res = await fetch(url, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "删除任务失败");
      }
      setActionMessage(
        `任务「${deletingTask.name}」已成功删除${data.purgedStrmFiles > 0 ? `（同步清理了 ${data.purgedStrmFiles} 个本地 .strm 文件）` : ""}`,
      );
      setDeletingTask(null);
      void fetchTasks();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleRunTask = async (taskId: string) => {
    setRunningTaskId(taskId);
    setErrorMessage(null);
    setActionMessage(null);

    try {
      const res = await fetch(`/api/strm/tasks/${taskId}/run`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "扫描执行失败");
      }
      const scan = data.scanResult;
      setActionMessage(
        `扫描完成：扫描文件 ${scan.scannedCount} 个，新增 STRM ${scan.generatedCount} 个，移除 ${scan.removedCount} 个${scan.protected ? "（触发空盘保护）" : ""}`,
      );
      void fetchTasks();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningTaskId(null);
    }
  };

  return (
    <div className="strm-view-container">
      <div className="strm-page-header">
        <div className="strm-page-header-copy">
          <div className="strm-page-heading">
            <Link href="/storage" className="btn btn-secondary btn-sm" style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
              <ArrowLeft size={14} /> 返回网盘
            </Link>
            <h1 className="strm-page-title">STRM 任务计划与串流中继</h1>
          </div>
          <p className="strm-page-description">
            借鉴 LitePan 方案：为网盘文件生成本地 .strm 虚拟结构，支持 302 重定向直链、SingleFlight 请求合并防封控，以及秒级基址热重写。
          </p>
        </div>
        <div className="strm-page-header-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowReplaceModal(true)}
          >
            <Wrench size={15} /> 快速修改播放基址
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowCreateModal(true)}
          >
            <Plus size={15} /> 新建 STRM 任务
          </button>
        </div>
      </div>

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

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem", color: "#888" }}>
          <RefreshCw size={24} className="animate-spin" style={{ margin: "0 auto 0.5rem" }} />
          正在加载 STRM 同步任务...
        </div>
      ) : tasks.length === 0 ? (
        <div style={{ textAlign: "center", padding: "4rem 2rem", background: "var(--bg-card, #1a1a1a)", borderRadius: "12px", border: "1px dashed var(--border, #333)" }}>
          <FolderSync size={40} style={{ margin: "0 auto 1rem", color: "#666" }} />
          <h3 style={{ margin: 0, marginBottom: "0.5rem", fontSize: "1.1rem" }}>暂无 STRM 同步任务</h3>
          <p style={{ color: "#888", fontSize: "0.9rem", maxWidth: "480px", margin: "0 auto 1.5rem" }}>
            创建 STRM 任务后，系统将自动扫描网盘指定目录并生成本地 .strm 指针，可直接被 Plex、Emby、Jellyfin 刮削并以 302 直连播放。
          </p>
          <button type="button" className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            <Plus size={15} /> 立即创建首个任务
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {tasks.map((task) => (
            <StrmTaskCard
              key={task.id}
              task={task}
              isRunning={runningTaskId === task.id || task.status === "running"}
              onOpenRecords={(t) => { void openRecordsModal(t); }}
              onRun={(id) => { void handleRunTask(id); }}
              onEdit={(t) => setEditingTask(t)}
              onDelete={(id, name) => setDeletingTask({ id, name })}
              onToggleActive={(t) => { void handleToggleActive(t); }}
            />
          ))}
        </div>
      )}

      {editingTask && (
        <EditStrmTaskModal
          task={editingTask}
          storages={storages}
          onClose={() => setEditingTask(null)}
          onSuccess={(name) => {
            setEditingTask(null);
            setActionMessage(`已成功更新 STRM 任务「${name}」配置`);
            void fetchTasks();
          }}
        />
      )}

      {deletingTask && (
        <StrmDeleteConfirmDialog
          taskName={deletingTask.name}
          purgeLocalFiles={purgeLocalFiles}
          deleteBusy={deleteBusy}
          onTogglePurge={setPurgeLocalFiles}
          onCancel={() => setDeletingTask(null)}
          onConfirm={() => { void handleConfirmDelete(); }}
        />
      )}

      {showCreateModal && (
        <StrmCreateTaskModal
          storages={storages}
          onClose={() => setShowCreateModal(false)}
          onSuccess={(name) => {
            setShowCreateModal(false);
            setActionMessage(`成功创建 STRM 任务: ${name}`);
            void fetchTasks();
          }}
        />
      )}

      {showReplaceModal && (
        <StrmReplaceBaseUrlModal
          tasks={tasks}
          onClose={() => setShowReplaceModal(false)}
          onSuccess={(msg) => {
            setShowReplaceModal(false);
            setActionMessage(msg);
          }}
        />
      )}

      {selectedTaskForRecords && (
        <StrmRecordsDialog
          task={selectedTaskForRecords}
          records={taskRecords}
          loading={recordsLoading}
          onRefresh={() => { void openRecordsModal(selectedTaskForRecords); }}
          onClose={() => setSelectedTaskForRecords(null)}
        />
      )}
    </div>
  );
}

"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Compass,
  FileVideo,
  FolderSearch,
  HelpCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { ReverseScanJob, ReverseScanItem } from "@media-track/workflow";

export interface ReverseScanModalProps {
  isOpen: boolean;
  onClose: () => void;
  storageId: string;
  currentDirId?: string | undefined;
  onScanComplete?: () => void;
}

interface ScanSetupFormProps {
  scope: "current" | "root";
  setScope: (s: "current" | "root") => void;
  category: "auto" | "movie" | "tv";
  setCategory: (c: "auto" | "movie" | "tv") => void;
  currentDirId?: string | undefined;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onStart: () => void;
}

function ScanSetupForm({
  scope,
  setScope,
  category,
  setCategory,
  currentDirId,
  busy,
  error,
  onClose,
  onStart,
}: ScanSetupFormProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div>
        <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.4rem" }}>
          扫描范围
        </label>
        <div style={{ display: "flex", gap: "1rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer", fontSize: "0.85rem" }}>
            <input
              type="radio"
              name="scanScope"
              checked={scope === "current"}
              onChange={() => setScope("current")}
            />
            当前目录及子目录 {currentDirId ? `(ID: ${currentDirId})` : "(根目录)"}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer", fontSize: "0.85rem" }}>
            <input
              type="radio"
              name="scanScope"
              checked={scope === "root"}
              onChange={() => setScope("root")}
            />
            全盘完整分类目录 (Movies / TV / Anime)
          </label>
        </div>
      </div>

      <div>
        <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.4rem" }}>
          媒体类型偏好
        </label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as "auto" | "movie" | "tv")}
          className="storage-input"
          style={{ width: "100%", padding: "0.45rem 0.6rem", fontSize: "0.85rem" }}
        >
          <option value="auto">智能自动识别 (推荐)</option>
          <option value="movie">仅扫描电影</option>
          <option value="tv">仅扫描剧集/动漫</option>
        </select>
      </div>

      {error && (
        <div className="storage-error-banner" style={{ marginTop: "0.5rem" }}>
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
        <button type="button" className="storage-btn secondary" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="storage-btn primary"
          disabled={busy}
          onClick={onStart}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
        >
          {busy ? <RefreshCw size={16} className="spin" /> : <FolderSearch size={16} />}
          开始一键扫描
        </button>
      </div>
    </div>
  );
}

function ScanItemRow({
  item,
  onReviewAction,
}: {
  item: ReverseScanItem;
  onReviewAction: (itemId: string, action: "accept" | "ignore") => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "0.5rem 0.75rem",
        borderRadius: "6px",
        background: "var(--bg-active, rgba(255, 255, 255, 0.03))",
        fontSize: "0.82rem",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, marginRight: "1rem" }}>
        <span style={{ fontWeight: 600 }}>{item.matchedTitle || item.parsedTitle || item.folderName}</span>
        <span style={{ fontSize: "0.74rem", opacity: 0.65 }}>{item.relativePath}</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        {item.reviewStatus === "auto_accepted" && (
          <span style={{ fontSize: "0.72rem", color: "var(--accent, #22c55e)", display: "inline-flex", alignItems: "center", gap: "0.2rem" }}>
            <CheckCircle size={12} /> 自动归档
          </span>
        )}
        {item.reviewStatus === "user_accepted" && (
          <span style={{ fontSize: "0.72rem", color: "var(--accent, #22c55e)", display: "inline-flex", alignItems: "center", gap: "0.2rem" }}>
            <CheckCircle size={12} /> 已纳管
          </span>
        )}
        {item.reviewStatus === "ignored" && (
          <span style={{ fontSize: "0.72rem", opacity: 0.5 }}>已忽略</span>
        )}
        {item.reviewStatus === "pending_review" && (
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <button
              type="button"
              className="storage-btn primary"
              style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem" }}
              onClick={() => onReviewAction(item.id, "accept")}
            >
              确认纳管
            </button>
            <button
              type="button"
              className="storage-btn secondary"
              style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem" }}
              onClick={() => onReviewAction(item.id, "ignore")}
            >
              忽略
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ScanProgressCard({ job }: { job: ReverseScanJob }) {
  return (
    <div
      style={{
        background: "var(--bg-active, rgba(255, 255, 255, 0.05))",
        borderRadius: "8px",
        padding: "1rem",
        border: "1px solid var(--border-color, rgba(255, 255, 255, 0.1))",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", marginBottom: "0.4rem" }}>
        <span style={{ fontWeight: 600 }}>{job.currentStepMessage || "正在处理..."}</span>
        <span style={{ color: "var(--accent, #22c55e)", fontWeight: 700 }}>{job.progressPercent}%</span>
      </div>
      <div style={{ height: "6px", width: "100%", background: "rgba(255, 255, 255, 0.1)", borderRadius: "3px", overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${job.progressPercent}%`,
            background: "var(--accent, #22c55e)",
            transition: "width 0.3s ease",
          }}
        />
      </div>

      <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.85rem", flexWrap: "wrap" }}>
        <div className="storage-counter-pill" style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.78rem", padding: "0.2rem 0.5rem", borderRadius: "4px", background: "rgba(255, 255, 255, 0.08)" }}>
          <FolderSearch size={14} /> 已扫描目录: <strong>{job.scannedFolders}</strong>
        </div>
        <div className="storage-counter-pill" style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.78rem", padding: "0.2rem 0.5rem", borderRadius: "4px", background: "rgba(59, 130, 246, 0.15)", color: "#60a5fa" }}>
          <Sparkles size={14} /> 发现影视: <strong>{job.discoveredTitles}</strong>
        </div>
        <div className="storage-counter-pill" style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.78rem", padding: "0.2rem 0.5rem", borderRadius: "4px", background: "rgba(34, 197, 94, 0.15)", color: "var(--accent, #22c55e)" }}>
          <CheckCircle size={14} /> 自动归档: <strong>{job.autoIngestedTitles}</strong>
        </div>
        <div className="storage-counter-pill" style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.78rem", padding: "0.2rem 0.5rem", borderRadius: "4px", background: "rgba(234, 179, 8, 0.15)", color: "#facc15" }}>
          <HelpCircle size={14} /> 待确认: <strong>{job.pendingReviewTitles}</strong>
        </div>
      </div>
    </div>
  );
}

function isScanJobActive(status?: ReverseScanJob["status"]): boolean {
  return (
    status === "queued" ||
    status === "scanning_directories" ||
    status === "matching_metadata" ||
    status === "reconciling_episodes" ||
    status === "persisting_subscriptions"
  );
}

function filterScanItems(
  items: ReverseScanItem[],
  activeTab: "all" | "pending" | "adopted",
): ReverseScanItem[] {
  if (activeTab === "pending") return items.filter((i) => i.reviewStatus === "pending_review");
  if (activeTab === "adopted") return items.filter((i) => i.reviewStatus === "auto_accepted" || i.reviewStatus === "user_accepted");
  return items;
}

interface ScanItemsListProps {
  items: ReverseScanItem[];
  activeTab: "all" | "pending" | "adopted";
  setActiveTab: (t: "all" | "pending" | "adopted") => void;
  onReviewAction: (itemId: string, action: "accept" | "ignore") => void;
}

function ScanItemsList({
  items,
  activeTab,
  setActiveTab,
  onReviewAction,
}: ScanItemsListProps) {
  if (items.length === 0) return null;

  const filteredItems = filterScanItems(items, activeTab);
  const pendingCount = items.filter((i) => i.reviewStatus === "pending_review").length;
  const adoptedCount = items.filter((i) => i.reviewStatus === "auto_accepted" || i.reviewStatus === "user_accepted").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.5rem" }}>
      <div style={{ display: "flex", gap: "0.5rem", borderBottom: "1px solid var(--border-color, rgba(255, 255, 255, 0.1))", paddingBottom: "0.4rem" }}>
        <button
          type="button"
          className={`storage-filter-tab ${activeTab === "all" ? "active" : ""}`}
          onClick={() => setActiveTab("all")}
          style={{ fontSize: "0.8rem", padding: "0.2rem 0.6rem", background: "none", border: "none", color: activeTab === "all" ? "var(--accent)" : "inherit", cursor: "pointer", fontWeight: activeTab === "all" ? 600 : 400 }}
        >
          全部 ({items.length})
        </button>
        <button
          type="button"
          className={`storage-filter-tab ${activeTab === "pending" ? "active" : ""}`}
          onClick={() => setActiveTab("pending")}
          style={{ fontSize: "0.8rem", padding: "0.2rem 0.6rem", background: "none", border: "none", color: activeTab === "pending" ? "var(--accent)" : "inherit", cursor: "pointer", fontWeight: activeTab === "pending" ? 600 : 400 }}
        >
          待确认 ({pendingCount})
        </button>
        <button
          type="button"
          className={`storage-filter-tab ${activeTab === "adopted" ? "active" : ""}`}
          onClick={() => setActiveTab("adopted")}
          style={{ fontSize: "0.8rem", padding: "0.2rem 0.6rem", background: "none", border: "none", color: activeTab === "adopted" ? "var(--accent)" : "inherit", cursor: "pointer", fontWeight: activeTab === "adopted" ? 600 : 400 }}
        >
          已纳管 ({adoptedCount})
        </button>
      </div>

      <div style={{ maxHeight: "260px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        {filteredItems.map((item) => (
          <ScanItemRow
            key={item.id}
            item={item}
            onReviewAction={onReviewAction}
          />
        ))}
      </div>
    </div>
  );
}

function ScanModalFooter({
  isRunning,
  onReset,
  onClose,
}: {
  isRunning: boolean;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <div style={{ marginTop: "0.8rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: "0.78rem", opacity: 0.65 }}>
        {isRunning ? "扫描正在进行中，可随时关闭窗口后台继续运行..." : "扫描已结束。"}
      </span>
      <div style={{ display: "flex", gap: "0.6rem" }}>
        {!isRunning && (
          <button
            type="button"
            className="storage-btn secondary"
            onClick={onReset}
            style={{ fontSize: "0.8rem" }}
          >
            重新扫描
          </button>
        )}
        <button type="button" className="storage-btn primary" onClick={onClose} style={{ fontSize: "0.8rem" }}>
          {isRunning ? "后台继续" : "完成"}
        </button>
      </div>
    </div>
  );
}

export function ReverseScanModal({
  isOpen,
  onClose,
  storageId,
  currentDirId,
  onScanComplete,
}: ReverseScanModalProps) {
  const [scope, setScope] = useState<"current" | "root">("current");
  const [category, setCategory] = useState<"auto" | "movie" | "tv">("auto");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ReverseScanJob | null>(null);
  const [items, setItems] = useState<ReverseScanItem[]>([]);
  const [activeTab, setActiveTab] = useState<"all" | "pending" | "adopted">("all");
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const notifiedJobIdRef = useRef<string | null>(null);

  const fetchJobStatus = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/storage/scan?jobId=${encodeURIComponent(jobId)}&_t=${Date.now()}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.job) {
        setJob(data.job);
        setItems(data.items ?? []);
      }
    } catch (err) {
      console.warn("[reverse-scan-modal] poll error:", err);
    }
  }, []);

  useEffect(() => {
    if (!job) return;
    if (isScanJobActive(job.status)) {
      pollTimerRef.current = setTimeout(() => {
        void fetchJobStatus(job.id);
      }, 1500);
    } else if (job.status === "completed") {
      if (notifiedJobIdRef.current !== job.id) {
        notifiedJobIdRef.current = job.id;
        onScanComplete?.();
      }
    }

    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [job, fetchJobStatus, onScanComplete]);

  if (!isOpen) return null;

  const handleStartScan = async () => {
    setBusy(true);
    setError(null);
    notifiedJobIdRef.current = null;
    try {
      const targetCid = scope === "current" && currentDirId ? currentDirId : undefined;
      const res = await fetch("/api/storage/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageId,
          targetCid,
          category,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "启动扫描任务失败");
      setJob(data.job);
      setItems([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动扫描出错");
    } finally {
      setBusy(false);
    }
  };

  const handleReviewAction = async (itemId: string, action: "accept" | "ignore") => {
    if (!job) return;
    try {
      const res = await fetch("/api/storage/scan/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: job.id,
          itemId,
          action,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "操作失败");
      await fetchJobStatus(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "审核操作失败");
    }
  };

  const isRunning = Boolean(job && isScanJobActive(job.status));

  return (
    <div className="storage-modal-overlay" onClick={onClose}>
      <div
        className="storage-modal-content"
        style={{ maxWidth: "720px", width: "95%", maxHeight: "88vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="storage-modal-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Compass size={20} style={{ color: "var(--accent, #22c55e)" }} />
            <h3 style={{ margin: 0, fontSize: "1.15rem" }}>网盘全盘扫描反推订阅</h3>
          </div>
          <button type="button" className="storage-modal-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="storage-modal-body" style={{ overflowY: "auto", flex: 1, padding: "1.25rem" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              background: "rgba(34, 197, 94, 0.1)",
              border: "1px solid rgba(34, 197, 94, 0.25)",
              borderRadius: "6px",
              padding: "0.5rem 0.75rem",
              fontSize: "0.82rem",
              color: "var(--accent, #22c55e)",
              marginBottom: "1rem",
            }}
          >
            <ShieldCheck size={16} />
            <span>智能并发限速保护已激活：只读扫描模式，严格遵从 1.2s 漏桶节流，杜绝触发网盘反爬封禁。</span>
          </div>

          {!job && (
            <ScanSetupForm
              scope={scope}
              setScope={setScope}
              category={category}
              setCategory={setCategory}
              currentDirId={currentDirId}
              busy={busy}
              error={error}
              onClose={onClose}
              onStart={() => void handleStartScan()}
            />
          )}

          {job && (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <ScanProgressCard job={job} />
              <ScanItemsList
                items={items}
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                onReviewAction={(itemId, action) => void handleReviewAction(itemId, action)}
              />
              <ScanModalFooter
                isRunning={isRunning}
                onReset={() => {
                  notifiedJobIdRef.current = null;
                  setJob(null);
                  setItems([]);
                }}
                onClose={onClose}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

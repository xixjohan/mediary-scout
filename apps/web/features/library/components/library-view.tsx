"use client";

import { useEffect, useState, useCallback, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckSquare } from "lucide-react";
import type {
  MediaLibrary,
  LibraryMediaItem,
  LibraryScanProgressEvent,
  LibraryPathBinding,
  BatchRematchResponse,
} from "@media-track/contracts";
import {
  SCAN_JOB_POLL_INTERVAL_MS,
  isActiveScanJobStatus,
  isTerminalScanJobStatus,
  mapJobToProgressEvent,
  type LibraryScanJob,
} from "../library-scan-job";
import type { ConnectedStorageView } from "../../../lib/workflow-runtime";
import { LibraryGrid } from "./library-grid";
import { LibraryItemModal } from "./library-item-modal";
import { CreateLibraryModal } from "./create-library-modal";
import { LibrarySettingsModal } from "./library-settings-modal";
import { LibraryFolderExplorer } from "./library-folder-explorer";
import { ScanProgressBar } from "./scan-progress-bar";
import { LibraryTabsBar } from "./library-tabs-bar";
import { LibraryToolbar } from "./library-toolbar";
import { LibraryBatchBar } from "./library-batch-bar";
import { AiBatchReportModal } from "./ai-batch-report-modal";

export interface LibraryViewProps {
  initialLibraries: MediaLibrary[];
  storages: ConnectedStorageView[];
}

function computeCategories(currentLibrary: MediaLibrary | null, activeLibraryId: string) {
  const libraryType = currentLibrary?.libraryType;
  return [
    { id: "all", label: "全部" },
    ...(activeLibraryId === "all"
      ? [
          { id: "movie", label: "电影" },
          { id: "tv", label: "剧集/动漫" },
        ]
      : libraryType === "movie"
        ? [{ id: "movie", label: "电影" }]
        : libraryType === "tv"
          ? [{ id: "tv", label: "剧集" }]
          : libraryType === "anime"
            ? [{ id: "anime", label: "动漫" }]
            : [
                { id: "movie", label: "电影" },
                { id: "tv", label: "剧集" },
              ]),
    { id: "folder", label: "文件夹" },
    { id: "needs_review", label: "待审核" },
  ];
}

export function LibraryView({ initialLibraries, storages }: LibraryViewProps) {
  const router = useRouter();
  const [libraries, setLibraries] = useState<MediaLibrary[]>(initialLibraries);
  const [activeLibraryId, setActiveLibraryId] = useState<string>(
    initialLibraries[0]?.id || "all",
  );

  const [items, setItems] = useState<LibraryMediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentBindings, setCurrentBindings] = useState<LibraryPathBinding[]>([]);

  // 动态分类视图: "all" | "movie" | "tv" | "anime" | "folder" | "needs_review"
  const [viewCategory, setViewCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [, startTransition] = useTransition();

  // 批量多选状态
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchRematchResponse | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 弹窗状态
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // 扫描与进度状态：DB 作业为唯一事实源，SSE 仅加速通知
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanEvent, setScanEvent] = useState<LibraryScanProgressEvent | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const finalizedJobIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    jobIdRef.current = jobId;
  }, [jobId]);

  const fetchLibraries = useCallback(async () => {
    try {
      const res = await fetch("/api/library");
      if (res.ok) {
        const json = await res.json();
        setLibraries(json.libraries || []);
      }
    } catch (err) {
      console.error("加载影视库列表失败:", err);
    }
  }, []);

  const fetchBindings = useCallback(async () => {
    if (activeLibraryId === "all") {
      setCurrentBindings([]);
      return;
    }
    try {
      const res = await fetch(`/api/library/${activeLibraryId}/paths`);
      if (res.ok) {
        const json = await res.json();
        setCurrentBindings(json.bindings || []);
      }
    } catch (err) {
      console.warn("加载当前库绑定路径失败:", err);
    }
  }, [activeLibraryId]);

  useEffect(() => {
    void fetchBindings();
  }, [fetchBindings]);

  const fetchItems = useCallback(async () => {
    if (viewCategory === "folder") return;

    try {
      setLoading(true);
      const params = new URLSearchParams();

      if (viewCategory === "movie") params.set("type", "movie");
      else if (viewCategory === "tv" || viewCategory === "anime") params.set("type", "tv");
      else if (viewCategory === "needs_review") params.set("reviewStatus", "needs_review");

      if (searchQuery.trim()) params.set("q", searchQuery.trim());
      params.set("limit", "150");

      const res = await fetch(`/api/library/${activeLibraryId}/items?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setItems(json.items || []);
      }
    } catch (err) {
      console.error("加载影视条目失败:", err);
    } finally {
      setLoading(false);
    }
  }, [activeLibraryId, viewCategory, searchQuery]);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  /** 终态统一失效：RSC 库列表 + 绑定路径 + 条目，一次性触发，杜绝循环刷新。 */
  const finalizeScan = useCallback(
    (job: LibraryScanJob) => {
      if (finalizedJobIdRef.current === job.id) return;
      finalizedJobIdRef.current = job.id;
      setScanning(false);
      setJobId(null);
      setScanEvent(mapJobToProgressEvent(job));
      setScanError(job.status === "failed" ? job.error || job.message || "扫描失败" : null);
      void fetchLibraries();
      void fetchBindings();
      void fetchItems();
      router.refresh();
    },
    [fetchLibraries, fetchBindings, fetchItems, router],
  );

  /** 权威状态查询：轮询的裁判，SSE 只负责触发它提前执行。 */
  const pollJob = useCallback(
    async (activeJobId: string) => {
      if (activeLibraryId === "all") return;
      try {
        const res = await fetch(
          `/api/library/${activeLibraryId}/scan?jobId=${encodeURIComponent(activeJobId)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { job: LibraryScanJob | null };
        const job = json.job;
        if (!job) return;
        setScanEvent(mapJobToProgressEvent(job));
        if (isTerminalScanJobStatus(job.status)) {
          finalizeScan(job);
        } else {
          setScanning(true);
        }
      } catch (err) {
        console.warn("[LibraryView] 轮询扫描作业失败:", err);
      }
    },
    [activeLibraryId, finalizeScan],
  );

  // 刷新页面后恢复进行中的扫描作业（进度已落库，不再只能靠内存事件）。
  useEffect(() => {
    if (activeLibraryId === "all") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/library/${activeLibraryId}/scan`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { job: LibraryScanJob | null };
        const job = json.job;
        if (!job || cancelled || !isActiveScanJobStatus(job.status)) return;
        finalizedJobIdRef.current = null;
        setJobId(job.id);
        setScanning(true);
        setScanEvent(mapJobToProgressEvent(job));
      } catch (err) {
        console.warn("[LibraryView] 恢复扫描作业失败:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeLibraryId]);

  // 以 DB 状态为准的定时轮询（终态即停）。
  useEffect(() => {
    if (!jobId || activeLibraryId === "all") return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || finalizedJobIdRef.current === jobId) return;
      await pollJob(jobId);
      if (!cancelled && finalizedJobIdRef.current !== jobId) {
        pollTimerRef.current = setTimeout(() => void tick(), SCAN_JOB_POLL_INTERVAL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [jobId, activeLibraryId, pollJob]);

  // SSE 低延迟加速通道：只触发一次权威回查，不据此判定终态。
  // 不设置 onerror 的 close()，让浏览器按 SSE 规范自动重连。
  useEffect(() => {
    if (activeLibraryId === "all") return;
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/library/${activeLibraryId}/scan?stream=1`);
      es.onmessage = () => {
        const active = jobIdRef.current;
        if (active) void pollJob(active);
      };
    } catch (err) {
      console.warn("[LibraryView] SSE 通道不可用，回退到轮询:", err);
    }
    return () => {
      es?.close();
    };
  }, [activeLibraryId, pollJob]);

  const handleTriggerScan = async (forceFull = false, bindingId?: string) => {
    if (activeLibraryId === "all") return;
    setScanning(true);
    setScanError(null);
    finalizedJobIdRef.current = null;
    try {
      const res = await fetch(`/api/library/${activeLibraryId}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forceFullScan: forceFull,
          ...(bindingId ? { bindingId } : {}),
        }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !json.jobId) {
        setScanError(json.error || "启动扫描失败");
        setScanning(false);
        return;
      }
      setJobId(json.jobId);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "启动扫描网络异常");
      setScanning(false);
    }
  };

  const handleCancelScan = async () => {
    const active = jobId;
    if (!active || activeLibraryId === "all") return;
    try {
      await fetch(
        `/api/library/${activeLibraryId}/scan?jobId=${encodeURIComponent(active)}`,
        { method: "DELETE" },
      );
      await pollJob(active);
    } catch (err) {
      console.warn("[LibraryView] 取消扫描失败:", err);
    }
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelectedIds(new Set(items.map((i) => i.id)));
  };

  const handleInvertSelect = () => {
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const item of items) {
        if (!prev.has(item.id)) next.add(item.id);
      }
      return next;
    });
  };

  const handleBatchRematch = async () => {
    if (selectedIds.size === 0) return;
    setBatchProcessing(true);
    try {
      const res = await fetch("/api/library/items/batch-rematch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: Array.from(selectedIds) }),
      });
      const data = (await res.json()) as BatchRematchResponse;
      setBatchResult(data);
      setSelectedIds(new Set());
      setIsSelecting(false);
      void fetchItems();
    } catch (err) {
      console.error("批量 AI 匹配错误:", err);
    } finally {
      setBatchProcessing(false);
    }
  };

  const handleBatchAccept = async () => {
    if (selectedIds.size === 0) return;
    setBatchProcessing(true);
    try {
      await fetch("/api/library/items/batch-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: Array.from(selectedIds), action: "accept" }),
      });
      setSelectedIds(new Set());
      setIsSelecting(false);
      void fetchItems();
    } finally {
      setBatchProcessing(false);
    }
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    setConfirmDelete(false);
    setBatchProcessing(true);
    try {
      await fetch("/api/library/items/batch-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: Array.from(selectedIds), action: "delete" }),
      });
      setSelectedIds(new Set());
      setIsSelecting(false);
      void fetchItems();
    } finally {
      setBatchProcessing(false);
    }
  };

  const currentLibrary = libraries.find((l) => l.id === activeLibraryId) || null;
  const categories = computeCategories(currentLibrary, activeLibraryId);

  return (
    <div style={{ padding: "0 0 4rem 0", position: "relative" }}>
      <LibraryTabsBar
        libraries={libraries}
        activeLibraryId={activeLibraryId}
        onSelectLibrary={(id) => {
          setActiveLibraryId(id);
          setViewCategory("all");
        }}
        onCreateLibrary={() => setShowCreateModal(true)}
      />

      <LibraryToolbar
        currentLibrary={currentLibrary}
        scanning={scanning}
        onTriggerScan={() => void handleTriggerScan(false)}
        onCancelScan={() => void handleCancelScan()}
        onOpenSettings={() => setShowSettingsModal(true)}
        categories={categories}
        viewCategory={viewCategory}
        onSelectCategory={setViewCategory}
        isSelecting={isSelecting}
        onToggleSelectMode={() => {
          setIsSelecting((prev) => !prev);
          setSelectedIds(new Set());
        }}
        searchQuery={searchQuery}
        onSearchChange={(val) => {
          startTransition(() => {
            setSearchQuery(val);
          });
        }}
      />

      {isSelecting && viewCategory !== "folder" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            marginBottom: "1rem",
            padding: "0.5rem 1rem",
            background: "rgba(34, 197, 94, 0.08)",
            border: "1px dashed rgba(34, 197, 94, 0.35)",
            borderRadius: "8px",
            fontSize: "0.85rem",
          }}
        >
          <span style={{ color: "var(--accent, #22c55e)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
            <CheckSquare size={15} /> 批量管理模式
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleSelectAll} style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}>
            全选本页 ({items.length})
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleInvertSelect} style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}>
            反选
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSelectedIds(new Set())} style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}>
            清空已选
          </button>
        </div>
      )}

      {scanError && (
        <div style={{ marginBottom: "1rem", padding: "0.75rem 1rem", background: "rgba(239, 68, 68, 0.15)", border: "1px solid rgba(239, 68, 68, 0.3)", color: "#ef4444", borderRadius: "8px", fontSize: "0.85rem" }}>
          扫描异常: {scanError}
        </div>
      )}

      {scanning && scanEvent && (
        <div style={{ marginBottom: "1.5rem" }}>
          <ScanProgressBar event={scanEvent} />
        </div>
      )}

      {viewCategory === "folder" ? (
        <LibraryFolderExplorer
          libraryId={activeLibraryId}
          bindings={currentBindings}
          storages={storages}
          defaultDeliveryMode={currentLibrary?.defaultDeliveryMode ?? "redirect"}
        />
      ) : activeLibraryId !== "all" && currentBindings.length === 0 ? (
        <div
          style={{
            padding: "4rem 2rem",
            textAlign: "center",
            background: "rgba(255, 255, 255, 0.02)",
            border: "1px dashed var(--border-color, rgba(255, 255, 255, 0.15))",
            borderRadius: "12px",
            marginTop: "1rem",
          }}
        >
          <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>📂</div>
          <h3
            style={{
              fontSize: "1.15rem",
              fontWeight: 600,
              color: "var(--text, #fff)",
              marginBottom: "0.5rem",
            }}
          >
            当前影视库尚未绑定网盘目录
          </h3>
          <p
            style={{
              color: "var(--text-muted, #888)",
              fontSize: "0.875rem",
              maxWidth: "520px",
              margin: "0 auto 1.5rem",
              lineHeight: 1.6,
            }}
          >
            请点击下方或顶栏的“库设置与路径”绑定 115 或夸克等云端目录。系统将自动建立多版本索引、递归刮削海报并识别音画质规格。
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowSettingsModal(true)}
            style={{ padding: "0.6rem 1.5rem", fontSize: "0.9rem" }}
          >
            ⚙️ 立即绑定网盘目录
          </button>
        </div>
      ) : (
        <LibraryGrid
          items={items}
          onSelectItem={(item) => setSelectedItemId(item.id)}
          loading={loading}
          isSelecting={isSelecting}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
        />
      )}

      {isSelecting && (
        <LibraryBatchBar
          selectedCount={selectedIds.size}
          batchProcessing={batchProcessing}
          confirmDelete={confirmDelete}
          onBatchRematch={() => { void handleBatchRematch(); }}
          onBatchAccept={() => { void handleBatchAccept(); }}
          onBatchDelete={() => { void handleBatchDelete(); }}
          onCancel={() => {
            setSelectedIds(new Set());
            setIsSelecting(false);
          }}
        />
      )}

      {batchResult && (
        <AiBatchReportModal report={batchResult} onClose={() => setBatchResult(null)} />
      )}

      {showCreateModal && (
        <CreateLibraryModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            void fetchLibraries();
          }}
        />
      )}

      {showSettingsModal && currentLibrary && (
        <LibrarySettingsModal
          library={currentLibrary}
          storages={storages}
          onClose={() => setShowSettingsModal(false)}
          onUpdated={() => {
            void fetchLibraries();
            void fetchItems();
          }}
          onTriggerScan={(bindingId) => {
            void handleTriggerScan(false, bindingId);
          }}
        />
      )}

      {selectedItemId && (
        <LibraryItemModal
          itemId={selectedItemId}
          onClose={() => setSelectedItemId(null)}
          onRefresh={fetchItems}
        />
      )}
    </div>
  );
}

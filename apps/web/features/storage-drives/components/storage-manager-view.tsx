"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, Copy, HardDrive, Move, RefreshCw, Trash2 } from "lucide-react";
import type { DriveBreadcrumb, DriveDirectoryListing, DriveFileItem } from "@media-track/workflow";
import { tmdbIdFromMediaLibraryFolderName } from "@media-track/workflow";
import type { ConnectedStorageView } from "../../../lib/workflow-runtime";
import { StorageFileTable } from "./storage/storage-file-table";
import { type ModalState, StorageModals } from "./storage/storage-modals";
import { StorageNavBar } from "./storage/storage-nav-bar";
import { StorageOfflineModal } from "./storage/storage-offline-modal";
import { ReverseScanModal } from "./storage/reverse-scan-modal";
import { OrganizeAdoptPrompt } from "./storage/organize-adopt-prompt";
import { OrganizeUnrecognizedPrompt } from "./storage/organize-unrecognized-prompt";
import { useFolderOrganize } from "./storage/use-folder-organize";
import { VideoPreviewModal } from "./storage/video-preview-modal";
import { formatProviderLabel, StorageTopBar } from "./storage/storage-top-bar";

export { formatProviderLabel };

interface ActionPayload {
  endpoint: string;
  body: Record<string, unknown>;
}

function buildActionPayload(
  kind: NonNullable<ModalState["kind"]>,
  storageId: string,
  state: {
    singleItem?: DriveFileItem | undefined;
    selectedItems: DriveFileItem[];
    inputName: string;
    targetDir: string;
    currentDirId: string;
  },
): ActionPayload | null {
  if (kind === "create") {
    return {
      endpoint: "/api/storage/files/folder",
      body: { storageId, parentId: state.currentDirId, name: state.inputName.trim() },
    };
  }
  if (kind === "rename") {
    if (!state.singleItem) return null;
    return {
      endpoint: "/api/storage/files/rename",
      body: {
        storageId,
        itemId: state.singleItem.id,
        isFolder: state.singleItem.isFolder,
        newName: state.inputName.trim(),
      },
    };
  }

  const items = state.singleItem
    ? [{ id: state.singleItem.id, isFolder: state.singleItem.isFolder, name: state.singleItem.name }]
    : state.selectedItems.map((it) => ({ id: it.id, isFolder: it.isFolder, name: it.name }));

  if (kind === "delete") {
    return {
      endpoint: "/api/storage/files/delete",
      body: { storageId, items },
    };
  }
  if (kind === "move" || kind === "copy") {
    return {
      endpoint: kind === "move" ? "/api/storage/files/move" : "/api/storage/files/copy",
      body: { storageId, items, targetDirectoryId: state.targetDir },
    };
  }
  return null;
}

function resolveTmdbIdFromListing(
  currentDirectoryName: string | undefined,
  breadcrumbs: DriveBreadcrumb[],
): number | null {
  const directTmdbId = tmdbIdFromMediaLibraryFolderName(currentDirectoryName ?? "");
  if (directTmdbId) return directTmdbId;

  for (let i = breadcrumbs.length - 1; i >= 0; i--) {
    const crumb = breadcrumbs[i];
    if (crumb?.name) {
      const fromCrumb = tmdbIdFromMediaLibraryFolderName(crumb.name);
      if (fromCrumb) return fromCrumb;
    }
  }
  return null;
}

function StorageEmptyState({
  error,
  onRefresh,
}: {
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <div className="storage-empty-state">
      <HardDrive size={48} className="storage-empty-icon" />
      <h2>未配置已连接网盘</h2>
      <p>
        {error ??
          "请前往网盘设置页面扫码或添加网盘凭证后再使用网盘管理功能。若此前已添加网盘，请确认已登录对应账号或点击下方的刷新重新检测。"}
      </p>
      <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
        <button
          type="button"
          className="storage-btn secondary"
          onClick={onRefresh}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
        >
          <RefreshCw size={16} /> 刷新检测
        </button>
        <Link href="/settings" className="storage-btn primary">
          前往网盘设置
        </Link>
      </div>
    </div>
  );
}

function getInitialSelectedStorageId(
  initialStorageId?: string,
  initialStorages?: ConnectedStorageView[],
): string {
  if (initialStorageId) return initialStorageId;
  if (!initialStorages || initialStorages.length === 0) return "";
  const active = initialStorages.find((s) => s.status === "active") ?? initialStorages[0];
  return active ? active.id : "";
}

export interface StorageManagerViewProps {
  storages?: ConnectedStorageView[] | undefined;
  initialStorageId?: string | undefined;
}

export function StorageManagerView({
  storages: initialStorages,
  initialStorageId,
}: StorageManagerViewProps = {}) {
  const [storages, setStorages] = useState<ConnectedStorageView[]>(initialStorages ?? []);
  const [selectedStorageId, setSelectedStorageId] = useState<string>(() =>
    getInitialSelectedStorageId(initialStorageId, initialStorages),
  );
  const [currentDirId, setCurrentDirId] = useState<string>("");
  const [breadcrumbs, setBreadcrumbs] = useState<DriveBreadcrumb[]>([
    { id: "0", name: "根目录" },
  ]);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [listing, setListing] = useState<DriveDirectoryListing | null>(null);
  const [loading, setLoading] = useState<boolean>(!initialStorages || initialStorages.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewItem, setPreviewItem] = useState<DriveFileItem | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [modal, setModal] = useState<ModalState>({ kind: null });
  const [offlineModalOpen, setOfflineModalOpen] = useState<boolean>(false);
  const [scanModalOpen, setScanModalOpen] = useState<boolean>(false);
  const [inputName, setInputName] = useState<string>("");
  const [targetDir, setTargetDir] = useState<string>("");
  const [customTargetDir, setCustomTargetDir] = useState<string>("");

  const loadStorages = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/storage/drives?_t=${Date.now()}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      if (!res.ok) {
        if (res.status === 401) {
          setError("未登录或访问已过期，请登录后再查看网盘资源。");
          return;
        }
        throw new Error(`获取网盘列表失败 (${res.status})`);
      }
      const data = await res.json();
      const list = Array.isArray(data.drives)
        ? data.drives
        : Array.isArray(data.connectedStorages)
          ? data.connectedStorages
          : [];
      setStorages(list);
      if (list.length > 0) {
        setSelectedStorageId((prev) => {
          if (prev && list.some((s: ConnectedStorageView) => s.id === prev)) return prev;
          const active = list.find((s: ConnectedStorageView) => s.status === "active") ?? list[0];
          return active ? active.id : "";
        });
      } else {
        setSelectedStorageId("");
        setListing(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "获取网盘列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  // 1. 同步外部 props 变更（SSR 首屏注水 / 客户端路由回填）
  useEffect(() => {
    if (initialStorages && initialStorages.length > 0) {
      setStorages(initialStorages);
      setSelectedStorageId((prev) => {
        if (prev && initialStorages.some((s) => s.id === prev)) return prev;
        const active = initialStorages.find((s) => s.status === "active") ?? initialStorages[0];
        return active ? active.id : "";
      });
      setLoading(false);
    } else if (initialStorages && initialStorages.length === 0) {
      // 若服务端首屏因鉴权未就绪等返回空列表，客户端发起一次防缓存探测兜底
      void loadStorages();
    }
  }, [initialStorages, loadStorages]);

  // 2. 无初始 Props 时客户端独立加载
  useEffect(() => {
    if (initialStorages === undefined) {
      void loadStorages();
    }
  }, [initialStorages, loadStorages]);

  const loadFiles = useCallback(async (storageId: string, parentId?: string) => {
    if (!storageId) return;
    setLoading(true);
    setError(null);
    setSelectedIds(new Set());
    try {
      const q = new URLSearchParams({ storageId, _t: String(Date.now()) });
      if (parentId) q.set("dirId", parentId);
      const res = await fetch(`/api/storage/files?${q.toString()}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "获取文件列表失败");
      setListing(data);
      setCurrentDirId(data.currentDirectoryId || "");

      if (data.breadcrumbs && data.breadcrumbs.length > 0) {
        setBreadcrumbs((prev) => {
          if (data.breadcrumbs.length >= prev.length || data.breadcrumbs.length > 2) {
            return data.breadcrumbs;
          }
          if (prev.length > 0 && prev[prev.length - 1]?.id === data.currentDirectoryId) {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && data.currentDirectoryName && data.currentDirectoryName !== "目录") {
              last.name = data.currentDirectoryName;
            }
            return updated;
          }
          return data.breadcrumbs;
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleNavigateFolder = useCallback(
    (folderId: string, folderName?: string) => {
      setBreadcrumbs((prev) => {
        const existingIdx = prev.findIndex((b) => b.id === folderId);
        if (existingIdx >= 0) {
          return prev.slice(0, existingIdx + 1);
        }
        return [...prev, { id: folderId, name: folderName || "目录" }];
      });
      void loadFiles(selectedStorageId, folderId);
    },
    [loadFiles, selectedStorageId],
  );

  const handleNavigateCrumbOrCategory = useCallback(
    (dirId: string) => {
      const rootId = listing?.rootCid || "0";
      if (dirId === rootId) {
        setBreadcrumbs([{ id: rootId, name: "根目录" }]);
      } else if (listing?.moviesCid && dirId === listing.moviesCid) {
        setBreadcrumbs([
          { id: rootId, name: "根目录" },
          { id: listing.moviesCid, name: "电影" },
        ]);
      } else if (listing?.tvCid && dirId === listing.tvCid) {
        setBreadcrumbs([
          { id: rootId, name: "根目录" },
          { id: listing.tvCid, name: "剧集" },
        ]);
      } else if (listing?.animeCid && dirId === listing.animeCid) {
        setBreadcrumbs([
          { id: rootId, name: "根目录" },
          { id: listing.animeCid, name: "动漫" },
        ]);
      } else {
        setBreadcrumbs((prev) => {
          const existingIdx = prev.findIndex((b) => b.id === dirId);
          if (existingIdx >= 0) {
            return prev.slice(0, existingIdx + 1);
          }
          return prev;
        });
      }
      void loadFiles(selectedStorageId, dirId);
    },
    [listing, loadFiles, selectedStorageId],
  );

  const handleScanComplete = useCallback(() => {
    void loadFiles(selectedStorageId, currentDirId);
  }, [selectedStorageId, currentDirId, loadFiles]);

  const handleRefresh = async () => {
    if (!selectedStorageId || storages.length === 0) {
      await loadStorages();
    } else {
      await Promise.all([
        loadStorages(),
        loadFiles(selectedStorageId, currentDirId),
      ]);
    }
  };

  useEffect(() => {
    if (selectedStorageId) {
      setBreadcrumbs([{ id: "0", name: "根目录" }]);
      void loadFiles(selectedStorageId);
    }
  }, [selectedStorageId]);

  const filteredItems = useMemo(() => {
    if (!listing?.items) return [];
    if (!searchQuery.trim()) return listing.items;
    const q = searchQuery.toLowerCase().trim();
    return listing.items.filter((item) => item.name.toLowerCase().includes(q));
  }, [listing?.items, searchQuery]);

  const selectedItems = useMemo(() => {
    if (!listing?.items) return [];
    return listing.items.filter((it) => selectedIds.has(it.id));
  }, [listing?.items, selectedIds]);

  const toggleSelectAll = () => {
    const isAll = filteredItems.length > 0 && filteredItems.every((i) => selectedIds.has(i.id));
    setSelectedIds(isAll ? new Set() : new Set(filteredItems.map((i) => i.id)));
  };

  const toggleSelectItem = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };


  const handlePlay = (item: DriveFileItem) => {
    setPreviewItem(item);
  };

  const handleCopyPlayLink = (item: DriveFileItem) => {
    const url = `${window.location.origin}/api/strm/play/${selectedStorageId}/${item.id}?name=${encodeURIComponent(item.name)}`;
    void navigator.clipboard.writeText(url).then(() => {
      setSuccessMessage(`已复制播放链: ${item.name}`);
      setTimeout(() => setSuccessMessage(null), 3000);
    });
  };

  const handleOpenAction = (kind: ModalState["kind"], single?: DriveFileItem) => {
    setInputName(single ? single.name : "");
    setTargetDir(listing?.rootCid || "0");
    setCustomTargetDir("");
    setModal({ kind, singleItem: single });
  };

  const handleExecuteModalAction = async () => {
    if (!modal.kind || !selectedStorageId) return;
    const payload = buildActionPayload(modal.kind, selectedStorageId, {
      singleItem: modal.singleItem,
      selectedItems,
      inputName,
      targetDir,
      currentDirId,
    });
    if (!payload) return;

    setActionBusy(true);
    setError(null);
    try {
      const res = await fetch(payload.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload.body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "操作执行失败");
      setModal({ kind: null });
      await loadFiles(selectedStorageId, currentDirId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作执行出错");
    } finally {
      setActionBusy(false);
    }
  };

  const handleAdoptFolder = async (item: DriveFileItem) => {
    if (!item.isFolder || !selectedStorageId) return;
    setActionBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/storage/files/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageId: selectedStorageId,
          folderId: item.id,
          folderName: item.name,
          tmdbId: item.mediaInfo?.tmdbId ?? currentFolderTmdbId,
          seasonNumber: item.mediaInfo?.parsedSeason,
          parentFolderName: listing?.currentDirectoryName,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "反推订阅失败");
      setSuccessMessage(data.message || "已成功纳入媒体库并订阅！");
      await loadFiles(selectedStorageId, currentDirId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "反推订阅出错");
    } finally {
      setActionBusy(false);
    }
  };

  if (!loading && storages.length === 0) {
    return <StorageEmptyState error={error} onRefresh={() => void loadStorages()} />;
  }

  const currentStorage = storages.find((s) => s.id === selectedStorageId);

  const currentFolderTmdbId = useMemo(
    () => resolveTmdbIdFromListing(listing?.currentDirectoryName, breadcrumbs),
    [listing?.currentDirectoryName, breadcrumbs],
  );

  const organizeFlow = useFolderOrganize({
    storageId: selectedStorageId,
    directoryId: currentDirId,
    directoryName: listing?.currentDirectoryName,
    breadcrumbs,
    tmdbId: currentFolderTmdbId,
    onNavigateFolder: handleNavigateFolder,
    onReload: () => loadFiles(selectedStorageId, currentDirId),
    onSuccess: setSuccessMessage,
    onError: setError,
  });

  return (
    <div className="storage-view-container">
      <StorageTopBar
        storages={storages}
        selectedStorageId={selectedStorageId}
        onSelectStorage={(id) => {
          setSelectedStorageId(id);
          setCurrentDirId("");
        }}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        loading={loading}
        actionBusy={actionBusy}
        onOpenCreate={() => handleOpenAction("create")}
        onOpenOffline={() => setOfflineModalOpen(true)}
        onOpenScan={() => setScanModalOpen(true)}
        onRefresh={() => void handleRefresh()}
        currentFolderTmdbId={currentFolderTmdbId}
        onOrganizeCurrentFolder={organizeFlow.organizeCurrentFolder}
        organizing={organizeFlow.busy}
      />

      <StorageNavBar
        listing={listing}
        currentDirId={currentDirId}
        breadcrumbs={breadcrumbs}
        onNavigate={handleNavigateCrumbOrCategory}
      />

      {selectedIds.size > 0 && (
        <div className="storage-batch-toolbar">
          <span className="batch-selected-count">
            已选中 <strong>{selectedIds.size}</strong> 项
          </span>
          <div className="batch-buttons">
            <button
              type="button"
              className="storage-btn batch-action"
              onClick={() => handleOpenAction("move")}
            >
              <Move size={14} /> 批量移动
            </button>
            <button
              type="button"
              className="storage-btn batch-action"
              onClick={() => handleOpenAction("copy")}
            >
              <Copy size={14} /> 批量复制
            </button>
            <button
              type="button"
              className="storage-btn batch-danger"
              onClick={() => handleOpenAction("delete")}
            >
              <Trash2 size={14} /> 批量删除
            </button>
          </div>
        </div>
      )}

      <OrganizeAdoptPrompt
        prompt={organizeFlow.pendingAdopt}
        busy={organizeFlow.busy}
        onConfirm={() => void organizeFlow.confirmAdopt()}
        onCancel={organizeFlow.cancelAdopt}
      />

      <OrganizeUnrecognizedPrompt
        prompt={organizeFlow.pendingUnrecognized}
        busy={organizeFlow.busy}
        onConfirm={() => void organizeFlow.fixUnrecognized()}
        onDismiss={organizeFlow.dismissUnrecognized}
      />

      {error && (
        <div className="storage-error-banner">
          <AlertCircle size={18} />
          <span>{error}</span>
          <button
            type="button"
            className="storage-error-dismiss"
            onClick={() => setError(null)}
          >
            ×
          </button>
        </div>
      )}

      {successMessage && (
        <div className="storage-error-banner" style={{ background: "rgba(34, 197, 94, 0.15)", borderColor: "rgba(34, 197, 94, 0.3)", color: "var(--accent)" }}>
          <span>{successMessage}</span>
          <button
            type="button"
            className="storage-error-dismiss"
            onClick={() => setSuccessMessage(null)}
          >
            ×
          </button>
        </div>
      )}

      <StorageFileTable
        loading={loading}
        items={filteredItems}
        selectedIds={selectedIds}
        searchQuery={searchQuery}
        onToggleSelectAll={toggleSelectAll}
        onToggleSelectItem={toggleSelectItem}
        onNavigateFolder={handleNavigateFolder}
        onRename={(item) => handleOpenAction("rename", item)}
        onMove={(item) => handleOpenAction("move", item)}
        onCopy={(item) => handleOpenAction("copy", item)}
        onDelete={(item) => handleOpenAction("delete", item)}
        onPlay={handlePlay}
        onCopyPlayLink={handleCopyPlayLink}
        onAdoptFolder={handleAdoptFolder}
      />

      {previewItem && (
        <VideoPreviewModal
          item={previewItem}
          storageId={selectedStorageId}
          onClose={() => setPreviewItem(null)}
        />
      )}
      <StorageModals
        modal={modal}
        listing={listing}
        inputName={inputName}
        setInputName={setInputName}
        targetDir={targetDir}
        setTargetDir={setTargetDir}
        customTargetDir={customTargetDir}
        setCustomTargetDir={setCustomTargetDir}
        actionBusy={actionBusy}
        selectedItems={selectedItems}
        onClose={() => setModal({ kind: null })}
        onCreateFolder={() => void handleExecuteModalAction()}
        onRename={() => void handleExecuteModalAction()}
        onDelete={() => void handleExecuteModalAction()}
        onMoveOrCopy={() => void handleExecuteModalAction()}
      />

      <StorageOfflineModal
        isOpen={offlineModalOpen}
        onClose={() => setOfflineModalOpen(false)}
        storage={currentStorage}
        listing={listing ?? undefined}
        onSuccess={() => void loadFiles(selectedStorageId, currentDirId)}
      />

      <ReverseScanModal
        isOpen={scanModalOpen}
        onClose={() => setScanModalOpen(false)}
        storageId={selectedStorageId}
        currentDirId={currentDirId}
        onScanComplete={handleScanComplete}
      />
    </div>
  );
}

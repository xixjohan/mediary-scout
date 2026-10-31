"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, Copy, HardDrive, Move, Trash2 } from "lucide-react";
import type { DriveDirectoryListing, DriveFileItem } from "@media-track/workflow";
import type { ConnectedStorageView } from "../../../lib/workflow-runtime";
import { StorageFileTable } from "./storage/storage-file-table";
import { type ModalState, StorageModals } from "./storage/storage-modals";
import { StorageNavBar } from "./storage/storage-nav-bar";
import { StorageOfflineModal } from "./storage/storage-offline-modal";
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

export interface StorageManagerViewProps {
  storages?: ConnectedStorageView[] | undefined;
  initialStorageId?: string | undefined;
}

export function StorageManagerView({
  storages: initialStorages,
  initialStorageId,
}: StorageManagerViewProps = {}) {
  const [storages, setStorages] = useState<ConnectedStorageView[]>(initialStorages ?? []);
  const [selectedStorageId, setSelectedStorageId] = useState<string>(() => {
    if (initialStorageId) return initialStorageId;
    if (initialStorages && initialStorages.length > 0) {
      const active = initialStorages.find((s) => s.status === "active") ?? initialStorages[0];
      return active ? active.id : "";
    }
    return "";
  });
  const [currentDirId, setCurrentDirId] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [listing, setListing] = useState<DriveDirectoryListing | null>(null);
  const [loading, setLoading] = useState<boolean>(!initialStorages || initialStorages.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [modal, setModal] = useState<ModalState>({ kind: null });
  const [offlineModalOpen, setOfflineModalOpen] = useState<boolean>(false);
  const [inputName, setInputName] = useState<string>("");
  const [targetDir, setTargetDir] = useState<string>("");
  const [customTargetDir, setCustomTargetDir] = useState<string>("");

  useEffect(() => {
    if (initialStorages !== undefined) return;
    let cancelled = false;
    async function loadStorages() {
      try {
        const res = await fetch("/api/settings/connected-storages");
        const data = await res.json();
        if (cancelled) return;
        const list = Array.isArray(data.connectedStorages) ? data.connectedStorages : [];
        setStorages(list);
        if (list.length > 0) {
          const active = list.find((s: ConnectedStorageView) => s.status === "active") ?? list[0];
          if (active) setSelectedStorageId(active.id);
        } else {
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "获取网盘列表失败");
          setLoading(false);
        }
      }
    }
    void loadStorages();
    return () => {
      cancelled = true;
    };
  }, [initialStorages]);

  const loadFiles = async (storageId: string, parentId?: string) => {
    if (!storageId) return;
    setLoading(true);
    setError(null);
    setSelectedIds(new Set());
    try {
      const q = new URLSearchParams({ storageId });
      if (parentId) q.set("dirId", parentId);
      const res = await fetch(`/api/storage/files?${q.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "获取文件列表失败");
      setListing(data);
      setCurrentDirId(data.currentDirectoryId || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedStorageId) {
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

  if (!loading && storages.length === 0) {
    return (
      <div className="storage-empty-state">
        <HardDrive size={48} className="storage-empty-icon" />
        <h2>未配置已连接网盘</h2>
        <p>请前往网盘设置页面扫码或添加网盘凭证后再使用网盘管理功能。</p>
        <Link href="/settings" className="storage-btn primary">
          前往网盘设置
        </Link>
      </div>
    );
  }

  const currentStorage = storages.find((s) => s.id === selectedStorageId);

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
        onRefresh={() => void loadFiles(selectedStorageId, currentDirId)}
      />

      <StorageNavBar
        listing={listing}
        currentDirId={currentDirId}
        onNavigate={(dirId) => void loadFiles(selectedStorageId, dirId)}
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

      <StorageFileTable
        loading={loading}
        items={filteredItems}
        selectedIds={selectedIds}
        searchQuery={searchQuery}
        onToggleSelectAll={toggleSelectAll}
        onToggleSelectItem={toggleSelectItem}
        onNavigateFolder={(id) => void loadFiles(selectedStorageId, id)}
        onRename={(item) => handleOpenAction("rename", item)}
        onMove={(item) => handleOpenAction("move", item)}
        onCopy={(item) => handleOpenAction("copy", item)}
        onDelete={(item) => handleOpenAction("delete", item)}
      />

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
    </div>
  );
}

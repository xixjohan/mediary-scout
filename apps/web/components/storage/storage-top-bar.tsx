"use client";

import { FolderPlus, RefreshCw, Search } from "lucide-react";
import type { ConnectedStorageView } from "../../lib/workflow-runtime";

export function formatProviderLabel(provider: string): string {
  switch (provider) {
    case "quark":
      return "夸克网盘";
    case "pan115":
      return "115网盘";
    case "pan123":
      return "123云盘";
    case "tianyi":
      return "天翼云盘";
    case "guangya":
      return "广雅云盘";
    default:
      return provider;
  }
}

interface StorageTopBarProps {
  storages: ConnectedStorageView[];
  selectedStorageId: string;
  onSelectStorage: (id: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  loading: boolean;
  actionBusy: boolean;
  onOpenCreate: () => void;
  onRefresh: () => void;
}

export function StorageTopBar({
  storages,
  selectedStorageId,
  onSelectStorage,
  searchQuery,
  onSearchChange,
  loading,
  actionBusy,
  onOpenCreate,
  onRefresh,
}: StorageTopBarProps) {
  return (
    <div className="storage-top-bar">
      <div className="storage-drive-selector-wrap">
        <label htmlFor="drive-select">当前网盘：</label>
        <select
          id="drive-select"
          value={selectedStorageId}
          onChange={(e) => onSelectStorage(e.target.value)}
        >
          {storages.map((s) => (
            <option key={s.id} value={s.id}>
              {formatProviderLabel(s.provider)} - {s.label || s.providerUid || s.id.slice(0, 10)}
              {s.id === selectedStorageId ? " (当前)" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="storage-search-box">
        <Search size={16} className="storage-search-icon" />
        <input
          type="text"
          placeholder="搜索当前目录文件..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {searchQuery && (
          <button
            type="button"
            className="storage-search-clear"
            onClick={() => onSearchChange("")}
          >
            ×
          </button>
        )}
      </div>

      <div className="storage-top-actions">
        <button
          type="button"
          className="storage-btn primary"
          onClick={onOpenCreate}
          disabled={loading || actionBusy}
        >
          <FolderPlus size={16} /> 新建文件夹
        </button>
        <button
          type="button"
          className="storage-btn icon-only"
          title="刷新"
          onClick={onRefresh}
          disabled={loading || actionBusy}
        >
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>
    </div>
  );
}

"use client";

import {
  CheckSquare,
  Copy,
  CornerDownRight,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  Film,
  Folder,
  Move,
  RefreshCw,
  Square,
  Subtitles,
  Trash2,
} from "lucide-react";
import type { DriveFileItem, DriveItemType } from "@media-track/workflow";

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function ItemIcon({ type }: { type: DriveItemType }) {
  switch (type) {
    case "folder":
      return <Folder className="storage-item-icon is-folder" size={18} />;
    case "video":
      return <Film className="storage-item-icon is-video" size={18} />;
    case "subtitle":
      return <Subtitles className="storage-item-icon is-sub" size={18} />;
    case "audio":
      return <FileAudio className="storage-item-icon is-audio" size={18} />;
    case "archive":
      return <FileArchive className="storage-item-icon is-archive" size={18} />;
    case "image":
      return <FileImage className="storage-item-icon is-image" size={18} />;
    default:
      return <File className="storage-item-icon is-generic" size={18} />;
  }
}

function ItemTypeBadge({ type }: { type: DriveItemType }) {
  const map: Record<DriveItemType, string> = {
    folder: "文件夹",
    video: "视频",
    subtitle: "字幕",
    audio: "音频",
    archive: "压缩包",
    image: "图片",
    file: "文件",
  };
  return <span className={`storage-type-badge type-${type}`}>{map[type] || "文件"}</span>;
}

interface StorageFileTableProps {
  loading: boolean;
  items: DriveFileItem[];
  selectedIds: Set<string>;
  searchQuery: string;
  onToggleSelectAll: () => void;
  onToggleSelectItem: (id: string) => void;
  onNavigateFolder: (id: string) => void;
  onRename: (item: DriveFileItem) => void;
  onMove: (item: DriveFileItem) => void;
  onCopy: (item: DriveFileItem) => void;
  onDelete: (item: DriveFileItem) => void;
}

export function StorageFileTable({
  loading,
  items,
  selectedIds,
  searchQuery,
  onToggleSelectAll,
  onToggleSelectItem,
  onNavigateFolder,
  onRename,
  onMove,
  onCopy,
  onDelete,
}: StorageFileTableProps) {
  const isAllSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));

  return (
    <div className="storage-table-wrap">
      <table className="storage-file-table">
        <thead>
          <tr>
            <th className="col-checkbox">
              <button
                type="button"
                className="storage-checkbox-btn"
                onClick={onToggleSelectAll}
                aria-label="全选"
              >
                {isAllSelected ? <CheckSquare size={16} /> : <Square size={16} />}
              </button>
            </th>
            <th className="col-name">名称</th>
            <th className="col-type">类型</th>
            <th className="col-size">大小</th>
            <th className="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={5} className="storage-loading-row">
                <div className="storage-loading-indicator">
                  <RefreshCw size={18} className="spin" /> 正在加载网盘文件列表...
                </div>
              </td>
            </tr>
          )}

          {!loading && items.length === 0 && (
            <tr>
              <td colSpan={5} className="storage-empty-row">
                {searchQuery ? "未匹配到相关文件或文件夹" : "当前目录下没有文件或文件夹"}
              </td>
            </tr>
          )}

          {!loading &&
            items.map((item) => {
              const isSelected = selectedIds.has(item.id);
              return (
                <tr key={item.id} className={isSelected ? "is-row-selected" : ""}>
                  <td className="col-checkbox">
                    <button
                      type="button"
                      className="storage-checkbox-btn"
                      onClick={() => onToggleSelectItem(item.id)}
                      aria-label={`选择 ${item.name}`}
                    >
                      {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                    </button>
                  </td>
                  <td className="col-name">
                    <div className="storage-item-name-cell">
                      <ItemIcon type={item.type} />
                      {item.isFolder ? (
                        <button
                          type="button"
                          className="storage-folder-link"
                          onClick={() => onNavigateFolder(item.id)}
                        >
                          {item.name}
                        </button>
                      ) : (
                        <span className="storage-file-name" title={item.name}>
                          {item.name}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="col-type">
                    <ItemTypeBadge type={item.type} />
                  </td>
                  <td className="col-size">{formatBytes(item.sizeBytes)}</td>
                  <td className="col-actions">
                    <div className="storage-row-actions">
                      <button
                        type="button"
                        className="storage-action-icon-btn"
                        title="重命名"
                        onClick={() => onRename(item)}
                      >
                        <CornerDownRight size={14} />
                      </button>
                      <button
                        type="button"
                        className="storage-action-icon-btn"
                        title="移动到..."
                        onClick={() => onMove(item)}
                      >
                        <Move size={14} />
                      </button>
                      <button
                        type="button"
                        className="storage-action-icon-btn"
                        title="复制到..."
                        onClick={() => onCopy(item)}
                      >
                        <Copy size={14} />
                      </button>
                      <button
                        type="button"
                        className="storage-action-icon-btn is-danger"
                        title="删除"
                        onClick={() => onDelete(item)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

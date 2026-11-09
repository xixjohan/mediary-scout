"use client";

import { useMemo } from "react";
import { Film, Folder, FolderSearch, Tv, type LucideIcon } from "lucide-react";
import type { DriveDirectoryListing } from "@media-track/workflow";

export interface IngestDestinationPickerProps {
  listing: DriveDirectoryListing;
  targetDir: string;
  setTargetDir: (dir: string) => void;
  targetPath: string;
  setTargetPath: (path: string) => void;
  customTargetDir: string;
  setCustomTargetDir: (dir: string) => void;
  onOpenPicker: () => void;
}

interface QuickDestOption {
  cid: string;
  name: string;
  path: string;
  Icon: LucideIcon;
}

export function IngestDestinationPicker({
  listing,
  targetDir,
  setTargetDir,
  targetPath,
  setTargetPath,
  customTargetDir,
  setCustomTargetDir,
  onOpenPicker,
}: IngestDestinationPickerProps) {
  const rootId = listing.rootCid || "0";

  const quickOptions = useMemo<QuickDestOption[]>(() => {
    const list: QuickDestOption[] = [
      { cid: rootId, name: "根目录", path: "/", Icon: Folder },
    ];
    if (listing.moviesCid) {
      list.push({ cid: listing.moviesCid, name: "电影目录", path: "/电影", Icon: Film });
    }
    if (listing.tvCid) {
      list.push({ cid: listing.tvCid, name: "剧集目录", path: "/剧集", Icon: Tv });
    }
    if (listing.animeCid) {
      list.push({ cid: listing.animeCid, name: "动漫目录", path: "/动漫", Icon: Film });
    }
    return list;
  }, [rootId, listing.moviesCid, listing.tvCid, listing.animeCid]);

  const handleSelectQuick = (option: QuickDestOption) => {
    setTargetDir(option.cid);
    setTargetPath(option.path);
    setCustomTargetDir("");
  };

  const currentPathDisplay = targetPath || (targetDir === rootId ? "/ (根目录)" : `目录 ${targetDir}`);

  return (
    <div className="storage-offline-dest-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <label className="storage-picker-title" style={{ margin: 0 }}>
          存储目标目录：
        </label>
        <button
          type="button"
          className="storage-browse-dest-btn"
          onClick={onOpenPicker}
          title="可视化下钻浏览网盘层级目录"
        >
          <FolderSearch size={14} />
          <span>浏览网盘目录</span>
        </button>
      </div>

      <div className="storage-quick-dest-row">
        {quickOptions.map((opt) => {
          const isSelected = targetDir === opt.cid && !targetPath;
          const { Icon } = opt;
          return (
            <button
              key={opt.cid + opt.name}
              type="button"
              className={`storage-quick-dest-btn ${isSelected ? "is-selected" : ""}`}
              onClick={() => handleSelectQuick(opt)}
            >
              <Icon size={14} /> {opt.name}
            </button>
          );
        })}
      </div>

      {/* 已选目标目录展示卡片 */}
      <div className="storage-selected-dest-card">
        <div className="storage-selected-dest-info">
          <Folder size={16} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span>已选目标：</span>
          <span className="storage-selected-dest-path" title={currentPathDisplay}>
            {currentPathDisplay}
          </span>
          <span className="storage-selected-dest-cid">(ID: {targetDir})</span>
        </div>
        <button
          type="button"
          className="storage-btn secondary"
          style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
          onClick={onOpenPicker}
        >
          更改
        </button>
      </div>

      {/* 高级手动输入折叠项 */}
      <details className="storage-custom-dest-details">
        <summary>高级选项：手动指定目录 ID</summary>
        <div className="storage-custom-target-input" style={{ marginTop: "0.4rem" }}>
          <input
            id="custom-offline-dest"
            type="text"
            placeholder="例如目录 CID / FID"
            value={customTargetDir}
            onChange={(e) => {
              const v = e.target.value.trim();
              setCustomTargetDir(v);
              if (v) {
                setTargetDir(v);
                setTargetPath(`指定目录 (${v})`);
              }
            }}
          />
        </div>
      </details>
    </div>
  );
}

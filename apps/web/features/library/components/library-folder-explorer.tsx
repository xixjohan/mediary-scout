"use client";

import { useEffect, useState } from "react";
import { Folder, Film, FileText, ChevronRight, RefreshCw, Play, HardDrive, AlertCircle } from "lucide-react";
import type { LibraryPathBinding } from "@media-track/contracts";
import type { ConnectedStorageView } from "../../../lib/workflow-runtime";
import type { DriveFileItem, DriveDirectoryListing } from "@media-track/workflow";
import { MediaryPlayerModal } from "../../player/components/mediary-player-modal";
import { buildPlayStreamUrls } from "../../player/play-stream-url";

export interface LibraryFolderExplorerProps {
  libraryId: string;
  bindings: LibraryPathBinding[];
  storages: ConnectedStorageView[];
  /** 所属影视库的默认投送策略，用于 binding 为 inherit 时向上继承。 */
  defaultDeliveryMode?: "redirect" | "proxy" | undefined;
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "--";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

interface FolderExplorerTopBarProps {
  storages: ConnectedStorageView[];
  selectedStorageId: string;
  defaultFolderId: string;
  listing: DriveDirectoryListing | null;
  loading: boolean;
  onStorageChange: (storageId: string) => void;
  onNavigateTo: (dirId: string) => void;
  onRefresh: () => void;
}

function FolderExplorerTopBar({
  storages,
  selectedStorageId,
  defaultFolderId,
  listing,
  loading,
  onStorageChange,
  onNavigateTo,
  onRefresh,
}: FolderExplorerTopBarProps) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "0.75rem",
        background: "var(--bg-surface, #1e1e24)",
        border: "1px solid var(--border-subtle, #27272a)",
        borderRadius: "10px",
        padding: "0.75rem 1rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        {storages.length > 1 && (
          <select
            className="input btn-sm"
            value={selectedStorageId}
            onChange={(e) => onStorageChange(e.target.value)}
            style={{ padding: "0.3rem 0.6rem", fontSize: "0.82rem" }}
          >
            {storages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label || s.providerUid || s.id} ({s.provider})
              </option>
            ))}
          </select>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.85rem", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onNavigateTo(defaultFolderId)}
            style={{ border: "none", padding: "0.2rem 0.5rem", fontSize: "0.82rem", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
          >
            <HardDrive size={13} /> 库目录根
          </button>

          {listing?.breadcrumbs &&
            listing.breadcrumbs.map((crumb, idx) => (
              <div key={crumb.id || idx} style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                <ChevronRight size={14} style={{ color: "var(--text-muted, #71717a)" }} />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onNavigateTo(crumb.id)}
                  style={{
                    border: "none",
                    padding: "0.2rem 0.5rem",
                    fontSize: "0.82rem",
                    fontWeight: idx === (listing.breadcrumbs?.length ?? 1) - 1 ? 600 : 400,
                    color: idx === (listing.breadcrumbs?.length ?? 1) - 1 ? "var(--accent, #22c55e)" : undefined,
                  }}
                >
                  {crumb.name}
                </button>
              </div>
            ))}
        </div>
      </div>

      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={onRefresh}
        disabled={loading}
        style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
      >
        <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        刷新目录
      </button>
    </div>
  );
}

interface FolderCardItemProps {
  item: DriveFileItem;
  onNavigateTo: (dirId: string) => void;
  onPlayVideo: (file: DriveFileItem) => void;
}

function FolderCardItem({ item, onNavigateTo, onPlayVideo }: FolderCardItemProps) {
  const isVideo = item.type === "video";
  const isFolder = item.isFolder;

  const bgStyle = isFolder
    ? "rgba(234, 179, 8, 0.15)"
    : isVideo
      ? "rgba(34, 197, 94, 0.15)"
      : "rgba(255, 255, 255, 0.06)";

  const colorStyle = isFolder
    ? "#facc15"
    : isVideo
      ? "#4ade80"
      : "var(--text-muted, #a1a1aa)";

  return (
    <div
      onClick={() => {
        if (isFolder) onNavigateTo(item.id);
        else if (isVideo) onPlayVideo(item);
      }}
      style={{
        background: "var(--bg-surface, #1e1e24)",
        border: "1px solid var(--border-subtle, #27272a)",
        borderRadius: "8px",
        padding: "0.85rem 1rem",
        cursor: "pointer",
        transition: "all 0.15s ease",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "0.75rem",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--accent, #22c55e)";
        e.currentTarget.style.transform = "translateY(-2px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border-subtle, #27272a)";
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", minWidth: 0, flex: 1 }}>
        <div
          style={{
            width: "36px",
            height: "36px",
            borderRadius: "8px",
            background: bgStyle,
            color: colorStyle,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {isFolder ? <Folder size={18} /> : isVideo ? <Film size={18} /> : <FileText size={18} />}
        </div>

        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: "0.85rem",
              fontWeight: 600,
              color: "var(--text, #f4f4f5)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={item.name}
          >
            {item.name}
          </div>
          <div style={{ fontSize: "0.74rem", color: "var(--text-muted, #a1a1aa)", marginTop: "0.2rem" }}>
            {isFolder ? "文件夹" : formatFileSize(item.sizeBytes)}
          </div>
        </div>
      </div>

      {isVideo && (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            onPlayVideo(item);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
            fontSize: "0.75rem",
            padding: "0.25rem 0.6rem",
            borderRadius: "6px",
            flexShrink: 0,
          }}
        >
          <Play size={11} fill="currentColor" /> 播放
        </button>
      )}

      {isFolder && (
        <ChevronRight size={16} style={{ color: "var(--text-muted, #71717a)", flexShrink: 0 }} />
      )}
    </div>
  );
}

export function LibraryFolderExplorer({
  libraryId: _libraryId,
  bindings,
  storages,
  defaultDeliveryMode = "redirect",
}: LibraryFolderExplorerProps) {
  const defaultStorageId = bindings[0]?.storageId || storages[0]?.id || "";
  const defaultFolderId = bindings[0]?.remoteFolderId || "0";

  const [selectedStorageId, setSelectedStorageId] = useState<string>(defaultStorageId);
  const [currentFolderId, setCurrentFolderId] = useState<string>(defaultFolderId);
  const [listing, setListing] = useState<DriveDirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [playingFile, setPlayingFile] = useState<{
    fileName: string;
    streamUrl: string;
    proxyUrl: string;
    deliveryMode: "redirect" | "proxy";
  } | null>(null);

  const fetchDirectory = async (storageId: string, dirId: string) => {
    if (!storageId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ storageId, dirId });
      const res = await fetch(`/api/storage/files?${params.toString()}`);
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error || "读取网盘目录失败");
      }
      const data = (await res.json()) as DriveDirectoryListing;
      setListing(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "读取网盘目录失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedStorageId) {
      void fetchDirectory(selectedStorageId, currentFolderId);
    }
  }, [selectedStorageId, currentFolderId]);

  const handleStorageChange = (newStorageId: string) => {
    setSelectedStorageId(newStorageId);
    const matchedBinding = bindings.find((b) => b.storageId === newStorageId);
    setCurrentFolderId(matchedBinding?.remoteFolderId || "0");
  };

  const handlePlayVideo = (file: DriveFileItem) => {
    const { streamUrl, proxyUrl } = buildPlayStreamUrls({
      storageId: selectedStorageId,
      fileId: file.id,
      fileName: file.name,
      pickCode: file.pickCode,
    });
    // binding 显式配置优先；inherit 时向上继承库默认，不再硬编码 redirect。
    const binding = bindings.find((b) => b.storageId === selectedStorageId);
    const deliveryMode: "redirect" | "proxy" =
      binding && binding.deliveryMode !== "inherit"
        ? binding.deliveryMode
        : defaultDeliveryMode;
    setPlayingFile({ fileName: file.name, streamUrl, proxyUrl, deliveryMode });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <FolderExplorerTopBar
        storages={storages}
        selectedStorageId={selectedStorageId}
        defaultFolderId={defaultFolderId}
        listing={listing}
        loading={loading}
        onStorageChange={handleStorageChange}
        onNavigateTo={setCurrentFolderId}
        onRefresh={() => void fetchDirectory(selectedStorageId, currentFolderId)}
      />

      {error && (
        <div style={{ padding: "0.85rem 1rem", background: "rgba(239, 68, 68, 0.15)", border: "1px solid rgba(239, 68, 68, 0.3)", color: "#ef4444", borderRadius: "8px", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div style={{ padding: "4rem", textAlign: "center", color: "var(--text-muted, #a1a1aa)" }}>
          正在加载网盘目录...
        </div>
      ) : !listing || listing.items.length === 0 ? (
        <div
          style={{
            padding: "4rem 2rem",
            textAlign: "center",
            color: "var(--text-muted, #a1a1aa)",
            background: "rgba(255, 255, 255, 0.02)",
            borderRadius: "10px",
            border: "1px dashed var(--border, #333)",
          }}
        >
          <Folder size={36} style={{ margin: "0 auto 0.75rem auto", opacity: 0.5 }} />
          <p style={{ margin: 0, fontSize: "0.9rem" }}>当前文件夹为空</p>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: "0.85rem",
          }}
        >
          {listing.items.map((item) => (
            <FolderCardItem
              key={item.id}
              item={item}
              onNavigateTo={setCurrentFolderId}
              onPlayVideo={handlePlayVideo}
            />
          ))}
        </div>
      )}

      {playingFile && (
        <MediaryPlayerModal
          title={playingFile.fileName}
          streamUrl={playingFile.streamUrl}
          proxyUrl={playingFile.proxyUrl}
          deliveryMode={playingFile.deliveryMode}
          deliverySource="binding"
          onClose={() => setPlayingFile(null)}
        />
      )}
    </div>
  );
}

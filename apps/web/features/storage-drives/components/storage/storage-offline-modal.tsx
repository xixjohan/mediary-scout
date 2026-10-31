"use client";

import { useEffect, useState, useTransition } from "react";
import { DownloadCloud, FileUp, Film, Folder, Link as LinkIcon, LoaderCircle, Tv, X } from "lucide-react";
import type { DriveDirectoryListing } from "@media-track/workflow";
import type { ConnectedStorageView } from "../../../../lib/workflow-runtime";
import { formatProviderLabel } from "./storage-top-bar";

interface StorageOfflineModalProps {
  isOpen: boolean;
  onClose: () => void;
  storage: ConnectedStorageView | undefined;
  listing?: DriveDirectoryListing | undefined;
  onSuccess?: () => void;
}

type TabType = "links" | "torrent";

interface OfflineCapability {
  supported: boolean;
  provider: string;
  schemes: string[];
  supportsTorrent: boolean;
  message?: string;
}

async function fileToBase64(file: File): Promise<string> {
  const arrayBuf = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function OfflineCapabilityBar({
  loading,
  capability,
}: {
  loading: boolean;
  capability: OfflineCapability | null;
}) {
  if (loading) {
    return (
      <div className="storage-offline-cap-bar loading">
        <LoaderCircle size={14} className="spin" />
        <span>正在探测网盘离线下载接口…</span>
      </div>
    );
  }
  if (!capability?.supported) {
    return (
      <div className="storage-offline-cap-bar warning">
        <span>⚠️ {capability?.message || "当前网盘不支持离线下载功能，请切换到 115网盘 或 123云盘。"}</span>
      </div>
    );
  }
  return (
    <div className="storage-offline-cap-bar success">
      <span>
        ✓ 该网盘支持云端离线：
        {capability.schemes.map((s) => s.toUpperCase()).join(" / ")}
        {capability.supportsTorrent ? " 及 BT 种子" : ""}
      </span>
    </div>
  );
}

function OfflineDestinationPicker({
  listing,
  targetDir,
  setTargetDir,
  customTargetDir,
  setCustomTargetDir,
}: {
  listing: DriveDirectoryListing;
  targetDir: string;
  setTargetDir: (dir: string) => void;
  customTargetDir: string;
  setCustomTargetDir: (dir: string) => void;
}) {
  const rootId = listing.rootCid || "0";

  return (
    <div className="storage-offline-dest-section">
      <label className="storage-picker-title">离线存储目标目录：</label>
      <div className="storage-quick-dest-row">
        <button
          type="button"
          className={`storage-quick-dest-btn ${targetDir === rootId ? "is-selected" : ""}`}
          onClick={() => {
            setTargetDir(rootId);
            setCustomTargetDir("");
          }}
        >
          <Folder size={14} /> 根目录
        </button>
        {listing.moviesCid && (
          <button
            type="button"
            className={`storage-quick-dest-btn ${targetDir === listing.moviesCid ? "is-selected" : ""}`}
            onClick={() => {
              setTargetDir(listing.moviesCid!);
              setCustomTargetDir("");
            }}
          >
            <Film size={14} /> 电影目录
          </button>
        )}
        {listing.tvCid && (
          <button
            type="button"
            className={`storage-quick-dest-btn ${targetDir === listing.tvCid ? "is-selected" : ""}`}
            onClick={() => {
              setTargetDir(listing.tvCid!);
              setCustomTargetDir("");
            }}
          >
            <Tv size={14} /> 剧集目录
          </button>
        )}
        {listing.animeCid && (
          <button
            type="button"
            className={`storage-quick-dest-btn ${targetDir === listing.animeCid ? "is-selected" : ""}`}
            onClick={() => {
              setTargetDir(listing.animeCid!);
              setCustomTargetDir("");
            }}
          >
            <Film size={14} /> 动漫目录
          </button>
        )}
      </div>
      <div className="storage-custom-target-input">
        <label htmlFor="custom-offline-dest">或手动输入目录 ID：</label>
        <input
          id="custom-offline-dest"
          type="text"
          placeholder="例如目录 CID / FID"
          value={customTargetDir}
          onChange={(e) => {
            const v = e.target.value.trim();
            setCustomTargetDir(v);
            if (v) setTargetDir(v);
          }}
        />
      </div>
    </div>
  );
}

function OfflineLinksInput({
  linksText,
  setLinksText,
  isSupported,
  submitting,
}: {
  linksText: string;
  setLinksText: (v: string) => void;
  isSupported: boolean;
  submitting: boolean;
}) {
  return (
    <div className="storage-offline-field">
      <label htmlFor="offline-links-input">下载链接（支持多行粘贴，每行一条）：</label>
      <textarea
        id="offline-links-input"
        className="storage-offline-textarea"
        rows={5}
        placeholder={`支持 magnet: 磁力链接、http://、https://、ftp:// 或 ed2k:// 链接：\nmagnet:?xt=urn:btih:0123456789abcdef...\nhttps://example.com/movie.mp4`}
        value={linksText}
        onChange={(e) => setLinksText(e.target.value)}
        disabled={!isSupported || submitting}
      />
    </div>
  );
}

function OfflineTorrentInput({
  torrentFile,
  setTorrentFile,
  isSupported,
  submitting,
}: {
  torrentFile: File | null;
  setTorrentFile: (file: File | null) => void;
  isSupported: boolean;
  submitting: boolean;
}) {
  return (
    <div className="storage-offline-field">
      <label htmlFor="offline-torrent-input">选择 .torrent 种子文件：</label>
      <div className="storage-offline-upload-zone">
        <input
          id="offline-torrent-input"
          type="file"
          accept=".torrent"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setTorrentFile(f);
          }}
          disabled={!isSupported || submitting}
        />
        <FileUp size={24} className="storage-upload-zone-icon" />
        {torrentFile ? (
          <p className="storage-upload-file-name">
            已选择：<strong>{torrentFile.name}</strong> ({(torrentFile.size / 1024).toFixed(1)} KB)
          </p>
        ) : (
          <p className="storage-upload-zone-hint">点击浏览或将 .torrent 种子文件拖拽至此处</p>
        )}
      </div>
    </div>
  );
}

function parseInputUrls(linksText: string): string[] {
  return linksText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function StorageOfflineModal({
  isOpen,
  onClose,
  storage,
  listing,
  onSuccess,
}: StorageOfflineModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>("links");
  const [linksText, setLinksText] = useState("");
  const [torrentFile, setTorrentFile] = useState<File | null>(null);
  const [targetDir, setTargetDir] = useState<string>("");
  const [customTargetDir, setCustomTargetDir] = useState<string>("");
  const [capability, setCapability] = useState<OfflineCapability | null>(null);
  const [capLoading, setCapLoading] = useState(false);
  const [submitting, startSubmitting] = useTransition();
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const storageId = storage?.id;

  useEffect(() => {
    if (!isOpen || !storageId) return;
    let cancelled = false;
    setCapLoading(true);
    setStatusMsg(null);

    fetch(`/api/storage/offline?storageId=${encodeURIComponent(storageId)}`)
      .then((res) => res.json())
      .then((data: OfflineCapability) => {
        if (!cancelled) {
          setCapability(data);
          setCapLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("fetch capability failed:", err);
          setCapability({
            supported: false,
            provider: storage?.provider || "",
            schemes: [],
            supportsTorrent: false,
            message: "无法查询网盘离线能力",
          });
          setCapLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, storageId, storage?.provider]);

  useEffect(() => {
    if (listing) {
      setTargetDir(listing.moviesCid || listing.rootCid || "0");
    }
  }, [listing]);

  if (!isOpen || !storage) return null;

  const handleSubmit = () => {
    if (!storageId || submitting) return;
    setStatusMsg(null);

    const urls = parseInputUrls(linksText);
    if (activeTab === "links" && urls.length === 0) {
      setStatusMsg({ type: "error", text: "请在输入框中粘贴至少一条有效下载链接" });
      return;
    }
    if (activeTab === "torrent" && !torrentFile) {
      setStatusMsg({ type: "error", text: "请先选择需要离线下载的 .torrent 种子文件" });
      return;
    }

    startSubmitting(async () => {
      try {
        const torrentBase64 = torrentFile ? await fileToBase64(torrentFile) : undefined;
        const res = await fetch("/api/storage/offline", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            storageId,
            urls: activeTab === "links" ? urls : [],
            directoryId: targetDir || undefined,
            torrentName: torrentFile?.name,
            torrentBase64,
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatusMsg({ type: "error", text: data.error || "提交离线下载失败" });
          return;
        }

        setStatusMsg({
          type: "success",
          text: `成功提交 ${data.submitted || 1} 个离线下载任务！网盘将在云端自动完成转存。`,
        });
        setLinksText("");
        setTorrentFile(null);
        if (onSuccess) onSuccess();
      } catch (err) {
        setStatusMsg({
          type: "error",
          text: err instanceof Error ? err.message : "提交离线下载时网络异常",
        });
      }
    });
  };

  const isSupported = capability?.supported ?? false;

  return (
    <div className="storage-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="storage-modal-card storage-offline-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="offline-modal-title"
      >
        <header className="storage-modal-head">
          <div className="storage-offline-title-row">
            <DownloadCloud size={20} className="storage-offline-head-icon" />
            <h2 id="offline-modal-title">新建网盘离线下载</h2>
            <span className="storage-offline-drive-tag">
              {formatProviderLabel(storage.provider)}
            </span>
          </div>
          <button type="button" className="storage-modal-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="storage-offline-body">
          <OfflineCapabilityBar loading={capLoading} capability={capability} />

          <div className="storage-offline-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "links"}
              className={`storage-offline-tab-btn ${activeTab === "links" ? "is-active" : ""}`}
              onClick={() => setActiveTab("links")}
            >
              <LinkIcon size={14} />
              <span>直链 / 磁力批量添加</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "torrent"}
              className={`storage-offline-tab-btn ${activeTab === "torrent" ? "is-active" : ""}`}
              onClick={() => setActiveTab("torrent")}
              disabled={capability !== null && !capability.supportsTorrent}
            >
              <FileUp size={14} />
              <span>BT 种子上传</span>
            </button>
          </div>

          {activeTab === "links" ? (
            <OfflineLinksInput
              linksText={linksText}
              setLinksText={setLinksText}
              isSupported={isSupported}
              submitting={submitting}
            />
          ) : (
            <OfflineTorrentInput
              torrentFile={torrentFile}
              setTorrentFile={setTorrentFile}
              isSupported={isSupported}
              submitting={submitting}
            />
          )}

          {listing && (
            <OfflineDestinationPicker
              listing={listing}
              targetDir={targetDir}
              setTargetDir={setTargetDir}
              customTargetDir={customTargetDir}
              setCustomTargetDir={setCustomTargetDir}
            />
          )}

          {statusMsg && (
            <div className={`storage-offline-status-bar ${statusMsg.type}`}>
              <span>{statusMsg.text}</span>
            </div>
          )}
        </div>

        <footer className="storage-modal-foot">
          <button type="button" className="storage-btn" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="storage-btn primary"
            onClick={handleSubmit}
            disabled={!isSupported || submitting}
          >
            {submitting ? (
              <>
                <LoaderCircle size={14} className="spin" />
                <span>正在提交…</span>
              </>
            ) : (
              <>
                <DownloadCloud size={14} />
                <span>立即提交离线下载</span>
              </>
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}

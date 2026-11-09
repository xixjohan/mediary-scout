"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { DownloadCloud, FileUp, Link as LinkIcon, LoaderCircle, X } from "lucide-react";
import type { DriveDirectoryListing } from "@media-track/workflow";
import type { ConnectedStorageView } from "../../../../lib/workflow-runtime";
import type { OfflineCapabilities } from "../../../../app/api/storage/offline/route";
import { formatProviderLabel } from "./storage-top-bar";
import { RemoteFolderPickerModal } from "./remote-folder-picker-modal";
import { parseBatchIngestInput, type BatchIngestResult } from "../../core/ingest-protocol-router";
import { IngestDestinationPicker } from "./ingest-destination-picker";
import {
  IngestCapabilityBar,
  IngestLinksInput,
  IngestTorrentInput,
  fileToBase64,
} from "./ingest-inputs";

export interface StorageOfflineModalProps {
  isOpen: boolean;
  onClose: () => void;
  storage: ConnectedStorageView | undefined;
  listing?: DriveDirectoryListing | undefined;
  onSuccess?: () => void;
}

type TabType = "links" | "torrent";

export type OfflineCapability = OfflineCapabilities;

function resolveSubmitButtonText(
  submitting: boolean,
  activeTab: TabType,
  parsedBatch: BatchIngestResult
): string {
  if (submitting) return "正在提交…";
  if (activeTab === "torrent") return "立即提交种子离线";
  if (parsedBatch.shareCount > 0 && parsedBatch.offlineCount === 0) {
    return `立即批量转存 (${parsedBatch.shareCount} 条)`;
  }
  if (parsedBatch.offlineCount > 0 && parsedBatch.shareCount === 0) {
    return `立即提交离线下载 (${parsedBatch.offlineCount} 条)`;
  }
  if (parsedBatch.validCount > 0) {
    return `立即提交下载与转存 (${parsedBatch.validCount} 条)`;
  }
  return "立即提交任务";
}

function useDriveCapability(isOpen: boolean, storageId: string, provider: string) {
  const [capability, setCapability] = useState<OfflineCapability | null>(null);
  const [capLoading, setCapLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !storageId) return;
    let cancelled = false;
    setCapLoading(true);

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
            provider,
            schemes: [],
            supportsTorrent: false,
            supportsOffline: false,
            supportsShareTransfer: false,
            supportedShareBrands: [],
            message: "无法查询网盘下载或转存能力",
          });
          setCapLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, storageId, provider]);

  return { capability, capLoading };
}

interface IngestSubmitParams {
  storageId: string;
  activeTab: TabType;
  parsedBatch: BatchIngestResult;
  torrentFile: File | null;
  targetDir: string;
}

async function postIngestTask(params: IngestSubmitParams): Promise<string> {
  const { storageId, activeTab, parsedBatch, torrentFile, targetDir } = params;
  const torrentBase64 = torrentFile ? await fileToBase64(torrentFile) : undefined;
  const offlineUrls = parsedBatch.items.filter((i) => i.isValid && i.action === "offline").map((i) => i.url);
  const shareTasks = parsedBatch.items
    .filter((i) => i.isValid && i.action === "share_transfer")
    .map((i) => ({ url: i.url, shareCode: i.shareCode, passcode: i.passcode, brand: i.matchedBrand }));

  const res = await fetch("/api/storage/offline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      storageId,
      urls: activeTab === "links" ? offlineUrls : [],
      shareTasks: activeTab === "links" ? shareTasks : [],
      directoryId: targetDir || undefined,
      torrentName: torrentFile?.name,
      torrentBase64,
    }),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error((data["error"] as string) || "提交下载与转存任务失败");
  }

  const submitted = (data["submitted"] as number) || 1;
  const succeeded = (data["succeeded"] as number) || submitted;
  return `成功提交 ${submitted} 个入库任务（${succeeded} 个已完成）！网盘将在云端完成落盘。`;
}

function IngestModalTabs({
  activeTab,
  setActiveTab,
  supportsTorrent,
}: {
  activeTab: TabType;
  setActiveTab: (t: TabType) => void;
  supportsTorrent: boolean;
}) {
  return (
    <div className="storage-offline-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "links"}
        className={`storage-offline-tab ${activeTab === "links" ? "active" : ""}`}
        onClick={() => setActiveTab("links")}
      >
        <LinkIcon size={14} />
        <span>直链 / 磁力 / 分享批量添加</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "torrent"}
        className={`storage-offline-tab ${activeTab === "torrent" ? "active" : ""}`}
        onClick={() => setActiveTab("torrent")}
        disabled={!supportsTorrent}
        title={!supportsTorrent ? "当前网盘不支持 BT 种子解析" : undefined}
      >
        <FileUp size={14} />
        <span>BT 种子上传</span>
      </button>
    </div>
  );
}

function StorageOfflineModalContent({
  onClose,
  storage,
  listing,
  onSuccess,
}: {
  onClose: () => void;
  storage: ConnectedStorageView;
  listing?: DriveDirectoryListing | undefined;
  onSuccess?: (() => void) | undefined;
}) {
  const [activeTab, setActiveTab] = useState<TabType>("links");
  const [linksText, setLinksText] = useState("");
  const [torrentFile, setTorrentFile] = useState<File | null>(null);
  const [targetDir, setTargetDir] = useState<string>("");
  const [targetPath, setTargetPath] = useState<string>("");
  const [customTargetDir, setCustomTargetDir] = useState<string>("");
  const [submitting, startSubmitting] = useTransition();
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const storageId = storage.id;
  const provider = storage.provider;
  const providerLabel = formatProviderLabel(provider);
  const { capability, capLoading } = useDriveCapability(true, storageId, provider);

  const parsedBatch = useMemo(
    () => parseBatchIngestInput(linksText, provider),
    [linksText, provider]
  );

  useEffect(() => {
    if (listing) {
      setTargetDir(listing.moviesCid || listing.rootCid || "0");
      setTargetPath(listing.moviesCid ? "/电影" : "/");
    }
  }, [listing]);

  const validateInput = (): boolean => {
    if (activeTab === "links") {
      if (parsedBatch.items.length === 0) {
        setStatusMsg({ type: "error", text: "请在输入框中粘贴至少一条下载直链、磁力或分享链接" });
        return false;
      }
      if (parsedBatch.validCount === 0) {
        setStatusMsg({ type: "error", text: "未能识别到可用的任务条目，请检查输入或切换到匹配的网盘" });
        return false;
      }
    }
    if (activeTab === "torrent" && !torrentFile) {
      setStatusMsg({ type: "error", text: "请先选择需要离线下载的 .torrent 种子文件" });
      return false;
    }
    return true;
  };

  const handleSubmit = () => {
    if (submitting) return;
    setStatusMsg(null);
    if (!validateInput()) return;

    startSubmitting(async () => {
      try {
        const text = await postIngestTask({
          storageId,
          activeTab,
          parsedBatch,
          torrentFile,
          targetDir,
        });
        setStatusMsg({ type: "success", text });
        setLinksText("");
        setTorrentFile(null);
        if (onSuccess) onSuccess();
      } catch (err) {
        setStatusMsg({
          type: "error",
          text: err instanceof Error ? err.message : "提交下载或转存任务时网络异常",
        });
      }
    });
  };

  const isSupported = capability?.supported ?? false;
  const supportsTorrent = capability?.supportsTorrent ?? false;
  const submitBtnText = resolveSubmitButtonText(submitting, activeTab, parsedBatch);
  const submitDisabled = !isSupported || submitting || (activeTab === "links" && parsedBatch.validCount === 0 && !torrentFile);

  return (
    <>
      <div className="storage-offline-modal-overlay" onClick={onClose} role="presentation">
        <div
          className="storage-offline-modal-card"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="offline-modal-title"
        >
          <header className="storage-offline-modal-header">
            <div className="storage-offline-title-row">
              <DownloadCloud size={20} className="storage-offline-head-icon" />
              <h2 id="offline-modal-title">新建下载 / 转存</h2>
              <span className="storage-offline-drive-tag">{providerLabel}</span>
            </div>
            <button type="button" className="storage-offline-modal-close" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </header>

          <div className="storage-offline-modal-body">
            <IngestCapabilityBar loading={capLoading} capability={capability} providerLabel={providerLabel} />

            <IngestModalTabs
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              supportsTorrent={supportsTorrent}
            />

            {activeTab === "links" ? (
              <IngestLinksInput
                linksText={linksText}
                setLinksText={setLinksText}
                isSupported={isSupported}
                submitting={submitting}
                parsedBatch={parsedBatch}
              />
            ) : (
              <IngestTorrentInput
                torrentFile={torrentFile}
                setTorrentFile={setTorrentFile}
                isSupported={isSupported}
                submitting={submitting}
              />
            )}

            {listing && (
              <IngestDestinationPicker
                listing={listing}
                targetDir={targetDir}
                setTargetDir={setTargetDir}
                targetPath={targetPath}
                setTargetPath={setTargetPath}
                customTargetDir={customTargetDir}
                setCustomTargetDir={setCustomTargetDir}
                onOpenPicker={() => setPickerOpen(true)}
              />
            )}

            {statusMsg && (
              <div className={`storage-offline-status-banner is-${statusMsg.type}`}>
                <span>{statusMsg.text}</span>
              </div>
            )}
          </div>

          <footer className="storage-offline-modal-footer">
            <button type="button" className="storage-btn" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button
              type="button"
              className="storage-btn primary"
              onClick={handleSubmit}
              disabled={submitDisabled}
            >
              {submitting ? (
                <>
                  <LoaderCircle size={14} className="spin" />
                  <span>正在提交…</span>
                </>
              ) : (
                <>
                  <DownloadCloud size={14} />
                  <span>{submitBtnText}</span>
                </>
              )}
            </button>
          </footer>
        </div>
      </div>

      {/* 可视化树形目录选择模态框 */}
      {pickerOpen && (
        <RemoteFolderPickerModal
          storageId={storageId}
          initialFolderId={targetDir || "0"}
          title={`选择存储目标目录 (${providerLabel})`}
          onSelect={(folderId, fullPath) => {
            setTargetDir(folderId);
            setTargetPath(fullPath);
            setCustomTargetDir("");
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

export function StorageOfflineModal({
  isOpen,
  onClose,
  storage,
  listing,
  onSuccess,
}: StorageOfflineModalProps) {
  if (!isOpen || !storage) return null;
  return (
    <StorageOfflineModalContent
      onClose={onClose}
      storage={storage}
      listing={listing}
      onSuccess={onSuccess}
    />
  );
}

// 别名导出保障向前兼容
export { StorageOfflineModal as StorageIngestModal };

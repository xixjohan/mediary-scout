"use client";

import { AlertTriangle, CheckCircle2, FileUp, LoaderCircle } from "lucide-react";
import type { OfflineCapabilities } from "../../../../app/api/storage/offline/route";
import { formatProviderLabel } from "./storage-top-bar";
import type { IngestParsedItem, BatchIngestResult } from "../../core/ingest-protocol-router";

export async function fileToBase64(file: File): Promise<string> {
  const arrayBuf = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function IngestCapabilityBar({
  loading,
  capability,
  providerLabel,
}: {
  loading: boolean;
  capability: OfflineCapabilities | null;
  providerLabel: string;
}) {
  if (loading) {
    return (
      <div className="storage-offline-cap-bar loading">
        <LoaderCircle size={14} className="spin" />
        <span>正在探测网盘下载与转存能力…</span>
      </div>
    );
  }

  if (!capability?.supported) {
    return (
      <div className="storage-offline-cap-bar warning">
        <span>⚠️ {capability?.message || `当前网盘【${providerLabel}】暂不支持下载或转存功能。`}</span>
      </div>
    );
  }

  const supportsOffline = capability.supportsOffline ?? (capability.schemes && capability.schemes.length > 0);
  const supportsShare = capability.supportsShareTransfer ?? true;

  return (
    <div className="storage-offline-cap-bar success">
      <span>
        ✓ 该网盘支持：
        {supportsShare && " 网盘分享秒级转存"}
        {supportsShare && supportsOffline && " 及 "}
        {supportsOffline && `云端离线（${capability.schemes.map((s) => s.toUpperCase()).join(" / ")}）`}
        {capability.supportsTorrent ? " 及 BT 种子" : ""}
      </span>
    </div>
  );
}

function resolveBadgeInfo(item: IngestParsedItem): { badgeClass: string; badgeLabel: string; rowClass: string } {
  if (item.action === "share_transfer") {
    return {
      badgeClass: "share",
      badgeLabel: item.matchedBrand ? `${formatProviderLabel(item.matchedBrand)}转存` : "分享转存",
      rowClass: "is-valid",
    };
  }
  if (item.action === "offline") {
    return { badgeClass: "offline", badgeLabel: "云端离线", rowClass: "is-valid" };
  }
  if (item.action === "unsupported_brand" || item.action === "unsupported_scheme") {
    return { badgeClass: "warning", badgeLabel: "网盘不匹配", rowClass: "is-warning" };
  }
  return { badgeClass: "error", badgeLabel: "格式异常", rowClass: "is-invalid" };
}

export function IngestPreviewItemRow({ item }: { item: IngestParsedItem }) {
  const { badgeClass, badgeLabel, rowClass } = resolveBadgeInfo(item);

  return (
    <div className={`storage-ingest-preview-item ${rowClass}`}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", overflow: "hidden" }}>
        <span className={`storage-ingest-badge ${badgeClass}`}>{badgeLabel}</span>
        <span
          style={{
            fontFamily: "monospace",
            color: item.isValid ? "var(--text)" : "var(--text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "280px",
          }}
          title={item.url}
        >
          {item.url}
        </span>
        {item.passcode && (
          <span
            style={{
              fontSize: "0.72rem",
              background: "var(--bg-active)",
              padding: "0.1rem 0.35rem",
              borderRadius: "4px",
              color: "var(--accent)",
              flexShrink: 0,
            }}
          >
            码: {item.passcode}
          </span>
        )}
      </div>
      <div style={{ fontSize: "0.74rem", color: item.isValid ? "var(--accent)" : "var(--color-danger)", flexShrink: 0 }}>
        {item.isValid ? <CheckCircle2 size={13} style={{ display: "inline", verticalAlign: "middle" }} /> : item.reason}
      </div>
    </div>
  );
}

export function IngestLinksInput({
  linksText,
  setLinksText,
  isSupported,
  submitting,
  parsedBatch,
}: {
  linksText: string;
  setLinksText: (v: string) => void;
  isSupported: boolean;
  submitting: boolean;
  parsedBatch: BatchIngestResult;
}) {
  return (
    <div className="storage-offline-field">
      <label htmlFor="offline-links-input">
        资源链接（支持直链、磁力或各大网盘分享链接，可多行粘贴并自动识别提取码）：
      </label>
      <textarea
        id="offline-links-input"
        className="storage-offline-textarea"
        rows={4}
        placeholder={`支持磁力链接、HTTP(S)直链 或 网盘分享链接（自动识别提取码）：\nmagnet:?xt=urn:btih:0123456789abcdef...\nhttps://pan.quark.cn/s/60e73719ddb8 提取码: nN4v\nhttps://115.com/s/sw3abcd?password=6666`}
        value={linksText}
        onChange={(e) => setLinksText(e.target.value)}
        disabled={!isSupported || submitting}
      />

      {/* 实时策略解析条目卡片 */}
      {parsedBatch.items.length > 0 && (
        <>
          <div className="storage-ingest-preview-container">
            {parsedBatch.items.map((item) => (
              <IngestPreviewItemRow key={item.id} item={item} />
            ))}
          </div>
          <div className="storage-ingest-summary-bar">
            <span>{parsedBatch.summaryMessage}</span>
            {parsedBatch.hasUnsupported && (
              <span className="storage-ingest-warn-text">
                <AlertTriangle size={12} style={{ display: "inline", marginRight: "0.2rem" }} />
                请切换到匹配的网盘再提交转存
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function IngestTorrentInput({
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

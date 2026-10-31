"use client";

import { Link as LinkIcon } from "lucide-react";
import type { ResourceCandidateView, ResourceType } from "@media-track/workflow";

export interface CandidateLinkState {
  open: boolean;
  loading: boolean;
  data?:
    | {
        candidateId: string;
        type?: string;
        source?: string;
        url?: string;
        password?: string | null;
        formatted?: string;
        accessKind?: string;
        link?: {
          url: string;
          password?: string;
          accessKind: string;
          displayUrl: string;
        };
      }
    | undefined;
  error?: string | undefined;
}

/** 字节数的人类可读形式。provider 不上报体积时整块不渲染。 */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatPostedAt(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().slice(0, 10);
}

/**
 * 候选的资源类型 ⇒ 用户看得懂的品牌名。
 */
export function resourceTypeLabel(type: ResourceType): string {
  switch (type) {
    case "115":
      return "115";
    case "quark":
      return "夸克";
    case "uc":
      return "UC";
    case "tianyi":
      return "天翼";
    case "123":
      return "123";
    case "guangya":
      return "光鸭";
    case "magnet":
      return "磁力";
    case "manual":
      return "手动";
  }
}

function resolveDisplayValues(data: NonNullable<CandidateLinkState["data"]>) {
  const url = data.url || data.link?.url || "";
  const displayUrl = data.formatted || data.link?.displayUrl || url || "暂无可访问链接";
  const rawKind = data.accessKind || data.link?.accessKind || "";
  const accessKind = rawKind === "magnet" || url.startsWith("magnet:") ? "磁力" : "网盘";
  return { url, displayUrl, accessKind };
}

function DrawerFeedback({ info }: { info: CandidateLinkState }) {
  if (info.loading) {
    return (
      <div className="title-resources-link-drawer">
        <span className="title-resources-link-loading">正在提取安全链接…</span>
      </div>
    );
  }
  if (info.error) {
    return (
      <div className="title-resources-link-drawer">
        <span className="title-resources-link-error">{info.error}</span>
      </div>
    );
  }
  return null;
}

interface CandidateLinkDrawerProps {
  info?: CandidateLinkState | undefined;
  copied: boolean;
  onCopy: (text: string) => void;
}

export function CandidateLinkDrawer({ info, copied, onCopy }: CandidateLinkDrawerProps) {
  if (!info || !info.open) return null;
  if (info.loading || info.error) {
    return <DrawerFeedback info={info} />;
  }
  if (!info.data) return null;

  const { url, displayUrl, accessKind } = resolveDisplayValues(info.data);

  return (
    <div className="title-resources-link-drawer">
      <div className="title-resources-link-content">
        <span className="title-resources-link-badge">
          {accessKind}
        </span>
        <span className="title-resources-link-url" title={displayUrl}>
          {displayUrl}
        </span>
        {url ? (
          <button
            type="button"
            className="title-resources-link-copy-btn"
            onClick={() => onCopy(displayUrl)}
            title="复制到剪贴板"
          >
            {copied ? "已复制 ✓" : "复制"}
          </button>
        ) : null}
        {url.startsWith("http") && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="title-resources-link-open-btn"
            title="新标签页打开"
          >
            打开 ↗
          </a>
        )}
      </div>
    </div>
  );
}

export interface ResourceCandidateRowProps {
  candidate: ResourceCandidateView;
  importable: boolean;
  rowBusy: boolean;
  busy: boolean;
  throttled: boolean;
  streaming: boolean;
  linkInfo?: CandidateLinkState | undefined;
  copied: boolean;
  onImport: () => void;
  onToggleLink: () => void;
  onCopyLink: (text: string) => void;
}

export function ResourceCandidateRow({
  candidate,
  importable,
  rowBusy,
  busy,
  throttled,
  streaming,
  linkInfo,
  copied,
  onImport,
  onToggleLink,
  onCopyLink,
}: ResourceCandidateRowProps) {
  const isLinkOpen = Boolean(linkInfo?.open);

  return (
    <li className="title-resources-item">
      <div className="title-resources-item-row">
        <div className="title-resources-item-main">
          <span className="title-resources-item-title" title={candidate.title}>
            {candidate.title}
          </span>
          <span className="title-resources-item-meta">
            <span className="resource-type-chip">{resourceTypeLabel(candidate.type)}</span>
            {candidate.sizeBytes !== undefined && ` · ${formatSize(candidate.sizeBytes)}`}
            {candidate.postedAt !== undefined && ` · ${formatPostedAt(candidate.postedAt)}`}
            {candidate.seeders !== undefined && ` · ${candidate.seeders} 做种`}
          </span>
        </div>
        <div className="title-resources-item-actions">
          <button
            type="button"
            className="title-resources-link-btn"
            onClick={onToggleLink}
            disabled={busy || throttled}
            title={
              streaming
                ? "检索全部完成生成快照后即可查看链接"
                : isLinkOpen
                  ? "收起资源地址"
                  : "查看资源链接/提取码"
            }
          >
            <LinkIcon size={13} aria-hidden />
            {isLinkOpen ? "收起" : "链接"}
          </button>
          <button
            type="button"
            className="title-resources-import"
            onClick={onImport}
            disabled={!importable || rowBusy || busy || throttled}
            title={
              streaming
                ? "检索全部完成生成快照后即可入库（首批结果已展示）"
                : importable
                  ? undefined
                  : "这是 30 分钟内的缓存结果，请重新查询后再入库"
            }
          >
            {rowBusy ? "入库中…" : "手动入库"}
          </button>
        </div>
      </div>
      <CandidateLinkDrawer info={linkInfo} copied={copied} onCopy={onCopyLink} />
    </li>
  );
}

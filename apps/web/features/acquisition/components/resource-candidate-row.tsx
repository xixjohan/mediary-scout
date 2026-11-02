"use client";

import { useState } from "react";
import {
  Link as LinkIcon,
  CheckCircle2,
  XCircle,
  KeyRound,
  Clock,
  HelpCircle,
  FolderTree,
  Loader2,
} from "lucide-react";
import type { ResourceCandidateView } from "@media-track/workflow";
import type {
  CandidateInspectionState,
  ResourceLinkResponse,
} from "../contracts/acquisition-types";
import {
  formatPostedAt,
  formatSize,
  resourceTypeLabel,
} from "../core/resource-formatters";
import { ResourceFolderTree } from "./resource-folder-tree";

export { formatPostedAt, formatSize, resourceTypeLabel };

export interface CandidateLinkState {
  open: boolean;
  loading: boolean;
  data?:
    | (Partial<ResourceLinkResponse> & {
        accessKind?: string;
        link?: {
          url: string;
          password?: string;
          accessKind: string;
          displayUrl: string;
        };
      })
    | undefined;
  error?: string | undefined;
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

function ValidityBadge({
  state,
  onInspect,
}: {
  state?: CandidateInspectionState | undefined;
  onInspect?: (() => void) | undefined;
}) {
  if (!state || state.status === "idle") {
    if (!onInspect) return null;
    return (
      <button
        type="button"
        className="resource-validity-badge idle"
        onClick={(e) => {
          e.stopPropagation();
          onInspect();
        }}
        title="点击探测试效性与文件树"
      >
        <FolderTree size={12} aria-hidden />
        <span>探活 / 树</span>
      </button>
    );
  }

  if (state.loading || state.status === "probing") {
    return (
      <span className="resource-validity-badge probing" title="正在嗅探网盘状态">
        <Loader2 size={12} className="resource-spinner" aria-hidden />
        <span>嗅探中…</span>
      </span>
    );
  }

  if (state.status === "valid") {
    return (
      <span className="resource-validity-badge valid" title="网盘资源链接有效">
        <CheckCircle2 size={12} aria-hidden />
        <span>有效</span>
      </span>
    );
  }

  if (state.status === "invalid") {
    return (
      <span className="resource-validity-badge invalid" title={state.message || "链接已失效或取消"}>
        <XCircle size={12} aria-hidden />
        <span>已失效</span>
      </span>
    );
  }

  if (state.status === "password_required") {
    return (
      <span className="resource-validity-badge password" title={state.message || "需提取码"}>
        <KeyRound size={12} aria-hidden />
        <span>需提取码</span>
      </span>
    );
  }

  if (state.status === "rate_limited") {
    return (
      <span className="resource-validity-badge throttled" title={state.message || "网盘限流冷却中"}>
        <Clock size={12} aria-hidden />
        <span>限流中</span>
      </span>
    );
  }

  return (
    <span className="resource-validity-badge unknown" title={state.message || "未明确状态"}>
      <HelpCircle size={12} aria-hidden />
      <span>未知</span>
    </span>
  );
}

function CandidateMetaBar({
  candidate,
  displaySize,
  displayFileCount,
}: {
  candidate: ResourceCandidateView;
  displaySize?: number | undefined;
  displayFileCount?: number | undefined;
}) {
  return (
    <span className="title-resources-item-meta">
      <span className="resource-type-chip">{resourceTypeLabel(candidate.type)}</span>
      {displaySize !== undefined && (
        <span className="resource-meta-size"> · {formatSize(displaySize)}</span>
      )}
      {candidate.postedAt !== undefined && (
        <span className="resource-meta-date"> · {formatPostedAt(candidate.postedAt)}</span>
      )}
      {displayFileCount !== undefined && (
        <span className="resource-meta-count"> · {displayFileCount} 个文件</span>
      )}
      {candidate.seeders !== undefined && ` · ${candidate.seeders} 做种`}
    </span>
  );
}

function resolveImportTooltip(
  isInvalid: boolean,
  streaming: boolean,
  importable: boolean
): string | undefined {
  if (isInvalid) return "此网盘分享已失效，无法入库";
  if (streaming) return "检索全部完成生成快照后即可入库（首批结果已展示）";
  if (!importable) return "这是 30 分钟内的缓存结果，请重新查询后再入库";
  return undefined;
}

function CandidateActions({
  onInspect,
  showTree,
  onToggleTree,
  busy,
  throttled,
  onToggleLink,
  isLinkOpen,
  streaming,
  onImport,
  importable,
  rowBusy,
  isInvalid,
}: {
  onInspect?: (() => void) | undefined;
  showTree: boolean;
  onToggleTree: () => void;
  busy: boolean;
  throttled: boolean;
  onToggleLink: () => void;
  isLinkOpen: boolean;
  streaming: boolean;
  onImport: () => void;
  importable: boolean;
  rowBusy: boolean;
  isInvalid: boolean;
}) {
  return (
    <div className="title-resources-item-actions">
      {onInspect && (
        <button
          type="button"
          className={`title-resources-tree-btn ${showTree ? "active" : ""}`}
          onClick={onToggleTree}
          disabled={busy || throttled}
          title={showTree ? "收起文件目录" : "查看文件夹与文件清单"}
        >
          <FolderTree size={13} aria-hidden />
          {showTree ? "收起树" : "文件树"}
        </button>
      )}

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
        disabled={!importable || rowBusy || busy || throttled || isInvalid}
        title={resolveImportTooltip(isInvalid, streaming, importable)}
      >
        {rowBusy ? "入库中…" : "手动入库"}
      </button>
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
  inspectionInfo?: CandidateInspectionState | undefined;
  onImport: () => void;
  onToggleLink: () => void;
  onCopyLink: (text: string) => void;
  onInspect?: (() => void) | undefined;
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
  inspectionInfo,
  onImport,
  onToggleLink,
  onCopyLink,
  onInspect,
}: ResourceCandidateRowProps) {
  const [showTree, setShowTree] = useState(false);
  const isLinkOpen = Boolean(linkInfo?.open);

  const isInvalid = inspectionInfo?.status === "invalid";
  const displaySize = inspectionInfo?.totalSizeBytes ?? candidate.sizeBytes;
  const displayFileCount = inspectionInfo?.fileCount ?? candidate.fileCount;

  const handleToggleTree = () => {
    if (!showTree && onInspect && (!inspectionInfo || inspectionInfo.status === "idle")) {
      onInspect();
    }
    setShowTree((prev) => !prev);
  };

  return (
    <li className={`title-resources-item ${isInvalid ? "is-invalid" : ""}`}>
      <div className="title-resources-item-row">
        <div className="title-resources-item-main">
          <div className="title-resources-item-title-wrap">
            <span className="title-resources-item-title" title={candidate.title}>
              {candidate.title}
            </span>
            <ValidityBadge state={inspectionInfo} onInspect={onInspect} />
          </div>
          <CandidateMetaBar
            candidate={candidate}
            displaySize={displaySize}
            displayFileCount={displayFileCount}
          />
        </div>

        <CandidateActions
          onInspect={onInspect}
          showTree={showTree}
          onToggleTree={handleToggleTree}
          busy={busy}
          throttled={throttled}
          onToggleLink={onToggleLink}
          isLinkOpen={isLinkOpen}
          streaming={streaming}
          onImport={onImport}
          importable={importable}
          rowBusy={rowBusy}
          isInvalid={isInvalid}
        />
      </div>

      {showTree && (
        <div className="title-resources-tree-drawer">
          <ResourceFolderTree
            files={inspectionInfo?.files}
            totalSizeBytes={displaySize}
            fileCount={displayFileCount}
            loading={inspectionInfo?.loading}
            message={inspectionInfo?.message}
          />
        </div>
      )}

      <CandidateLinkDrawer info={linkInfo} copied={copied} onCopy={onCopyLink} />
    </li>
  );
}

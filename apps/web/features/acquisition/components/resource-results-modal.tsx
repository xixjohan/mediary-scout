"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Film, FolderSearch } from "lucide-react";
import type { ResourceCandidateView } from "@media-track/workflow";
import type {
  CandidateFacets,
  PaginatedResult,
  ResourceFilterCriteria,
} from "../contracts/resource-filter-model";
import { ResourceFilterBar } from "./resource-filter-bar";
import { ResourcePaginationBar } from "./resource-pagination-bar";
import {
  type CandidateLinkState,
  ResourceCandidateRow,
} from "./resource-candidate-row";
import type { ImportState } from "../contracts/acquisition-types";

export interface ResourceResultsModalProps {
  title?: string | undefined;
  year?: number | undefined;
  candidates: ResourceCandidateView[];
  paginatedResult: PaginatedResult<ResourceCandidateView>;
  facets: CandidateFacets;
  criteria: ResourceFilterCriteria;
  importState: ImportState;
  busy: boolean;
  throttled: boolean;
  submitting: boolean;
  linkStates: Record<string, CandidateLinkState>;
  copiedId: string | null;
  cached: boolean;
  snapshotId: string | null;
  onCriteriaChange: (updater: (prev: ResourceFilterCriteria) => ResourceFilterCriteria) => void;
  onResetCriteria: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onImportCandidate: (candidateId: string) => void;
  onToggleLink: (candidateId: string) => void;
  onCopyLink: (candidateId: string, text: string) => void;
  onClose: () => void;
}

export function ResourceResultsModal({
  title,
  year,
  candidates,
  paginatedResult,
  facets,
  criteria,
  importState,
  busy,
  throttled,
  submitting,
  linkStates,
  copiedId,
  cached,
  snapshotId,
  onCriteriaChange,
  onResetCriteria,
  onPageChange,
  onPageSizeChange,
  onImportCandidate,
  onToggleLink,
  onCopyLink,
  onClose,
}: ResourceResultsModalProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const importable = snapshotId !== null;

  return createPortal(
    <div
      className="resource-results-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="资源候选库专注视图"
    >
      <div
        className="resource-results-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 模态头部 */}
        <div className="resource-results-modal-header">
          <div className="resource-results-modal-title-group">
            <Film size={18} className="resource-results-modal-icon" aria-hidden />
            <h2>
              {title ? `${title} ${year ? `(${year})` : ""}` : "影视作品"} · 候选资源库
            </h2>
            <span className="resource-results-modal-badge">
              {candidates.length} 个结果{cached ? " · 缓存" : ""}
            </span>
          </div>
          <button
            type="button"
            className="resource-results-modal-close"
            onClick={onClose}
            aria-label="关闭弹窗"
            title="关闭弹窗 (Esc)"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        {/* 模态主体 */}
        <div className="resource-results-modal-body">
          {/* 筛选与排序工具栏 */}
          <ResourceFilterBar
            criteria={criteria}
            facets={facets}
            totalCandidates={candidates.length}
            filteredCount={paginatedResult.totalItems}
            isModal={true}
            onCriteriaChange={onCriteriaChange}
            onReset={onResetCriteria}
          />

          {/* 候选列表或空态 */}
          {paginatedResult.items.length === 0 ? (
            <div className="resource-results-filtered-empty">
              <FolderSearch size={32} className="resource-results-empty-icon" aria-hidden />
              <h4>未找到匹配的候选资源</h4>
              <p>当前筛选条件没有命中任何资源，请尝试清除过滤或更换关键字。</p>
              <button
                type="button"
                className="secondary-button"
                onClick={onResetCriteria}
              >
                清除所有过滤条件
              </button>
            </div>
          ) : (
            <ul className="title-resources-list">
              {paginatedResult.items.map((candidate) => {
                const rowBusy =
                  submitting &&
                  importState.kind === "submitting" &&
                  importState.candidateId === candidate.candidateId;

                return (
                  <ResourceCandidateRow
                    key={candidate.candidateId}
                    candidate={candidate}
                    importable={importable}
                    rowBusy={rowBusy}
                    busy={busy}
                    throttled={throttled}
                    streaming={false}
                    linkInfo={linkStates[candidate.candidateId]}
                    copied={copiedId === candidate.candidateId}
                    onImport={() => void onImportCandidate(candidate.candidateId)}
                    onToggleLink={() => void onToggleLink(candidate.candidateId)}
                    onCopyLink={(text) => void onCopyLink(candidate.candidateId, text)}
                  />
                );
              })}
            </ul>
          )}
        </div>

        {/* 模态底部：分页控制 */}
        <div className="resource-results-modal-footer">
          <ResourcePaginationBar
            pagination={paginatedResult}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

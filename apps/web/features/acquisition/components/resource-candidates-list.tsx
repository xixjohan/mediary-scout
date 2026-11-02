"use client";

import { FolderSearch } from "lucide-react";
import type { ResourceCandidateView } from "@media-track/workflow";
import {
  type CandidateLinkState,
  ResourceCandidateRow,
} from "./resource-candidate-row";
import { ResourceEmptyDiagnostic } from "./resource-empty-diagnostic";
import {
  type CandidateFacets,
  type PaginatedResult,
  type ResourceFilterCriteria,
} from "../contracts/resource-filter-model";
import { ResourceFilterBar } from "./resource-filter-bar";
import { ResourcePaginationBar } from "./resource-pagination-bar";
import { ResourceResultsModal } from "./resource-results-modal";
import type {
  CandidateInspectionState,
  ImportState,
  PanelState,
} from "../contracts/acquisition-types";

export interface CandidatesListProps {
  state: Extract<PanelState, { kind: "ready" | "streaming" }>;
  criteria: ResourceFilterCriteria;
  facets: CandidateFacets;
  paginatedResult: PaginatedResult<ResourceCandidateView>;
  isModalOpen: boolean;
  importState: ImportState;
  busy: boolean;
  throttled: boolean;
  submitting: boolean;
  linkStates: Record<string, CandidateLinkState>;
  inspectionStates: Record<string, CandidateInspectionState>;
  copiedId: string | null;
  releaseDate?: string | null | undefined;
  baseTitle?: string | undefined;
  year?: number | undefined;
  customKeyword?: string | undefined;
  onResetKeyword?: (() => void) | undefined;
  onCriteriaChange: (updater: (prev: ResourceFilterCriteria) => ResourceFilterCriteria) => void;
  onResetCriteria: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onOpenModal: () => void;
  onCloseModal: () => void;
  onImportCandidate: (candidateId: string) => void;
  onToggleLink: (candidateId: string) => void;
  onCopyLink: (candidateId: string, text: string) => void;
  onInspectCandidate: (candidateId: string) => void;
}

export function ResourceCandidatesList({
  state,
  criteria,
  facets,
  paginatedResult,
  isModalOpen,
  importState,
  busy,
  throttled,
  submitting,
  linkStates,
  inspectionStates,
  copiedId,
  releaseDate,
  baseTitle,
  year,
  customKeyword,
  onResetKeyword,
  onCriteriaChange,
  onResetCriteria,
  onPageChange,
  onPageSizeChange,
  onOpenModal,
  onCloseModal,
  onImportCandidate,
  onToggleLink,
  onCopyLink,
  onInspectCandidate,
}: CandidatesListProps) {
  if (state.candidates.length === 0) {
    return (
      <ResourceEmptyDiagnostic
        state={state}
        releaseDate={releaseDate}
        baseTitle={baseTitle}
        customKeyword={customKeyword}
        onResetKeyword={onResetKeyword}
      />
    );
  }

  const importable = state.kind === "ready" && state.snapshotId !== null;

  return (
    <>
      <div className="title-resources-summary">
        <span>{state.candidates.length} 个候选</span>
        {state.kind === "streaming" ? (
          <span className="title-resources-cached">
            正在并发检索（{state.progress.done}/{state.progress.total}
            {state.progress.currentKeyword ? `·${state.progress.currentKeyword}` : ""}）…
          </span>
        ) : state.cached ? (
          <span className="title-resources-cached">30 分钟内的缓存结果</span>
        ) : null}
      </div>

      <ResourceFilterBar
        criteria={criteria}
        facets={facets}
        totalCandidates={state.candidates.length}
        filteredCount={paginatedResult.totalItems}
        isModal={false}
        onCriteriaChange={onCriteriaChange}
        onReset={onResetCriteria}
        onOpenModal={onOpenModal}
      />

      {paginatedResult.items.length === 0 ? (
        <div className="resource-results-filtered-empty">
          <FolderSearch size={28} className="resource-results-empty-icon" aria-hidden />
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
              submitting && importState.kind === "submitting" && importState.candidateId === candidate.candidateId;
            return (
              <ResourceCandidateRow
                key={candidate.candidateId}
                candidate={candidate}
                importable={importable}
                rowBusy={rowBusy}
                busy={busy}
                throttled={throttled}
                streaming={state.kind === "streaming"}
                linkInfo={linkStates[candidate.candidateId]}
                inspectionInfo={inspectionStates[candidate.candidateId]}
                copied={copiedId === candidate.candidateId}
                onImport={() => void onImportCandidate(candidate.candidateId)}
                onToggleLink={() => void onToggleLink(candidate.candidateId)}
                onCopyLink={(text) => void onCopyLink(candidate.candidateId, text)}
                onInspect={() => void onInspectCandidate(candidate.candidateId)}
              />
            );
          })}
        </ul>
      )}

      <ResourcePaginationBar
        pagination={paginatedResult}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />

      {isModalOpen ? (
        <ResourceResultsModal
          title={baseTitle}
          year={year}
          candidates={state.candidates}
          paginatedResult={paginatedResult}
          facets={facets}
          criteria={criteria}
          importState={importState}
          busy={busy}
          throttled={throttled}
          submitting={submitting}
          linkStates={linkStates}
          inspectionStates={inspectionStates}
          copiedId={copiedId}
          cached={state.kind === "ready" ? state.cached : false}
          snapshotId={state.kind === "ready" ? state.snapshotId : null}
          onCriteriaChange={onCriteriaChange}
          onResetCriteria={onResetCriteria}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          onImportCandidate={onImportCandidate}
          onToggleLink={onToggleLink}
          onCopyLink={onCopyLink}
          onInspectCandidate={onInspectCandidate}
          onClose={onCloseModal}
        />
      ) : null}

      {importState.kind === "queued" && (
        <p className="title-resources-import-queued">已加入队列，正在转存到网盘。可以离开这个页面。</p>
      )}
      {importState.kind === "already_running" && (
        <p className="title-resources-import-queued">这部片已有导入在进行中。</p>
      )}
      {importState.kind === "rejected" && (
        <p className="title-resources-error">入库失败：{importState.message}</p>
      )}
    </>
  );
}

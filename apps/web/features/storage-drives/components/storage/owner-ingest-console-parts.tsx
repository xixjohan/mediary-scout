import { Download, FolderSearch, LoaderCircle, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import type { ConnectedStorageView } from "../../../../lib/workflow-runtime";
import type { ResourceCandidateView, ResourceValidityStatus } from "@media-track/workflow";
import { ResourceFilterBar } from "../../../acquisition/components/resource-filter-bar";
import { ResourcePaginationBar } from "../../../acquisition/components/resource-pagination-bar";
import {
  type CandidateFacets,
  type PaginatedResult,
  type ResourceFilterCriteria,
} from "../../../acquisition/contracts/resource-filter-model";
import { formatSize, resourceTypeLabel } from "../../../acquisition/core/resource-formatters";
import type { SearchBackendView } from "../../../storage-drives/application/owner-ingest-service";

/**
 * 「关键字投放」控制台的纯展示子组件与共享状态类型。
 *
 * 与 `owner-ingest-console.tsx` 拆开的原因只有一个：控制台的 effect/请求编排
 * 与这几块行渲染没有耦合，混在一个文件里会超出单文件行数门禁（600 行）。
 * 这里**不持有任何请求逻辑**——所有判定与轮询仍留在控制台本体。
 */

export type InspectionStatus = ResourceValidityStatus;

export const INSPECTION_LABEL: Record<InspectionStatus, string> = {
  idle: "未校验",
  probing: "校验中…",
  valid: "有效",
  invalid: "已失效",
  password_required: "需提取码",
  rate_limited: "限流稍后再试",
  unknown: "未校验",
};

/** 候选的行内校验态：loading 是 UI 自己的中间态，其余直接来自服务端结论。 */
export interface InspectionState {
  status: InspectionStatus;
  loading: boolean;
  message?: string | undefined;
  fileCount?: number | undefined;
}

export type SubmissionPhase = "queued" | "running" | "succeeded" | "failed" | "rejected" | "already_running";

export interface SubmissionState {
  candidateId: string;
  candidateTitle: string;
  workflowRunId?: string | undefined;
  phase: SubmissionPhase;
  message?: string | undefined;
  landedFileCount?: number | null | undefined;
}

export const PHASE_LABEL: Record<SubmissionPhase, string> = {
  queued: "排队中",
  running: "转存中",
  succeeded: "已落盘",
  failed: "失败",
  rejected: "已过期",
  already_running: "重复提交",
};

export function phaseClass(phase: SubmissionPhase): string {
  if (phase === "succeeded") return "is-success";
  if (phase === "failed" || phase === "rejected") return "is-error";
  if (phase === "already_running") return "is-muted";
  return "is-pending";
}

export function mapRunStatusToPhase(status: string): SubmissionPhase {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "queued";
}

export function StatusBanner({ text }: { text: string }) {
  return (
    <div className="storage-offline-status-banner is-error">
      <span>{text}</span>
    </div>
  );
}

export function SearchRow({
  storages,
  storageId,
  onStorageChange,
  keyword,
  onKeywordChange,
  searching,
  onSearch,
}: {
  storages: ConnectedStorageView[];
  storageId: string;
  onStorageChange: (id: string) => void;
  keyword: string;
  onKeywordChange: (value: string) => void;
  searching: boolean;
  onSearch: () => void;
}) {
  return (
    <div className="owner-ingest-search-row">
      <select
        className="storage-offline-select"
        value={storageId}
        onChange={(event) => onStorageChange(event.target.value)}
        aria-label="目标网盘"
      >
        {storages.map((storage) => (
          <option key={storage.id} value={storage.id}>
            {storage.label ?? storage.provider}
            {storage.status === "frozen" ? "（授权失效）" : ""}
          </option>
        ))}
      </select>
      <input
        className="storage-offline-input"
        type="text"
        placeholder="输入关键字，例如：某剧名 4K"
        value={keyword}
        onChange={(event) => onKeywordChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSearch();
        }}
        maxLength={64}
      />
      <button type="button" className="storage-btn primary" onClick={onSearch} disabled={searching}>
        {searching ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}
        <span>{searching ? "检索中…" : "检索"}</span>
      </button>
    </div>
  );
}

export function BackendPicker({
  views,
  selected,
  onToggle,
}: {
  views: SearchBackendView[];
  selected: Set<string>;
  onToggle: (backend: string) => void;
}) {
  if (views.length <= 1) return null;
  return (
    <div className="owner-ingest-backend-row">
      <span className="panel-note">检索后端：</span>
      {views.map((view) => {
        const active = selected.size === 0 || selected.has(view.backend);
        return (
          <button
            key={view.backend}
            type="button"
            className={`resource-filter-chip ${active ? "is-active" : ""}`}
            disabled={!view.configured}
            title={view.configured ? `只用 ${view.label} 检索` : `${view.label} 尚未配置（去设置页填写）`}
            onClick={() => onToggle(view.backend)}
          >
            <span>{view.label}</span>
            {!view.configured && <span className="resource-filter-chip-count">未配置</span>}
          </button>
        );
      })}
      <span className="panel-note">{selected.size === 0 ? "（全部已配置后端）" : ""}</span>
    </div>
  );
}

function InspectionBadge({ state }: { state: InspectionState | undefined }) {
  if (state === undefined) return null;
  if (state.loading) {
    return (
      <span className="resource-validity-badge probing" title="正在校验分享是否有效">
        <LoaderCircle size={12} className="spin" aria-hidden />
        <span>{INSPECTION_LABEL.probing}</span>
      </span>
    );
  }
  const tone =
    state.status === "valid"
      ? "valid"
      : state.status === "invalid" || state.status === "password_required"
        ? "invalid"
        : "idle";
  return (
    <span className={`resource-validity-badge ${tone}`} title={state.message ?? INSPECTION_LABEL[state.status]}>
      {tone === "valid" ? <ShieldCheck size={12} aria-hidden /> : null}
      <span>{INSPECTION_LABEL[state.status]}</span>
    </span>
  );
}

export function CandidateList({
  candidates,
  filteredItems,
  filteredTotal,
  selectedIds,
  onToggle,
  criteria,
  onCriteriaChange,
  facets,
  inspections,
  onInspect,
  pagination,
  onPageChange,
  onPageSizeChange,
  onResetCriteria,
}: {
  candidates: ResourceCandidateView[];
  filteredItems: ResourceCandidateView[];
  /** 筛选后的总数（不是当前页条数）。 */
  filteredTotal: number;
  selectedIds: Set<string>;
  onToggle: (candidateId: string) => void;
  criteria: ResourceFilterCriteria;
  onCriteriaChange: (updater: (prev: ResourceFilterCriteria) => ResourceFilterCriteria) => void;
  facets: CandidateFacets;
  inspections: Record<string, InspectionState | undefined>;
  onInspect: () => void;
  pagination: PaginatedResult<ResourceCandidateView>;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onResetCriteria: () => void;
}) {
  return (
    <div className="owner-ingest-candidates">
      {/* 类型/清晰度/规格/体积分面 + 关键词即时过滤 + 排序：与资源面板同一份契约。 */}
      <ResourceFilterBar
        criteria={criteria}
        facets={facets}
        totalCandidates={candidates.length}
        filteredCount={filteredTotal}
        onCriteriaChange={onCriteriaChange}
        onReset={onResetCriteria}
      />

      <div className="owner-ingest-filter-row">
        <span className="panel-note">
          {/* 「匹配」必须是筛选后的总数，不是当前页条数——否则每页 20 条时
              永远显示「匹配 20」，用户以为筛选没生效。 */}
          共 {candidates.length} 条 · 匹配 {filteredTotal} 条 · 已选 {selectedIds.size} 条
        </span>
        <button
          type="button"
          className="storage-btn secondary"
          disabled={selectedIds.size === 0}
          onClick={onInspect}
        >
          <ShieldCheck size={14} />
          <span>校验已选链接</span>
        </button>
      </div>

      <div className="owner-ingest-candidate-list">
        {filteredItems.map((candidate) => {
          const checked = selectedIds.has(candidate.candidateId);
          const inspection = inspections[candidate.candidateId];
          return (
            <label key={candidate.candidateId} className={`owner-ingest-candidate ${checked ? "is-checked" : ""}`}>
              <input type="checkbox" checked={checked} onChange={() => onToggle(candidate.candidateId)} />
              <div className="owner-ingest-candidate-body">
                <span className="owner-ingest-candidate-title" title={candidate.title}>
                  {candidate.title}
                </span>
                <span className="owner-ingest-candidate-meta">
                  <span className="resource-type-chip">{resourceTypeLabel(candidate.type)}</span>
                  {candidate.sizeBytes !== undefined && <span>· {formatSize(candidate.sizeBytes)}</span>}
                  {candidate.seeders !== undefined && <span>· {candidate.seeders} 做种</span>}
                  {candidate.postedAt !== undefined && <span>· {candidate.postedAt.slice(0, 10)}</span>}
                  <InspectionBadge state={inspection} />
                </span>
              </div>
            </label>
          );
        })}
      </div>

      <ResourcePaginationBar
        pagination={pagination}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    </div>
  );
}

export function TargetRow({ targetPath, onOpenPicker }: { targetPath: string; onOpenPicker: () => void }) {
  return (
    <div className="owner-ingest-target-row">
      <span className="panel-note">入库目录：</span>
      <span className="owner-ingest-target-path" title={targetPath}>
        {targetPath || "尚未选择"}
      </span>
      <button type="button" className="storage-btn secondary" onClick={onOpenPicker}>
        <FolderSearch size={14} />
        <span>浏览网盘目录</span>
      </button>
    </div>
  );
}

export function SubmitRow({
  submitting,
  selectedCount,
  canSubmit,
  onSubmit,
}: {
  submitting: boolean;
  selectedCount: number;
  canSubmit: boolean;
  onSubmit: () => void;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
      <button
        type="button"
        className="storage-btn primary"
        onClick={onSubmit}
        disabled={submitting || selectedCount === 0 || !canSubmit}
      >
        {submitting ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}
        <span>{submitting ? "提交中…" : `投放 ${selectedCount} 条`}</span>
      </button>
    </div>
  );
}

export function SubmissionsPanel({ submissions }: { submissions: SubmissionState[] }) {
  const hasPending = submissions.some((entry) => entry.phase === "queued" || entry.phase === "running");
  return (
    <div className="owner-ingest-submissions">
      <div className="owner-ingest-filter-row">
        <span className="panel-note">投放进度（落盘后才算入库）</span>
        <RefreshCw size={13} className={hasPending ? "spin" : ""} />
      </div>
      {submissions.map((entry) => (
        <div
          key={`${entry.candidateId}_${entry.workflowRunId ?? ""}`}
          className={`owner-ingest-submission ${phaseClass(entry.phase)}`}
        >
          <span className="owner-ingest-submission-title" title={entry.candidateTitle}>
            {entry.candidateTitle}
          </span>
          <span className={`owner-ingest-phase ${phaseClass(entry.phase)}`}>
            {PHASE_LABEL[entry.phase]}
            {entry.phase === "succeeded" && entry.landedFileCount != null ? ` · ${entry.landedFileCount} 个文件` : ""}
          </span>
          {entry.message !== undefined && <span className="owner-ingest-submission-msg">{entry.message}</span>}
          {entry.phase === "failed" || entry.phase === "rejected" ? (
            <X size={13} className="owner-ingest-submission-icon" />
          ) : null}
        </div>
      ))}
    </div>
  );
}

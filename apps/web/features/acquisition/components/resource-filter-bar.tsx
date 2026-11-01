"use client";

import { Search, X, RotateCcw, Maximize2, ArrowUpDown } from "lucide-react";
import type { ResourceType } from "@media-track/workflow";
import type {
  CandidateFacets,
  ResolutionTag,
  ResourceFilterCriteria,
  SortOption,
  SpecTag,
} from "../contracts/resource-filter-model";

export interface ResourceFilterBarProps {
  criteria: ResourceFilterCriteria;
  facets: CandidateFacets;
  totalCandidates: number;
  filteredCount: number;
  isModal?: boolean | undefined;
  onCriteriaChange: (updater: (prev: ResourceFilterCriteria) => ResourceFilterCriteria) => void;
  onReset: () => void;
  onOpenModal?: (() => void) | undefined;
}

export function ResourceFilterBar({
  criteria,
  facets,
  totalCandidates,
  filteredCount,
  isModal = false,
  onCriteriaChange,
  onReset,
  onOpenModal,
}: ResourceFilterBarProps) {
  const isFiltered =
    criteria.keyword.trim().length > 0 ||
    criteria.type !== "all" ||
    criteria.resolution !== "all" ||
    criteria.spec !== "all" ||
    criteria.sortBy !== "default";

  return (
    <div className="resource-filter-container">
      {/* 顶层行：即时关键词输入 + 排序下拉 + 弹窗/重置操作 */}
      <div className="resource-filter-top-row">
        <div className="resource-filter-search-box">
          <Search size={14} className="resource-filter-search-icon" aria-hidden />
          <input
            type="text"
            className="resource-filter-search-input"
            placeholder="在已检索结果中即时过滤（如 4K、REMUX、国英双语）…"
            value={criteria.keyword}
            onChange={(e) => {
              const val = e.target.value;
              onCriteriaChange((prev) => ({ ...prev, keyword: val }));
            }}
          />
          {criteria.keyword ? (
            <button
              type="button"
              className="resource-filter-clear-btn"
              onClick={() => onCriteriaChange((prev) => ({ ...prev, keyword: "" }))}
              aria-label="清空关键词"
            >
              <X size={13} aria-hidden />
            </button>
          ) : null}
        </div>

        <div className="resource-filter-controls">
          <div className="resource-filter-sort-wrapper">
            <ArrowUpDown size={13} aria-hidden className="resource-filter-sort-icon" />
            <select
              className="resource-filter-sort-select"
              value={criteria.sortBy}
              onChange={(e) => {
                const sortBy = e.target.value as SortOption;
                onCriteriaChange((prev) => ({ ...prev, sortBy }));
              }}
              aria-label="结果排序"
            >
              <option value="default">默认推荐排序</option>
              <option value="size_desc">体积从大到小 (高码优先)</option>
              <option value="size_asc">体积从小到大 (省空间)</option>
              <option value="date_desc">发布时间最新</option>
              <option value="seeders_desc">做种数最多 (BT下载)</option>
            </select>
          </div>

          {isFiltered ? (
            <button
              type="button"
              className="resource-filter-reset-action"
              onClick={onReset}
              title="清除所有过滤条件"
            >
              <RotateCcw size={12} aria-hidden />
              重置
            </button>
          ) : null}

          {!isModal && onOpenModal ? (
            <button
              type="button"
              className="resource-filter-modal-trigger"
              onClick={onOpenModal}
              title="弹窗全屏专注查看结果与链接"
            >
              <Maximize2 size={13} aria-hidden />
              弹窗查看
            </button>
          ) : null}
        </div>
      </div>

      {/* 分面标签栏 1：网盘与协议类型 */}
      <div className="resource-filter-chips-row">
        <span className="resource-filter-facet-label">渠道类型:</span>
        <div className="resource-filter-chips-group">
          {facets.types.map((facet) => {
            const active = criteria.type === facet.value;
            if (facet.count === 0 && facet.value !== "all") return null;
            return (
              <button
                type="button"
                key={String(facet.value)}
                className={`resource-filter-chip ${active ? "is-active" : ""}`}
                onClick={() =>
                  onCriteriaChange((prev) => ({
                    ...prev,
                    type: prev.type === facet.value && facet.value !== "all" ? "all" : (facet.value as ResourceType | "all"),
                  }))
                }
              >
                <span>{facet.label}</span>
                <span className="resource-filter-chip-count">{facet.count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 分面标签栏 2：清晰度与制作规格 */}
      <div className="resource-filter-chips-row">
        <span className="resource-filter-facet-label">清晰规格:</span>
        <div className="resource-filter-chips-group">
          {/* 画质档位 */}
          {facets.resolutions.map((facet) => {
            const active = criteria.resolution === facet.value;
            if (facet.count === 0 && facet.value !== "all") return null;
            return (
              <button
                type="button"
                key={facet.value}
                className={`resource-filter-chip tone-resolution ${active ? "is-active" : ""}`}
                onClick={() =>
                  onCriteriaChange((prev) => ({
                    ...prev,
                    resolution: prev.resolution === facet.value && facet.value !== "all" ? "all" : (facet.value as ResolutionTag),
                  }))
                }
              >
                <span>{facet.label}</span>
                <span className="resource-filter-chip-count">{facet.count}</span>
              </button>
            );
          })}

          <span className="resource-filter-chips-divider" aria-hidden />

          {/* 制作规格 */}
          {facets.specs.map((facet) => {
            const active = criteria.spec === facet.value;
            if (facet.count === 0 && facet.value !== "all") return null;
            return (
              <button
                type="button"
                key={facet.value}
                className={`resource-filter-chip tone-spec ${active ? "is-active" : ""}`}
                onClick={() =>
                  onCriteriaChange((prev) => ({
                    ...prev,
                    spec: prev.spec === facet.value && facet.value !== "all" ? "all" : (facet.value as SpecTag),
                  }))
                }
              >
                <span>{facet.label}</span>
                <span className="resource-filter-chip-count">{facet.count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 结果计数提示 */}
      <div className="resource-filter-stat-line">
        <span>
          共 <strong>{totalCandidates}</strong> 个候选
          {isFiltered ? (
            <>
              ，筛选命中 <strong>{filteredCount}</strong> 个
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

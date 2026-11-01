"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import type { PaginatedResult } from "../contracts/resource-filter-model";

export interface ResourcePaginationBarProps {
  pagination: PaginatedResult<unknown>;
  pageSizeOptions?: readonly number[] | undefined;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

/**
 * 智能计算可见页码列表（带省略号）
 */
function computePageRange(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages: Array<number | "ellipsis"> = [1];

  if (current > 3) {
    pages.push("ellipsis");
  }

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (current < total - 2) {
    pages.push("ellipsis");
  }

  pages.push(total);
  return pages;
}

export function ResourcePaginationBar({
  pagination,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  onPageChange,
  onPageSizeChange,
}: ResourcePaginationBarProps) {
  const { totalItems, currentPage, totalPages, pageSize, hasPrev, hasNext, startIndex, endIndex } =
    pagination;

  if (totalItems <= 0) return null;

  const pageRange = computePageRange(currentPage, totalPages);

  return (
    <div className="resource-pagination-container">
      {/* 计数指示 */}
      <div className="resource-pagination-info">
        显示第 <strong>{startIndex}</strong> - <strong>{endIndex}</strong> 项，共 <strong>{totalItems}</strong> 项
      </div>

      {/* 控制器 */}
      <div className="resource-pagination-controls">
        {/* 每页容量选择 */}
        <div className="resource-pagination-size-select">
          <span>每页</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            aria-label="每页显示条数"
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size} 条
              </option>
            ))}
          </select>
        </div>

        {/* 翻页按钮组 */}
        <div className="resource-pagination-buttons">
          <button
            type="button"
            className="resource-pagination-nav-btn"
            disabled={!hasPrev}
            onClick={() => onPageChange(1)}
            title="第一页"
            aria-label="第一页"
          >
            <ChevronsLeft size={14} aria-hidden />
          </button>
          <button
            type="button"
            className="resource-pagination-nav-btn"
            disabled={!hasPrev}
            onClick={() => onPageChange(currentPage - 1)}
            title="上一页"
            aria-label="上一页"
          >
            <ChevronLeft size={14} aria-hidden />
          </button>

          {pageRange.map((item, idx) => {
            if (item === "ellipsis") {
              return (
                <span key={`ellipsis-${idx}`} className="resource-pagination-ellipsis">
                  …
                </span>
              );
            }
            const isActive = item === currentPage;
            return (
              <button
                type="button"
                key={item}
                className={`resource-pagination-page-btn ${isActive ? "is-active" : ""}`}
                onClick={() => onPageChange(item)}
                aria-current={isActive ? "page" : undefined}
              >
                {item}
              </button>
            );
          })}

          <button
            type="button"
            className="resource-pagination-nav-btn"
            disabled={!hasNext}
            onClick={() => onPageChange(currentPage + 1)}
            title="下一页"
            aria-label="下一页"
          >
            <ChevronRight size={14} aria-hidden />
          </button>
          <button
            type="button"
            className="resource-pagination-nav-btn"
            disabled={!hasNext}
            onClick={() => onPageChange(totalPages)}
            title="最后一页"
            aria-label="最后一页"
          >
            <ChevronsRight size={14} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

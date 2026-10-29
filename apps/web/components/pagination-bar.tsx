import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const DEFAULT_PAGE_SIZE = 30;
export const DEFAULT_PAGE_SIZE_OPTIONS = [20, 30, 50] as const;

export interface PaginationBarProps {
  currentPage: number;
  totalPages: number;
  totalResults?: number | undefined;
  pageSize?: number | undefined;
  pageSizeOptions?: readonly number[] | undefined;
  basePath: string;
  queryParams?: Record<string, string | undefined> | undefined;
}

function buildPageHref(
  basePath: string,
  queryParams: Record<string, string | undefined> | undefined,
  targetPage: number,
  pageSize?: number | undefined,
): string {
  const params = new URLSearchParams();
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      if (v && k !== "page") {
        params.set(k, v);
      }
    }
  }
  if (pageSize && pageSize !== DEFAULT_PAGE_SIZE) {
    params.set("pageSize", String(pageSize));
  }
  if (targetPage > 1) {
    params.set("page", String(targetPage));
  }
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

function buildPageSizeHref(
  basePath: string,
  queryParams: Record<string, string | undefined> | undefined,
  targetSize: number,
): string {
  const params = new URLSearchParams();
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      if (v && k !== "page" && k !== "pageSize") {
        params.set(k, v);
      }
    }
  }
  if (targetSize !== DEFAULT_PAGE_SIZE) {
    params.set("pageSize", String(targetSize));
  }
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

function computePageNumbers(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages: (number | "ellipsis")[] = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(total - 1, current + 1);

  if (left > 2) {
    pages.push("ellipsis");
  }

  for (let p = left; p <= right; p++) {
    pages.push(p);
  }

  if (right < total - 1) {
    pages.push("ellipsis");
  }

  pages.push(total);
  return pages;
}

function PaginationPageNumbers({
  pageNumbers,
  currentPage,
  pageSize,
  basePath,
  queryParams,
}: {
  pageNumbers: (number | "ellipsis")[];
  currentPage: number;
  pageSize: number;
  basePath: string;
  queryParams?: Record<string, string | undefined> | undefined;
}) {
  return (
    <div className="pagination-pages">
      {pageNumbers.map((p, idx) => {
        if (p === "ellipsis") {
          return (
            <span key={`ellipsis_${idx}`} className="pagination-ellipsis" aria-hidden="true">
              …
            </span>
          );
        }

        const isActive = p === currentPage;
        return isActive ? (
          <span key={p} className="pagination-page-btn active" aria-current="page">
            {p}
          </span>
        ) : (
          <Link
            key={p}
            className="pagination-page-btn"
            href={buildPageHref(basePath, queryParams, p, pageSize)}
            aria-label={`第 ${p} 页`}
          >
            {p}
          </Link>
        );
      })}
    </div>
  );
}

function PaginationSizeSwitcher({
  activeSize,
  options,
  basePath,
  queryParams,
}: {
  activeSize: number;
  options: readonly number[];
  basePath: string;
  queryParams?: Record<string, string | undefined> | undefined;
}) {
  return (
    <div className="pagination-size-switcher" role="group" aria-label="切换每页显示数量">
      <span className="pagination-size-label">每页</span>
      <div className="pagination-size-pills">
        {options.map((opt) => {
          const isCurrent = opt === activeSize;
          return isCurrent ? (
            <span key={opt} className="pagination-size-pill active" aria-current="true">
              {opt}部
            </span>
          ) : (
            <Link
              key={opt}
              className="pagination-size-pill"
              href={buildPageSizeHref(basePath, queryParams, opt)}
              aria-label={`切换为每页 ${opt} 部`}
              scroll={false}
            >
              {opt}部
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function PaginationBar({
  currentPage,
  totalPages,
  totalResults,
  pageSize,
  pageSizeOptions,
  basePath,
  queryParams,
}: PaginationBarProps) {
  const activePageSize = pageSize ?? DEFAULT_PAGE_SIZE;
  const options = pageSizeOptions ?? DEFAULT_PAGE_SIZE_OPTIONS;

  if (totalPages <= 1 && (!totalResults || totalResults <= 20) && activePageSize === DEFAULT_PAGE_SIZE) {
    return null;
  }

  const pageNumbers = computePageNumbers(currentPage, totalPages);
  const prevDisabled = currentPage <= 1;
  const nextDisabled = currentPage >= totalPages;

  return (
    <nav className="pagination-bar" aria-label="分页导航">
      <div className="pagination-info">
        <span>
          第 <strong>{currentPage}</strong> / <strong>{totalPages}</strong> 页
          {totalResults !== undefined ? `（约 ${totalResults} 条）` : ""}
        </span>
      </div>

      <div className="pagination-controls">
        {prevDisabled ? (
          <span className="pagination-btn disabled" aria-disabled="true">
            <ChevronLeft size={16} aria-hidden /> 上一页
          </span>
        ) : (
          <Link
            className="pagination-btn"
            href={buildPageHref(basePath, queryParams, currentPage - 1, activePageSize)}
            aria-label="前往上一页"
          >
            <ChevronLeft size={16} aria-hidden /> 上一页
          </Link>
        )}

        <PaginationPageNumbers
          pageNumbers={pageNumbers}
          currentPage={currentPage}
          pageSize={activePageSize}
          basePath={basePath}
          queryParams={queryParams}
        />

        {nextDisabled ? (
          <span className="pagination-btn disabled" aria-disabled="true">
            下一页 <ChevronRight size={16} aria-hidden />
          </span>
        ) : (
          <Link
            className="pagination-btn"
            href={buildPageHref(basePath, queryParams, currentPage + 1, activePageSize)}
            aria-label="前往下一页"
          >
            下一页 <ChevronRight size={16} aria-hidden />
          </Link>
        )}
      </div>

      <PaginationSizeSwitcher
        activeSize={activePageSize}
        options={options}
        basePath={basePath}
        queryParams={queryParams}
      />
    </nav>
  );
}

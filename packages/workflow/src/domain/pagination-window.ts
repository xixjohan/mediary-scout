/**
 * 分页计算与滑动窗口切片模型（Windowed Pagination Adapter）
 * 用于将自定义的 (page, pageSize) 映射为上游固定分页（如 TMDB 20条/页）的并发请求范围与精准切片
 */

export const DEFAULT_PAGE_SIZE = 30;
export const SUPPORTED_PAGE_SIZES = [20, 30, 50] as const;
export type SupportedPageSize = (typeof SUPPORTED_PAGE_SIZES)[number];

export function normalizePageSize(size?: number | string | null | undefined): number {
  if (size === undefined || size === null) return DEFAULT_PAGE_SIZE;
  const num = typeof size === "number" ? size : parseInt(String(size), 10);
  if (!Number.isFinite(num)) return DEFAULT_PAGE_SIZE;
  if (SUPPORTED_PAGE_SIZES.includes(num as SupportedPageSize)) {
    return num;
  }
  return DEFAULT_PAGE_SIZE;
}

export interface PageWindowCalculation {
  startPage: number;
  endPage: number;
  sliceStart: number;
  sliceEnd: number;
}

/**
 * 窗口分页算法（Pure Function）
 * 将请求的当前页码与每页容量 (page, pageSize) 映射为上游物理分页的起止页码及在拉取数据块中的裁剪区间
 */
export function calculatePageWindow(
  page: number,
  pageSize: number,
  upstreamPageSize = 20,
): PageWindowCalculation {
  const p = Math.max(1, page);
  const size = Math.max(1, pageSize);
  const upstream = Math.max(1, upstreamPageSize);

  const globalStart = (p - 1) * size;
  const globalEnd = p * size;

  const startPage = Math.floor(globalStart / upstream) + 1;
  const endPage = Math.floor((globalEnd - 1) / upstream) + 1;

  const windowBaseOffset = (startPage - 1) * upstream;
  const sliceStart = globalStart - windowBaseOffset;
  const sliceEnd = sliceStart + size;

  return { startPage, endPage, sliceStart, sliceEnd };
}

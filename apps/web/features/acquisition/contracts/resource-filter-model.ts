import type { ResourceCandidateView, ResourceType } from "@media-track/workflow";
import { resourceTypeLabel } from "../components/resource-candidate-row";

export type ResolutionTag = "all" | "4k" | "1080p" | "720p";
export type SpecTag = "all" | "remux" | "bluray" | "web-dl" | "hdr_dv";
export type SortOption = "default" | "size_desc" | "size_asc" | "date_desc" | "seeders_desc";

export interface ResourceFilterCriteria {
  keyword: string;
  type: ResourceType | "all";
  resolution: ResolutionTag;
  spec: SpecTag;
  sortBy: SortOption;
}

export const DEFAULT_FILTER_CRITERIA: ResourceFilterCriteria = {
  keyword: "",
  type: "all",
  resolution: "all",
  spec: "all",
  sortBy: "default",
};

export interface CandidateFacetItem<T = string> {
  value: T;
  label: string;
  count: number;
}

export interface CandidateFacets {
  types: Array<CandidateFacetItem<ResourceType | "all">>;
  resolutions: Array<CandidateFacetItem<ResolutionTag>>;
  specs: Array<CandidateFacetItem<SpecTag>>;
}

export interface PaginatedResult<T> {
  items: T[];
  totalItems: number;
  currentPage: number;
  totalPages: number;
  pageSize: number;
  hasPrev: boolean;
  hasNext: boolean;
  startIndex: number;
  endIndex: number;
}

/**
 * 从资源标题中提取分辨率档位
 */
export function extractResolution(title: string): "4k" | "1080p" | "720p" | undefined {
  if (/(?:4k|2160p|uhd)/i.test(title)) return "4k";
  if (/(?:1080p|1080i|fhd)/i.test(title)) return "1080p";
  if (/(?:720p|hd(?![a-z0-9]))/i.test(title)) return "720p";
  return undefined;
}

/**
 * 校验标题是否匹配特定制作规格
 */
export function matchesSpec(title: string, spec: Exclude<SpecTag, "all">): boolean {
  switch (spec) {
    case "remux":
      return /\bremux\b/i.test(title);
    case "bluray":
      return /(?:bluray|blu-ray|bdmv|\biso\b|原盘|蓝光)/i.test(title);
    case "web-dl":
      return /(?:web-?dl|webrip)/i.test(title);
    case "hdr_dv":
      return /(?:hdr10\+|hdr10|hdr|dolby\s*vision|dovi|\bdv\b)/i.test(title);
  }
}

/**
 * 提取全部分面标签及其统计数量
 */
export function extractFacets(candidates: readonly ResourceCandidateView[]): CandidateFacets {
  const total = candidates.length;

  // 1. 类型统计
  const typeCounts = new Map<ResourceType, number>();
  for (const c of candidates) {
    typeCounts.set(c.type, (typeCounts.get(c.type) ?? 0) + 1);
  }

  const types: Array<CandidateFacetItem<ResourceType | "all">> = [
    { value: "all", label: "全部类型", count: total },
  ];
  for (const [type, count] of typeCounts.entries()) {
    types.push({
      value: type,
      label: resourceTypeLabel(type),
      count,
    });
  }

  // 2. 分辨率统计
  let count4k = 0;
  let count1080p = 0;
  let count720p = 0;
  for (const c of candidates) {
    const res = extractResolution(c.title);
    if (res === "4k") count4k++;
    else if (res === "1080p") count1080p++;
    else if (res === "720p") count720p++;
  }

  const resolutions: Array<CandidateFacetItem<ResolutionTag>> = [
    { value: "all", label: "全部分辨率", count: total },
    { value: "4k", label: "4K / 2160p", count: count4k },
    { value: "1080p", label: "1080p", count: count1080p },
    { value: "720p", label: "720p", count: count720p },
  ];

  // 3. 规格统计
  let countRemux = 0;
  let countBluray = 0;
  let countWebDl = 0;
  let countHdr = 0;
  for (const c of candidates) {
    if (matchesSpec(c.title, "remux")) countRemux++;
    if (matchesSpec(c.title, "bluray")) countBluray++;
    if (matchesSpec(c.title, "web-dl")) countWebDl++;
    if (matchesSpec(c.title, "hdr_dv")) countHdr++;
  }

  const specs: Array<CandidateFacetItem<SpecTag>> = [
    { value: "all", label: "全部规格", count: total },
    { value: "remux", label: "REMUX", count: countRemux },
    { value: "bluray", label: "BluRay/原盘", count: countBluray },
    { value: "web-dl", label: "WEB-DL", count: countWebDl },
    { value: "hdr_dv", label: "HDR/杜比视界", count: countHdr },
  ];

  return { types, resolutions, specs };
}

/**
 * 多维过滤策略执行
 */
export function filterCandidates(
  candidates: readonly ResourceCandidateView[],
  criteria: ResourceFilterCriteria,
): ResourceCandidateView[] {
  const kw = criteria.keyword.trim().toLowerCase();

  return candidates.filter((c) => {
    // 1. 关键词二次过滤（大小写不敏感匹配标题）
    if (kw.length > 0 && !c.title.toLowerCase().includes(kw)) {
      return false;
    }

    // 2. 协议/网盘类型过滤
    if (criteria.type !== "all" && c.type !== criteria.type) {
      return false;
    }

    // 3. 画质过滤
    if (criteria.resolution !== "all") {
      const res = extractResolution(c.title);
      if (res !== criteria.resolution) return false;
    }

    // 4. 规格过滤
    if (criteria.spec !== "all") {
      if (!matchesSpec(c.title, criteria.spec)) return false;
    }

    return true;
  });
}

/**
 * 排序策略执行
 */
export function sortCandidates(
  candidates: readonly ResourceCandidateView[],
  sortBy: SortOption,
): ResourceCandidateView[] {
  if (sortBy === "default") {
    return [...candidates];
  }

  const sorted = [...candidates];

  switch (sortBy) {
    case "size_desc":
      return sorted.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    case "size_asc":
      return sorted.sort((a, b) => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity));
    case "date_desc":
      return sorted.sort((a, b) => {
        const timeA = a.postedAt ? new Date(a.postedAt).getTime() : 0;
        const timeB = b.postedAt ? new Date(b.postedAt).getTime() : 0;
        return timeB - timeA;
      });
    case "seeders_desc":
      return sorted.sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
  }
}

/**
 * 分页截取与元数据计算
 */
export function paginateCandidates<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): PaginatedResult<T> {
  const totalItems = items.length;
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, totalItems);
  const pagedItems = totalItems === 0 ? [] : items.slice(startIndex, endIndex);

  return {
    items: pagedItems,
    totalItems,
    currentPage,
    totalPages,
    pageSize: safePageSize,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
    startIndex: totalItems === 0 ? 0 : startIndex + 1,
    endIndex,
  };
}

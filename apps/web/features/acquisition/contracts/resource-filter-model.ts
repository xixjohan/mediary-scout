import type { ResourceCandidateView, ResourceType } from "@media-track/workflow";
import { resourceTypeLabel } from "../core/resource-formatters";

export type ResolutionTag = "all" | "4k" | "1080p" | "720p";
export type SpecTag = "all" | "remux" | "bluray" | "web-dl" | "hdr_dv";
export type SizeBucketTag = "all" | "under_2g" | "2g_to_10g" | "10g_to_30g" | "over_30g";
export type SortOption = "default" | "size_desc" | "size_asc" | "date_desc" | "seeders_desc";

export interface ResourceFilterCriteria {
  keyword: string;
  type: ResourceType | "all";
  resolution: ResolutionTag;
  spec: SpecTag;
  size: SizeBucketTag;
  sortBy: SortOption;
}

export const DEFAULT_FILTER_CRITERIA: ResourceFilterCriteria = {
  keyword: "",
  type: "all",
  resolution: "all",
  spec: "all",
  size: "all",
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
  sizes: Array<CandidateFacetItem<SizeBucketTag>>;
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

const ONE_GB = 1024 * 1024 * 1024;

/**
 * 校验体积是否符合指定的档位策略（策略模式）
 */
export function matchesSizeBucket(sizeBytes: number | undefined, bucket: SizeBucketTag): boolean {
  if (bucket === "all") return true;
  if (sizeBytes === undefined || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return false;
  }
  switch (bucket) {
    case "under_2g":
      return sizeBytes <= 2 * ONE_GB;
    case "2g_to_10g":
      return sizeBytes > 2 * ONE_GB && sizeBytes <= 10 * ONE_GB;
    case "10g_to_30g":
      return sizeBytes > 10 * ONE_GB && sizeBytes <= 30 * ONE_GB;
    case "over_30g":
      return sizeBytes > 30 * ONE_GB;
  }
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

function countTypes(candidates: readonly ResourceCandidateView[], total: number) {
  const typeCounts = new Map<ResourceType, number>();
  for (const c of candidates) {
    typeCounts.set(c.type, (typeCounts.get(c.type) ?? 0) + 1);
  }
  const types: Array<CandidateFacetItem<ResourceType | "all">> = [
    { value: "all", label: "全部类型", count: total },
  ];
  for (const [type, count] of typeCounts.entries()) {
    types.push({ value: type, label: resourceTypeLabel(type), count });
  }
  return types;
}

function countResolutions(candidates: readonly ResourceCandidateView[], total: number) {
  let count4k = 0;
  let count1080p = 0;
  let count720p = 0;
  for (const c of candidates) {
    const res = extractResolution(c.title);
    if (res === "4k") count4k++;
    else if (res === "1080p") count1080p++;
    else if (res === "720p") count720p++;
  }
  return [
    { value: "all" as const, label: "全部分辨率", count: total },
    { value: "4k" as const, label: "4K / 2160p", count: count4k },
    { value: "1080p" as const, label: "1080p", count: count1080p },
    { value: "720p" as const, label: "720p", count: count720p },
  ];
}

function countSpecs(candidates: readonly ResourceCandidateView[], total: number) {
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
  return [
    { value: "all" as const, label: "全部规格", count: total },
    { value: "remux" as const, label: "REMUX", count: countRemux },
    { value: "bluray" as const, label: "BluRay/原盘", count: countBluray },
    { value: "web-dl" as const, label: "WEB-DL", count: countWebDl },
    { value: "hdr_dv" as const, label: "HDR/杜比视界", count: countHdr },
  ];
}

function countSizes(candidates: readonly ResourceCandidateView[], total: number) {
  let countUnder2g = 0;
  let count2gTo10g = 0;
  let count10gTo30g = 0;
  let countOver30g = 0;

  for (const c of candidates) {
    if (matchesSizeBucket(c.sizeBytes, "under_2g")) countUnder2g++;
    if (matchesSizeBucket(c.sizeBytes, "2g_to_10g")) count2gTo10g++;
    if (matchesSizeBucket(c.sizeBytes, "10g_to_30g")) count10gTo30g++;
    if (matchesSizeBucket(c.sizeBytes, "over_30g")) countOver30g++;
  }

  return [
    { value: "all" as const, label: "全部大小", count: total },
    { value: "under_2g" as const, label: "< 2 GB", count: countUnder2g },
    { value: "2g_to_10g" as const, label: "2 ~ 10 GB", count: count2gTo10g },
    { value: "10g_to_30g" as const, label: "10 ~ 30 GB", count: count10gTo30g },
    { value: "over_30g" as const, label: "> 30 GB", count: countOver30g },
  ];
}

/**
 * 提取全部分面标签及其统计数量
 */
export function extractFacets(candidates: readonly ResourceCandidateView[]): CandidateFacets {
  const total = candidates.length;
  return {
    types: countTypes(candidates, total),
    resolutions: countResolutions(candidates, total),
    specs: countSpecs(candidates, total),
    sizes: countSizes(candidates, total),
  };
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
    if (kw.length > 0 && !c.title.toLowerCase().includes(kw)) {
      return false;
    }
    if (criteria.type !== "all" && c.type !== criteria.type) {
      return false;
    }
    if (criteria.resolution !== "all" && extractResolution(c.title) !== criteria.resolution) {
      return false;
    }
    if (criteria.spec !== "all" && !matchesSpec(c.title, criteria.spec)) {
      return false;
    }
    if (criteria.size !== "all" && !matchesSizeBucket(c.sizeBytes, criteria.size)) {
      return false;
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
 * 客户端纯内存分页切片
 */
export function paginateCandidates<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): PaginatedResult<T> {
  const totalItems = items.length;
  const validPageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalItems / validPageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);

  const startIndex = (currentPage - 1) * validPageSize;
  const endIndex = Math.min(startIndex + validPageSize, totalItems);
  const pagedItems = totalItems === 0 ? [] : items.slice(startIndex, endIndex);

  return {
    items: pagedItems,
    totalItems,
    currentPage,
    totalPages,
    pageSize: validPageSize,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
    startIndex,
    endIndex,
  };
}

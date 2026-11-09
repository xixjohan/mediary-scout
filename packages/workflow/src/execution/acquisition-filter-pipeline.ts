import type { AcquisitionFilterPreferences } from "@media-track/contracts";
import { DEFAULT_FILTER_PREFERENCES } from "@media-track/contracts";
import type { ResourceCandidate } from "../domain/domain.js";
import type { ResourceCandidateView } from "../providers/resource-candidate-view.js";

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileNegativeKeywordRegex(keywords: readonly string[]): RegExp | null {
  const clean = keywords.map((k) => k.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  return new RegExp(`(?:${clean.map(escapeRegExp).join("|")})`, "i");
}

export function isAllowedContainer(
  title: string,
  allowedContainers: readonly string[] = DEFAULT_FILTER_PREFERENCES.allowedContainers,
): boolean {
  if (allowedContainers.length === 0) return true;
  // 如果标题以非视频诱饵结尾，如 .exe, .apk, .zip, .rar, .txt，直接拦截
  const DISALLOWED_BAIT = /\.(?:exe|apk|ipa|bat|sh|zip|rar|7z|tar|gz|txt|pdf|epub|mobi)$/i;
  if (DISALLOWED_BAIT.test(title)) {
    return false;
  }
  // 如果标题显式带有容器扩展名，检查是否在白名单内
  const match = /\.(mkv|mp4|ts|iso|mov|bdmv)(?:\s|$|[._\-])/i.exec(title);
  if (match) {
    const ext = `.${match[1]!.toLowerCase()}`;
    return allowedContainers.includes(ext);
  }
  // 未显式带扩展名（常见于磁力与网盘目录标题），允许放行
  return true;
}

export function passesSizeSanity(
  sizeBytes: number | null | undefined,
  mediaType: "movie" | "tv" | "anime" | "unknown",
  prefs: AcquisitionFilterPreferences = DEFAULT_FILTER_PREFERENCES,
): boolean {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return true; // 大小未知时不阻断
  }
  if (mediaType === "movie" && prefs.minMovieSizeBytes > 0) {
    return sizeBytes >= prefs.minMovieSizeBytes;
  }
  if (mediaType === "anime" && prefs.minAnimeEpisodeSizeBytes > 0) {
    return sizeBytes >= prefs.minAnimeEpisodeSizeBytes;
  }
  if (mediaType === "tv" && prefs.minSeriesEpisodeSizeBytes > 0) {
    return sizeBytes >= prefs.minSeriesEpisodeSizeBytes;
  }
  return true;
}

export interface FilterResult<T> {
  passed: T[];
  filteredCount: number;
  reasons: {
    negativeKeyword: number;
    disallowedContainer: number;
    sizeSanity: number;
  };
}

/**
 * 对候选资源应用排毒与无关内容过滤流水线
 */
export function applyAcquisitionFilters<T extends ResourceCandidate | ResourceCandidateView>(
  candidates: readonly T[],
  prefs: AcquisitionFilterPreferences = DEFAULT_FILTER_PREFERENCES,
  options?: { mediaType?: "movie" | "tv" | "anime" | "unknown" },
): FilterResult<T> {
  const mediaType = options?.mediaType ?? "unknown";
  const negativeRegex = compileNegativeKeywordRegex(prefs.negativeKeywords);
  const passed: T[] = [];
  const reasons = {
    negativeKeyword: 0,
    disallowedContainer: 0,
    sizeSanity: 0,
  };

  for (const candidate of candidates) {
    const title = candidate.title;

    // Layer 1: 文本黑名单正则过滤
    if (negativeRegex && negativeRegex.test(title)) {
      reasons.negativeKeyword += 1;
      continue;
    }

    // Layer 2: 媒体容器校验与假种拦截
    if (!isAllowedContainer(title, prefs.allowedContainers)) {
      reasons.disallowedContainer += 1;
      continue;
    }

    // Layer 3: 体积安全闸门
    const size = "sizeBytes" in candidate ? candidate.sizeBytes : null;
    if (!passesSizeSanity(size, mediaType, prefs)) {
      reasons.sizeSanity += 1;
      continue;
    }

    passed.push(candidate);
  }

  return {
    passed,
    filteredCount: candidates.length - passed.length,
    reasons,
  };
}

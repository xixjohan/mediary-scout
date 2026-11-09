/**
 * @media-track/contracts — 中立契约层。
 *
 * 五大 Solution 角色铁律（docs/architecture-remediation-and-governance.md §2.1）：
 *   Feature owns behavior. Contracts expose capability.
 *   Infrastructure implements technical boundaries. Composition wires implementations.
 *   Shared contains ownerless reusable capability.
 *
 * 本包零第三方依赖、零业务逻辑，只放端口定义与 DTO。
 */

export type { FileMetadata, IStorageDriver, StorageBrand } from "./infrastructure-ports/IStorageDriver.js";
export type { IJobQueue, Job, JobStatus, EnqueueJobInput } from "./infrastructure-ports/IJobQueue.js";
export type { ISearchProvider, ResourceCandidate, SearchQuery } from "./infrastructure-ports/ISearchProvider.js";
export type { IMediaMetadataProvider, MediaMetadata, MediaType } from "./infrastructure-ports/IMediaMetadataProvider.js";

export interface AcquisitionFilterPreferences {
  mode: "loose" | "balanced" | "strict" | "custom";
  negativeKeywords: string[];
  allowedContainers: string[];
  minMovieSizeBytes: number;
  minSeriesEpisodeSizeBytes: number;
  minAnimeEpisodeSizeBytes: number;
}

export const DEFAULT_FILTER_PREFERENCES: AcquisitionFilterPreferences = {
  mode: "balanced",
  negativeKeywords: [
    "原声带",
    "OST",
    "soundtrack",
    "有声书",
    "有声小说",
    "广播剧",
    "小说",
    "电子书",
    "预告",
    "预告片",
    "trailer",
    "花絮",
    "特辑",
    "采访",
    "解说",
    "剪辑",
    "看点",
    "枪版",
    "抢先版",
    "TC",
    "TS",
    "中字赌博",
    "菠菜",
    "加群领密码",
    "解压密码",
  ],
  allowedContainers: [".mkv", ".mp4", ".ts", ".iso"],
  minMovieSizeBytes: 800 * 1024 * 1024,
  minSeriesEpisodeSizeBytes: 200 * 1024 * 1024,
  minAnimeEpisodeSizeBytes: 100 * 1024 * 1024,
};

export type QualityCutoffPreference = "none" | "720p" | "1080p" | "2160p";

export interface AcquisitionEpisodePolicies {
  directoryInspectionEnabled: boolean;
  packArbitrationMode: "auto" | "prefer_single" | "prefer_pack";
  absoluteEpisodeMappingEnabled: boolean;
  qualityCutoff: QualityCutoffPreference;
  allowAutoUpgrade: boolean;
}

export const DEFAULT_EPISODE_POLICIES: AcquisitionEpisodePolicies = {
  directoryInspectionEnabled: true,
  packArbitrationMode: "auto",
  absoluteEpisodeMappingEnabled: true,
  qualityCutoff: "1080p",
  allowAutoUpgrade: false,
};

export const DEFAULT_ACCOUNT_ID = "acct_default";
export const UNAUTHENTICATED_ACCOUNT_ID = "acct_unauthenticated";

export type TokenCredential = Record<string, unknown>;

export class UnauthenticatedAccountError extends Error {
  constructor(message = "未登录，请先登录后再操作。") {
    super(message);
    this.name = "UnauthenticatedAccountError";
  }
}

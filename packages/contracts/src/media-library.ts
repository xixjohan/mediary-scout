/**
 * @media-track/contracts — 影视库与流媒体媒体中心契约定义
 */

export type MediaLibraryType = "movie" | "tv" | "anime" | "other";
export type LibraryDeliveryMode = "redirect" | "proxy";
export type BindingDeliveryMode = "redirect" | "proxy" | "inherit";
export type LibraryScanMode = "incremental_missing" | "full_deep";
export type MediaReviewStatus = "auto_accepted" | "needs_review";

export interface MediaLibrary {
  id: string;
  accountId: string;
  name: string;
  libraryType: MediaLibraryType;
  posterStyle: "poster" | "backdrop";
  isPinned: boolean;
  sortOrder: number;
  defaultDeliveryMode: LibraryDeliveryMode;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryPathBinding {
  id: string;
  libraryId: string;
  storageId: string;
  remoteFolderId: string;
  remotePath: string;
  scheduledScanEnabled: boolean;
  scanIntervalMinutes: number;
  scanCron?: string | null;
  scanMode: LibraryScanMode;
  minFileSizeMb: number;
  excludeKeywords: string[];
  deliveryMode: BindingDeliveryMode;
  lastScanAt?: string | null;
  lastScanStatus?: "idle" | "running" | "success" | "failed" | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryMediaItem {
  id: string;
  libraryId: string;
  tmdbId?: number | null | undefined;
  doubanId?: string | null | undefined;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle?: string | null | undefined;
  releaseYear?: number | null | undefined;
  overview?: string | null | undefined;
  posterPath?: string | null | undefined;
  backdropPath?: string | null | undefined;
  rating?: number | null | undefined;
  genres: string[];
  isMetadataLocked: boolean;
  reviewStatus: MediaReviewStatus;
  versionCount?: number | undefined;
  totalEpisodes?: number | undefined;
  seasonCount?: number | undefined;
  hasMultiVersion?: boolean | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface LibrarySeason {
  id: string;
  mediaItemId: string;
  seasonNumber: number;
  name: string;
  totalEpisodes: number;
  posterPath?: string | null;
  airDate?: string | null;
}

export interface SubtitleTrackInfo {
  id: string;
  language: string;
  title: string;
  format: "srt" | "ass" | "vtt" | "pgs" | "sub";
  type: "embedded" | "external";
  url?: string;
  fileId?: string;
}

export interface LibraryEpisode {
  id: string;
  seasonId: string;
  bindingId?: string | undefined;
  episodeNumber: number;
  episodeName?: string | null | undefined;
  storageId: string;
  fileId: string;
  fileName: string;
  versionTag?: string | null | undefined;
  isDefaultVersion?: boolean | undefined;
  pickCode?: string | null | undefined;
  sizeBytes: number;
  videoCodec?: string | null | undefined;
  resolution?: string | null | undefined;
  durationSeconds?: number | null | undefined;
  subtitles: SubtitleTrackInfo[];
  relativePath?: string | null | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface BatchRematchItemResult {
  id: string;
  success: boolean;
  title?: string | undefined;
  tmdbId?: number | undefined;
  error?: string | undefined;
}

export interface BatchRematchResponse {
  total: number;
  succeeded: number;
  failed: number;
  results: BatchRematchItemResult[];
}

export interface PathConnectionTestResult {
  success: boolean;
  latencyMs: number;
  fileCount?: number;
  folderName?: string;
  error?: string;
}

export interface LibraryScanSnapshot {
  id: string;
  bindingId: string;
  dirId: string;
  dirName: string;
  dirPath: string;
  fileCount: number;
  lastModifiedHash: string;
  checkedAt: string;
}

export type ScanStepStage =
  | "DISCOVERING_FOLDERS"
  | "DIFFING_CACHE"
  | "PARSING_FILENAMES"
  | "SCRAPING_METADATA"
  | "PERSISTING"
  | "COMPLETED"
  | "FAILED"
  | "ABORTED";

export interface LibraryScanProgressEvent {
  libraryId: string;
  bindingId?: string | undefined;
  stage: ScanStepStage;
  message: string;
  totalDiscovered: number;
  processedCount: number;
  percent: number;
  currentTitle?: string | undefined;
  error?: string | undefined;
  timestamp: string;
}

/** 扫描作业状态。终态一旦写入不可回退，避免迟到进度事件覆盖结果。 */
export type LibraryScanJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "aborted";

/**
 * 扫描作业持久化视图（library_scan_jobs 表）。
 * 这是扫描进度的唯一事实源，SSE 仅作低延迟加速推送。
 */
export interface LibraryScanJob {
  id: string;
  libraryId: string;
  accountId: string;
  bindingIds: string[];
  status: LibraryScanJobStatus;
  stage?: ScanStepStage | null;
  message?: string | null;
  percent: number;
  totalDiscovered: number;
  processedCount: number;
  currentTitle?: string | null;
  error?: string | null;
  forceFullScan: boolean;
  lockedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

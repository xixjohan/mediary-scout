export type ReverseScanJobStatus =
  | "queued"
  | "scanning_directories"
  | "matching_metadata"
  | "reconciling_episodes"
  | "persisting_subscriptions"
  | "completed"
  | "failed"
  | "paused";

export type ReverseScanItemReviewStatus =
  | "auto_accepted"
  | "pending_review"
  | "user_accepted"
  | "user_rejected"
  | "ignored";

export interface ReverseScanJob {
  id: string;
  accountId: string;
  storageId: string;
  targetCid: string;
  category: "movie" | "tv" | "anime" | "auto";
  status: ReverseScanJobStatus;
  totalFolders: number;
  scannedFolders: number;
  discoveredTitles: number;
  autoIngestedTitles: number;
  pendingReviewTitles: number;
  currentStepMessage?: string | null | undefined;
  progressPercent: number;
  errorMessage?: string | null | undefined;
  startedAt?: string | null | undefined;
  finishedAt?: string | null | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface CreateReverseScanJobInput {
  id?: string | undefined;
  accountId: string;
  storageId: string;
  targetCid: string;
  category?: "movie" | "tv" | "anime" | "auto" | undefined;
}

export interface UpdateReverseScanJobPatch {
  status?: ReverseScanJobStatus | undefined;
  totalFolders?: number | undefined;
  scannedFolders?: number | undefined;
  discoveredTitles?: number | undefined;
  autoIngestedTitles?: number | undefined;
  pendingReviewTitles?: number | undefined;
  currentStepMessage?: string | null | undefined;
  progressPercent?: number | undefined;
  errorMessage?: string | null | undefined;
  startedAt?: string | null | undefined;
  finishedAt?: string | null | undefined;
}

export interface ReverseScanItem {
  id: string;
  jobId: string;
  accountId: string;
  folderId: string;
  folderName: string;
  relativePath: string;
  parsedTitle?: string | null | undefined;
  parsedYear?: number | null | undefined;
  matchedTmdbId?: number | null | undefined;
  matchedMediaType?: "movie" | "tv" | "anime" | null | undefined;
  matchedTitle?: string | null | undefined;
  matchedPosterPath?: string | null | undefined;
  confidence: number;
  reviewStatus: ReverseScanItemReviewStatus;
  discoveredFilesJson: string;
  reconciledSeasonsJson?: string | null | undefined;
  errorReason?: string | null | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface CreateReverseScanItemInput {
  id?: string | undefined;
  jobId: string;
  accountId: string;
  folderId: string;
  folderName: string;
  relativePath: string;
  parsedTitle?: string | null | undefined;
  parsedYear?: number | null | undefined;
  matchedTmdbId?: number | null | undefined;
  matchedMediaType?: "movie" | "tv" | "anime" | null | undefined;
  matchedTitle?: string | null | undefined;
  matchedPosterPath?: string | null | undefined;
  confidence?: number | undefined;
  reviewStatus?: ReverseScanItemReviewStatus | undefined;
  discoveredFilesJson?: string | undefined;
  reconciledSeasonsJson?: string | null | undefined;
  errorReason?: string | null | undefined;
}

export interface UpdateReverseScanItemPatch {
  reviewStatus?: ReverseScanItemReviewStatus | undefined;
  matchedTmdbId?: number | null | undefined;
  matchedMediaType?: "movie" | "tv" | "anime" | null | undefined;
  matchedTitle?: string | null | undefined;
  reconciledSeasonsJson?: string | null | undefined;
  errorReason?: string | null | undefined;
}

export interface ReverseScanStore {
  createReverseScanJob(input: CreateReverseScanJobInput): Promise<ReverseScanJob>;
  getReverseScanJob(id: string): Promise<ReverseScanJob | null>;
  listReverseScanJobs(accountId: string, limit?: number): Promise<ReverseScanJob[]>;
  updateReverseScanJob(id: string, patch: UpdateReverseScanJobPatch): Promise<void>;
  createReverseScanItem(input: CreateReverseScanItemInput): Promise<ReverseScanItem>;
  listReverseScanItems(jobId: string, reviewStatus?: ReverseScanItemReviewStatus): Promise<ReverseScanItem[]>;
  updateReverseScanItem(id: string, patch: UpdateReverseScanItemPatch): Promise<void>;
}

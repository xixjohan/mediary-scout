/**
 * STRM 领域核心类型定义
 */

export type StrmScanMode = "incremental_missing" | "incremental_update" | "full_sync";
export type StrmScheduleMode = "interval" | "manual";
export type StrmTaskStatus = "idle" | "running" | "paused" | "error";
export type StrmDeliveryMode = "redirect" | "proxy";

export interface StrmTask {
  id: string;
  accountId: string;
  name: string;
  storageId: string;
  remoteFolderId: string;
  remotePath: string;
  localOutputDir: string;
  scanIntervalMinutes: number;
  scanMode: StrmScanMode;
  extensions: string;
  minFileSizeMb: number;
  excludeKeywords: string | null;
  scheduleMode: StrmScheduleMode;
  status: StrmTaskStatus;
  deliveryMode?: StrmDeliveryMode | undefined;
  isActive?: boolean | undefined;
  mediaServerId?: string | null | undefined;
  mediaLibraryId?: string | null | undefined;
  mediaLibraryName?: string | null | undefined;
  lastScanAt: string | null;
  lastScanStatus: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStrmTaskInput {
  id?: string;
  accountId: string;
  name: string;
  storageId: string;
  remoteFolderId: string;
  remotePath: string;
  localOutputDir: string;
  scanIntervalMinutes?: number;
  scanMode?: StrmScanMode;
  extensions?: string;
  minFileSizeMb?: number;
  excludeKeywords?: string | null | undefined;
  scheduleMode?: StrmScheduleMode | undefined;
  deliveryMode?: StrmDeliveryMode | undefined;
  isActive?: boolean | undefined;
  mediaServerId?: string | null | undefined;
  mediaLibraryId?: string | null | undefined;
  mediaLibraryName?: string | null | undefined;
}

export interface UpdateStrmTaskInput {
  id: string;
  accountId: string;
  name?: string | undefined;
  storageId?: string | undefined;
  remoteFolderId?: string | undefined;
  remotePath?: string | undefined;
  localOutputDir?: string | undefined;
  scanIntervalMinutes?: number | undefined;
  scanMode?: StrmScanMode | undefined;
  extensions?: string | undefined;
  minFileSizeMb?: number | undefined;
  excludeKeywords?: string | null | undefined;
  scheduleMode?: StrmScheduleMode | undefined;
  status?: StrmTaskStatus | undefined;
  deliveryMode?: StrmDeliveryMode | undefined;
  isActive?: boolean | undefined;
  mediaServerId?: string | null | undefined;
  mediaLibraryId?: string | null | undefined;
  mediaLibraryName?: string | null | undefined;
  lastScanAt?: string | null;
  lastScanStatus?: string | null;
  lastErrorMessage?: string | null;
}

export interface StrmLinkCacheItem {
  cacheKey: string;
  downloadUrl: string;
  deliveryMode: StrmDeliveryMode;
  headersJson: string | null;
  expiresAt: number; // Unix timestamp in seconds
}

export interface StrmExecutionRecord {
  id: string;
  taskId: string;
  taskName: string;
  accountId: string;
  triggerSource: "manual" | "interval" | "pinpoint_ingest";
  status: "running" | "succeeded" | "failed";
  scannedCount: number;
  generatedCount: number;
  updatedCount: number;
  removedCount: number;
  currentProgressPercent: number;
  currentStepMessage: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface CreateStrmExecutionRecordInput {
  id?: string | undefined;
  taskId: string;
  taskName: string;
  accountId: string;
  triggerSource: "manual" | "interval" | "pinpoint_ingest";
  status?: ("running" | "succeeded" | "failed") | undefined;
  scannedCount?: number | undefined;
  generatedCount?: number | undefined;
  updatedCount?: number | undefined;
  removedCount?: number | undefined;
  currentProgressPercent?: number | undefined;
  currentStepMessage?: string | null | undefined;
  errorMessage?: string | null | undefined;
  startedAt?: string | undefined;
}

export interface UpdateStrmExecutionRecordInput {
  id: string;
  status?: ("running" | "succeeded" | "failed") | undefined;
  scannedCount?: number | undefined;
  generatedCount?: number | undefined;
  updatedCount?: number | undefined;
  removedCount?: number | undefined;
  currentProgressPercent?: number | undefined;
  currentStepMessage?: string | null | undefined;
  errorMessage?: string | null | undefined;
  finishedAt?: string | null | undefined;
  durationMs?: number | null | undefined;
}

export interface StrmStore {
  listStrmTasks(accountId: string): Promise<StrmTask[]>;
  getStrmTask(id: string, accountId: string): Promise<StrmTask | null>;
  findStrmTaskById(id: string): Promise<StrmTask | null>;
  createStrmTask(input: CreateStrmTaskInput): Promise<StrmTask>;
  updateStrmTask(input: UpdateStrmTaskInput): Promise<StrmTask | null>;
  deleteStrmTask(id: string, accountId: string): Promise<boolean>;

  getStrmLinkCache(cacheKey: string): Promise<StrmLinkCacheItem | null>;
  setStrmLinkCache(item: StrmLinkCacheItem): Promise<void>;
  pruneExpiredStrmLinkCache(): Promise<number>;

  createStrmExecutionRecord(input: CreateStrmExecutionRecordInput): Promise<StrmExecutionRecord>;
  updateStrmExecutionRecord(input: UpdateStrmExecutionRecordInput): Promise<StrmExecutionRecord | null>;
  listStrmExecutionRecords(taskId: string, accountId: string, limit?: number): Promise<StrmExecutionRecord[]>;
  getLatestStrmExecutionRecord(taskId: string, accountId: string): Promise<StrmExecutionRecord | null>;
}

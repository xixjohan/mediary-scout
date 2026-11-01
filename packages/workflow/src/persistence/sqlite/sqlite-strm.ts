import { BaseSqliteModule } from "../sqlite-context.js";
import type {
  CreateStrmExecutionRecordInput,
  CreateStrmTaskInput,
  StrmDeliveryMode,
  StrmExecutionRecord,
  StrmLinkCacheItem,
  StrmStore,
  StrmTask,
  UpdateStrmExecutionRecordInput,
  UpdateStrmTaskInput,
} from "../../strm/strm-types.js";

interface StrmTaskRow {
  id: string;
  account_id: string;
  name: string;
  storage_id: string;
  remote_folder_id: string;
  remote_path: string;
  local_output_dir: string;
  scan_interval_minutes: number;
  scan_mode: string;
  extensions: string;
  min_file_size_mb: number;
  exclude_keywords: string | null;
  schedule_mode: string;
  status: string;
  last_scan_at: string | null;
  last_scan_status: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

function strmTaskFromRow(row: StrmTaskRow): StrmTask {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    storageId: row.storage_id,
    remoteFolderId: row.remote_folder_id,
    remotePath: row.remote_path,
    localOutputDir: row.local_output_dir,
    scanIntervalMinutes: row.scan_interval_minutes,
    scanMode: row.scan_mode as StrmTask["scanMode"],
    extensions: row.extensions,
    minFileSizeMb: row.min_file_size_mb,
    excludeKeywords: row.exclude_keywords ?? null,
    scheduleMode: row.schedule_mode as StrmTask["scheduleMode"],
    status: row.status as StrmTask["status"],
    lastScanAt: row.last_scan_at,
    lastScanStatus: row.last_scan_status,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface StrmLinkCacheRow {
  cache_key: string;
  download_url: string;
  delivery_mode: string;
  headers_json: string | null;
  expires_at: number;
}

interface StrmExecutionRecordRow {
  id: string;
  task_id: string;
  task_name: string;
  account_id: string;
  trigger_source: string;
  status: string;
  scanned_count: number;
  generated_count: number;
  updated_count: number;
  removed_count: number;
  current_progress_percent: number;
  current_step_message: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

function strmExecutionRecordFromRow(row: StrmExecutionRecordRow): StrmExecutionRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    taskName: row.task_name,
    accountId: row.account_id,
    triggerSource: row.trigger_source as StrmExecutionRecord["triggerSource"],
    status: row.status as StrmExecutionRecord["status"],
    scannedCount: row.scanned_count,
    generatedCount: row.generated_count,
    updatedCount: row.updated_count,
    removedCount: row.removed_count,
    currentProgressPercent: row.current_progress_percent,
    currentStepMessage: row.current_step_message,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
  };
}

/**
 * STRM 任务配置、流链接缓存与执行记录专用 SQLite 持久层模块
 */
export class SqliteStrmRepository extends BaseSqliteModule implements StrmStore {
  async listStrmTasks(accountId: string): Promise<StrmTask[]> {
    const rows = this.db
      .prepare("SELECT * FROM strm_tasks WHERE account_id = ? ORDER BY created_at DESC")
      .all(accountId) as StrmTaskRow[];
    return rows.map(strmTaskFromRow);
  }

  async getStrmTask(id: string, accountId: string): Promise<StrmTask | null> {
    const row = this.db
      .prepare("SELECT * FROM strm_tasks WHERE id = ? AND account_id = ?")
      .get(id, accountId) as StrmTaskRow | undefined;
    return row ? strmTaskFromRow(row) : null;
  }

  async createStrmTask(input: CreateStrmTaskInput): Promise<StrmTask> {
    const id = input.id ?? `strm_task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = this.now();
    const task: StrmTask = {
      id,
      accountId: input.accountId,
      name: input.name,
      storageId: input.storageId,
      remoteFolderId: input.remoteFolderId,
      remotePath: input.remotePath,
      localOutputDir: input.localOutputDir,
      scanIntervalMinutes: input.scanIntervalMinutes ?? 360,
      scanMode: input.scanMode ?? "incremental_missing",
      extensions: input.extensions ?? "mp4;mkv;ts;avi;mov;wmv;iso;flv",
      minFileSizeMb: input.minFileSizeMb ?? 100,
      excludeKeywords: input.excludeKeywords ?? null,
      scheduleMode: input.scheduleMode ?? "interval",
      status: "idle",
      lastScanAt: null,
      lastScanStatus: null,
      lastErrorMessage: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO strm_tasks (
          id, account_id, name, storage_id, remote_folder_id, remote_path, local_output_dir,
          scan_interval_minutes, scan_mode, extensions, min_file_size_mb, exclude_keywords,
          schedule_mode, status, last_scan_at, last_scan_status, last_error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.accountId,
        task.name,
        task.storageId,
        task.remoteFolderId,
        task.remotePath,
        task.localOutputDir,
        task.scanIntervalMinutes,
        task.scanMode,
        task.extensions,
        task.minFileSizeMb,
        task.excludeKeywords,
        task.scheduleMode,
        task.status,
        task.lastScanAt,
        task.lastScanStatus,
        task.lastErrorMessage,
        task.createdAt,
        task.updatedAt,
      );

    return task;
  }

  private mergeStrmTaskUpdates(current: StrmTask, input: UpdateStrmTaskInput, now: string): StrmTask {
    const updated = { ...current, updatedAt: now };
    for (const [key, val] of Object.entries(input)) {
      if (val !== undefined && key !== "id" && key !== "accountId") {
        (updated as any)[key] = val;
      }
    }
    return updated as StrmTask;
  }

  async updateStrmTask(input: UpdateStrmTaskInput): Promise<StrmTask | null> {
    const current = await this.getStrmTask(input.id, input.accountId);
    if (!current) return null;

    const now = this.now();
    const updated = this.mergeStrmTaskUpdates(current, input, now);

    this.db
      .prepare(
        `UPDATE strm_tasks SET
          name = ?, storage_id = ?, remote_folder_id = ?, remote_path = ?, local_output_dir = ?,
          scan_interval_minutes = ?, scan_mode = ?, extensions = ?, min_file_size_mb = ?, exclude_keywords = ?,
          schedule_mode = ?, status = ?, last_scan_at = ?, last_scan_status = ?, last_error_message = ?, updated_at = ?
        WHERE id = ? AND account_id = ?`,
      )
      .run(
        updated.name,
        updated.storageId,
        updated.remoteFolderId,
        updated.remotePath,
        updated.localOutputDir,
        updated.scanIntervalMinutes,
        updated.scanMode,
        updated.extensions,
        updated.minFileSizeMb,
        updated.excludeKeywords,
        updated.scheduleMode,
        updated.status,
        updated.lastScanAt,
        updated.lastScanStatus,
        updated.lastErrorMessage,
        updated.updatedAt,
        updated.id,
        updated.accountId,
      );

    return updated;
  }

  async deleteStrmTask(id: string, accountId: string): Promise<boolean> {
    const res = this.db.prepare("DELETE FROM strm_tasks WHERE id = ? AND account_id = ?").run(id, accountId);
    return res.changes > 0;
  }

  async getStrmLinkCache(cacheKey: string): Promise<StrmLinkCacheItem | null> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare("SELECT * FROM strm_link_cache WHERE cache_key = ? AND expires_at > ?")
      .get(cacheKey, nowSeconds) as StrmLinkCacheRow | undefined;
    if (!row) return null;

    return {
      cacheKey: row.cache_key,
      downloadUrl: row.download_url,
      deliveryMode: row.delivery_mode as StrmDeliveryMode,
      headersJson: row.headers_json,
      expiresAt: row.expires_at,
    };
  }

  async setStrmLinkCache(item: StrmLinkCacheItem): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO strm_link_cache (cache_key, download_url, delivery_mode, headers_json, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (cache_key) DO UPDATE SET
           download_url = excluded.download_url,
           delivery_mode = excluded.delivery_mode,
           headers_json = excluded.headers_json,
           expires_at = excluded.expires_at`,
      )
      .run(item.cacheKey, item.downloadUrl, item.deliveryMode, item.headersJson, item.expiresAt);
  }

  async deleteStrmLinkCache(cacheKey: string): Promise<boolean> {
    const res = this.db.prepare("DELETE FROM strm_link_cache WHERE cache_key = ?").run(cacheKey);
    return res.changes > 0;
  }

  async pruneExpiredStrmLinkCache(): Promise<number> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const res = this.db.prepare("DELETE FROM strm_link_cache WHERE expires_at <= ?").run(nowSeconds);
    return res.changes;
  }

  async cleanupExpiredStrmLinkCache(): Promise<number> {
    return this.pruneExpiredStrmLinkCache();
  }

  async createStrmExecutionRecord(input: CreateStrmExecutionRecordInput): Promise<StrmExecutionRecord> {
    const id = input.id ?? `strm_rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = input.startedAt ?? this.now();
    const record: StrmExecutionRecord = {
      id,
      taskId: input.taskId,
      taskName: input.taskName,
      accountId: input.accountId,
      triggerSource: input.triggerSource,
      status: input.status ?? "running",
      scannedCount: input.scannedCount ?? 0,
      generatedCount: input.generatedCount ?? 0,
      updatedCount: input.updatedCount ?? 0,
      removedCount: input.removedCount ?? 0,
      currentProgressPercent: input.currentProgressPercent ?? 0,
      currentStepMessage: input.currentStepMessage ?? null,
      errorMessage: input.errorMessage ?? null,
      startedAt,
      finishedAt: null,
      durationMs: null,
    };

    this.db
      .prepare(
        `INSERT INTO strm_execution_records (
          id, task_id, task_name, account_id, trigger_source, status,
          scanned_count, generated_count, updated_count, removed_count,
          current_progress_percent, current_step_message, error_message,
          started_at, finished_at, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null)`,
      )
      .run(
        record.id,
        record.taskId,
        record.taskName,
        record.accountId,
        record.triggerSource,
        record.status,
        record.scannedCount,
        record.generatedCount,
        record.updatedCount,
        record.removedCount,
        record.currentProgressPercent,
        record.currentStepMessage,
        record.errorMessage,
        record.startedAt,
      );

    return record;
  }

  async updateStrmExecutionRecord(input: UpdateStrmExecutionRecordInput): Promise<StrmExecutionRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM strm_execution_records WHERE id = ?")
      .get(input.id) as StrmExecutionRecordRow | undefined;
    if (!row) return null;

    const current = strmExecutionRecordFromRow(row);
    const updated: StrmExecutionRecord = {
      ...current,
      status: input.status ?? current.status,
      scannedCount: input.scannedCount ?? current.scannedCount,
      generatedCount: input.generatedCount ?? current.generatedCount,
      updatedCount: input.updatedCount ?? current.updatedCount,
      removedCount: input.removedCount ?? current.removedCount,
      currentProgressPercent: input.currentProgressPercent ?? current.currentProgressPercent,
      currentStepMessage: input.currentStepMessage !== undefined ? input.currentStepMessage : current.currentStepMessage,
      errorMessage: input.errorMessage !== undefined ? input.errorMessage : current.errorMessage,
      finishedAt: input.finishedAt !== undefined ? input.finishedAt : (input.status === "succeeded" || input.status === "failed" ? this.now() : current.finishedAt),
      durationMs: input.durationMs !== undefined ? input.durationMs : current.durationMs,
    };

    this.db
      .prepare(
        `UPDATE strm_execution_records SET
          status = ?, scanned_count = ?, generated_count = ?, updated_count = ?, removed_count = ?,
          current_progress_percent = ?, current_step_message = ?, error_message = ?,
          finished_at = ?, duration_ms = ?
        WHERE id = ?`,
      )
      .run(
        updated.status,
        updated.scannedCount,
        updated.generatedCount,
        updated.updatedCount,
        updated.removedCount,
        updated.currentProgressPercent,
        updated.currentStepMessage,
        updated.errorMessage,
        updated.finishedAt,
        updated.durationMs,
        updated.id,
      );

    return updated;
  }

  async getStrmExecutionRecord(id: string, accountId: string): Promise<StrmExecutionRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM strm_execution_records WHERE id = ? AND account_id = ?")
      .get(id, accountId) as StrmExecutionRecordRow | undefined;
    return row ? strmExecutionRecordFromRow(row) : null;
  }

  async listStrmExecutionRecords(taskId: string, accountId: string, limit = 50): Promise<StrmExecutionRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM strm_execution_records WHERE task_id = ? AND account_id = ? ORDER BY started_at DESC LIMIT ?",
      )
      .all(taskId, accountId, limit) as StrmExecutionRecordRow[];
    return rows.map(strmExecutionRecordFromRow);
  }

  async getLatestStrmExecutionRecord(taskId: string, accountId: string): Promise<StrmExecutionRecord | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM strm_execution_records WHERE task_id = ? AND account_id = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(taskId, accountId) as StrmExecutionRecordRow | undefined;
    return row ? strmExecutionRecordFromRow(row) : null;
  }
}

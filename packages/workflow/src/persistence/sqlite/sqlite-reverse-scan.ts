import { BaseSqliteModule } from "../sqlite-context.js";
import type {
  ReverseScanJob,
  CreateReverseScanJobInput,
  UpdateReverseScanJobPatch,
  ReverseScanItem,
  CreateReverseScanItemInput,
  UpdateReverseScanItemPatch,
  ReverseScanItemReviewStatus,
} from "../../domain/reverse-scan-types.js";

interface ReverseScanJobRow {
  id: string;
  account_id: string;
  storage_id: string;
  target_cid: string;
  category: string;
  status: string;
  total_folders: number;
  scanned_folders: number;
  discovered_titles: number;
  auto_ingested_titles: number;
  pending_review_titles: number;
  current_step_message: string | null;
  progress_percent: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReverseScanItemRow {
  id: string;
  job_id: string;
  account_id: string;
  folder_id: string;
  folder_name: string;
  relative_path: string;
  parsed_title: string | null;
  parsed_year: number | null;
  matched_tmdb_id: number | null;
  matched_media_type: string | null;
  matched_title: string | null;
  matched_poster_path: string | null;
  confidence: number;
  review_status: string;
  discovered_files_json: string;
  reconciled_seasons_json: string | null;
  error_reason: string | null;
  created_at: string;
  updated_at: string;
}

function jobFromRow(row: ReverseScanJobRow): ReverseScanJob {
  return {
    id: row.id,
    accountId: row.account_id,
    storageId: row.storage_id,
    targetCid: row.target_cid,
    category: row.category as ReverseScanJob["category"],
    status: row.status as ReverseScanJob["status"],
    totalFolders: row.total_folders,
    scannedFolders: row.scanned_folders,
    discoveredTitles: row.discovered_titles,
    autoIngestedTitles: row.auto_ingested_titles,
    pendingReviewTitles: row.pending_review_titles,
    currentStepMessage: row.current_step_message,
    progressPercent: row.progress_percent,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function itemFromRow(row: ReverseScanItemRow): ReverseScanItem {
  return {
    id: row.id,
    jobId: row.job_id,
    accountId: row.account_id,
    folderId: row.folder_id,
    folderName: row.folder_name,
    relativePath: row.relative_path,
    parsedTitle: row.parsed_title,
    parsedYear: row.parsed_year,
    matchedTmdbId: row.matched_tmdb_id,
    matchedMediaType: row.matched_media_type as ReverseScanItem["matchedMediaType"],
    matchedTitle: row.matched_title,
    matchedPosterPath: row.matched_poster_path,
    confidence: row.confidence,
    reviewStatus: row.review_status as ReverseScanItem["reviewStatus"],
    discoveredFilesJson: row.discovered_files_json,
    reconciledSeasonsJson: row.reconciled_seasons_json,
    errorReason: row.error_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteReverseScanStore extends BaseSqliteModule {
  async createReverseScanJob(input: CreateReverseScanJobInput): Promise<ReverseScanJob> {
    const id = input.id ?? `scan_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const category = input.category ?? "auto";

    this.db
      .prepare(
        `INSERT INTO reverse_scan_jobs (
          id, account_id, storage_id, target_cid, category, status,
          total_folders, scanned_folders, discovered_titles, auto_ingested_titles,
          pending_review_titles, current_step_message, progress_percent,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', 0, 0, 0, 0, 0, '等待扫描队列调度...', 0, ?, ?)`,
      )
      .run(id, input.accountId, input.storageId, input.targetCid, category, now, now);

    const row = this.db.prepare("SELECT * FROM reverse_scan_jobs WHERE id = ?").get(id) as ReverseScanJobRow;
    return jobFromRow(row);
  }

  async getReverseScanJob(id: string): Promise<ReverseScanJob | null> {
    const row = this.db.prepare("SELECT * FROM reverse_scan_jobs WHERE id = ?").get(id) as ReverseScanJobRow | undefined;
    return row ? jobFromRow(row) : null;
  }

  async listReverseScanJobs(accountId: string, limit = 20): Promise<ReverseScanJob[]> {
    const rows = this.db
      .prepare("SELECT * FROM reverse_scan_jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(accountId, limit) as ReverseScanJobRow[];
    return rows.map(jobFromRow);
  }

  async updateReverseScanJob(id: string, patch: UpdateReverseScanJobPatch): Promise<void> {
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [new Date().toISOString()];

    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.totalFolders !== undefined) {
      sets.push("total_folders = ?");
      params.push(patch.totalFolders);
    }
    if (patch.scannedFolders !== undefined) {
      sets.push("scanned_folders = ?");
      params.push(patch.scannedFolders);
    }
    if (patch.discoveredTitles !== undefined) {
      sets.push("discovered_titles = ?");
      params.push(patch.discoveredTitles);
    }
    if (patch.autoIngestedTitles !== undefined) {
      sets.push("auto_ingested_titles = ?");
      params.push(patch.autoIngestedTitles);
    }
    if (patch.pendingReviewTitles !== undefined) {
      sets.push("pending_review_titles = ?");
      params.push(patch.pendingReviewTitles);
    }
    if (patch.currentStepMessage !== undefined) {
      sets.push("current_step_message = ?");
      params.push(patch.currentStepMessage);
    }
    if (patch.progressPercent !== undefined) {
      sets.push("progress_percent = ?");
      params.push(patch.progressPercent);
    }
    if (patch.errorMessage !== undefined) {
      sets.push("error_message = ?");
      params.push(patch.errorMessage);
    }
    if (patch.startedAt !== undefined) {
      sets.push("started_at = ?");
      params.push(patch.startedAt);
    }
    if (patch.finishedAt !== undefined) {
      sets.push("finished_at = ?");
      params.push(patch.finishedAt);
    }

    params.push(id);
    this.db.prepare(`UPDATE reverse_scan_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  async createReverseScanItem(input: CreateReverseScanItemInput): Promise<ReverseScanItem> {
    const id = input.id ?? `item_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO reverse_scan_items (
          id, job_id, account_id, folder_id, folder_name, relative_path,
          parsed_title, parsed_year, matched_tmdb_id, matched_media_type,
          matched_title, matched_poster_path, confidence, review_status,
          discovered_files_json, reconciled_seasons_json, error_reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.jobId,
        input.accountId,
        input.folderId,
        input.folderName,
        input.relativePath,
        input.parsedTitle ?? null,
        input.parsedYear ?? null,
        input.matchedTmdbId ?? null,
        input.matchedMediaType ?? null,
        input.matchedTitle ?? null,
        input.matchedPosterPath ?? null,
        input.confidence ?? 0,
        input.reviewStatus ?? "auto_accepted",
        input.discoveredFilesJson ?? "[]",
        input.reconciledSeasonsJson ?? null,
        input.errorReason ?? null,
        now,
        now,
      );

    const row = this.db.prepare("SELECT * FROM reverse_scan_items WHERE id = ?").get(id) as ReverseScanItemRow;
    return itemFromRow(row);
  }

  async listReverseScanItems(jobId: string, reviewStatus?: ReverseScanItemReviewStatus): Promise<ReverseScanItem[]> {
    let sql = "SELECT * FROM reverse_scan_items WHERE job_id = ?";
    const params: unknown[] = [jobId];

    if (reviewStatus) {
      sql += " AND review_status = ?";
      params.push(reviewStatus);
    }
    sql += " ORDER BY confidence DESC, created_at DESC";

    const rows = this.db.prepare(sql).all(...params) as ReverseScanItemRow[];
    return rows.map(itemFromRow);
  }

  async updateReverseScanItem(id: string, patch: UpdateReverseScanItemPatch): Promise<void> {
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [new Date().toISOString()];

    if (patch.reviewStatus !== undefined) {
      sets.push("review_status = ?");
      params.push(patch.reviewStatus);
    }
    if (patch.matchedTmdbId !== undefined) {
      sets.push("matched_tmdb_id = ?");
      params.push(patch.matchedTmdbId);
    }
    if (patch.matchedMediaType !== undefined) {
      sets.push("matched_media_type = ?");
      params.push(patch.matchedMediaType);
    }
    if (patch.matchedTitle !== undefined) {
      sets.push("matched_title = ?");
      params.push(patch.matchedTitle);
    }
    if (patch.reconciledSeasonsJson !== undefined) {
      sets.push("reconciled_seasons_json = ?");
      params.push(patch.reconciledSeasonsJson);
    }
    if (patch.errorReason !== undefined) {
      sets.push("error_reason = ?");
      params.push(patch.errorReason);
    }

    params.push(id);
    this.db.prepare(`UPDATE reverse_scan_items SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }
}

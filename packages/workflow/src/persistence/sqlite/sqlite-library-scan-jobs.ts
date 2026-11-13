import type Database from "better-sqlite3";
import { BaseSqliteModule, type SqliteDbContext } from "../sqlite-context.js";
import type {
  LibraryScanJob,
  LibraryScanJobStatus,
  ScanStepStage,
} from "@media-track/contracts";

/**
 * 影视库扫描作业的 DDL 与独立仓储切片。
 *
 * 独立成文件的原因（除单一职责外）：sqlite-schema.ts 与
 * sqlite-media-library.ts 都受 tools/code-limits-baseline.json 的
 * 「棘轮递减」约束，新功能必须让这些文件变小，而不是往里塞代码。
 * 本文件通过模板插值挂进两处 schema，通过工厂与既有仓储共享同一个
 * better-sqlite3 句柄，不新增任何数据库连接。
 */
export const LIBRARY_SCAN_JOBS_SCHEMA_SQL = `
  -- 扫描进度的唯一事实源 (SSOT)：断线、刷新页面、多实例均可恢复。
  CREATE TABLE IF NOT EXISTS library_scan_jobs (
    id text PRIMARY KEY,
    library_id text NOT NULL,
    account_id text NOT NULL DEFAULT '',
    binding_ids text NOT NULL DEFAULT '[]',
    status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','aborted')),
    stage text,
    message text,
    percent integer NOT NULL DEFAULT 0,
    total_discovered integer NOT NULL DEFAULT 0,
    processed_count integer NOT NULL DEFAULT 0,
    current_title text,
    error text,
    force_full_scan integer NOT NULL DEFAULT 0,
    locked_at text,
    finished_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_library_scan_jobs_lookup
    ON library_scan_jobs (library_id, status, created_at DESC);
`;

export interface CreateLibraryScanJobInput {
  id: string;
  libraryId: string;
  accountId: string;
  bindingIds: string[];
  forceFullScan: boolean;
}

export interface UpdateLibraryScanJobInput {
  status?: LibraryScanJobStatus;
  stage?: ScanStepStage | null;
  message?: string | null;
  percent?: number;
  totalDiscovered?: number;
  processedCount?: number;
  currentTitle?: string | null;
  error?: string | null;
}

function mapScanJobRow(row: Record<string, unknown>): LibraryScanJob {
  let bindingIds: string[] = [];
  try {
    bindingIds = JSON.parse(String(row.binding_ids || "[]")) as string[];
  } catch {
    bindingIds = [];
  }
  return {
    id: String(row.id),
    libraryId: String(row.library_id),
    accountId: String(row.account_id ?? ""),
    bindingIds,
    status: String(row.status) as LibraryScanJobStatus,
    stage: row.stage ? (String(row.stage) as ScanStepStage) : null,
    message: row.message ? String(row.message) : null,
    percent: Number(row.percent ?? 0),
    totalDiscovered: Number(row.total_discovered ?? 0),
    processedCount: Number(row.processed_count ?? 0),
    currentTitle: row.current_title ? String(row.current_title) : null,
    error: row.error ? String(row.error) : null,
    forceFullScan: Boolean(row.force_full_scan),
    lockedAt: row.locked_at ? String(row.locked_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * 扫描作业仓储。只做「读写权威状态」：状态迁移判定在 apps/web 的显式状态机，
 * 事件推送与副作用在 scan route，三者互不侵入。
 */
export class LibraryScanJobStore extends BaseSqliteModule {
  constructor(ctxOrDb: SqliteDbContext | Database.Database) {
    if ("db" in ctxOrDb) {
      super(ctxOrDb);
    } else {
      super({
        db: ctxOrDb,
        now: () => new Date().toISOString(),
        transaction: <T>(fn: () => T) => ctxOrDb.transaction(fn),
      });
    }
  }

  createScanJob(input: CreateLibraryScanJobInput): LibraryScanJob {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO library_scan_jobs
          (id, library_id, account_id, binding_ids, status, percent, force_full_scan, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.libraryId,
        input.accountId,
        JSON.stringify(input.bindingIds),
        input.forceFullScan ? 1 : 0,
        now,
        now,
      );
    return this.getScanJob(input.id)!;
  }

  getScanJob(id: string): LibraryScanJob | null {
    const row = this.db
      .prepare(`SELECT * FROM library_scan_jobs WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapScanJobRow(row) : null;
  }

  getLatestScanJob(libraryId: string): LibraryScanJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM library_scan_jobs
         WHERE library_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(libraryId) as Record<string, unknown> | undefined;
    return row ? mapScanJobRow(row) : null;
  }

  findActiveScanJob(libraryId: string): LibraryScanJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM library_scan_jobs
         WHERE library_id = ? AND status IN ('queued', 'running')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(libraryId) as Record<string, unknown> | undefined;
    return row ? mapScanJobRow(row) : null;
  }

  /** 原子认领：只有 queued 能被置为 running，跨实例也不会重复扫描。 */
  claimScanJob(id: string): boolean {
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE library_scan_jobs
         SET status = 'running', locked_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(now, now, id);
    return result.changes === 1;
  }

  updateScanJob(id: string, patch: UpdateLibraryScanJobInput): LibraryScanJob | null {
    const columns: Array<[keyof UpdateLibraryScanJobInput, string]> = [
      ["status", "status"],
      ["stage", "stage"],
      ["message", "message"],
      ["percent", "percent"],
      ["totalDiscovered", "total_discovered"],
      ["processedCount", "processed_count"],
      ["currentTitle", "current_title"],
      ["error", "error"],
    ];

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of columns) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }

    const now = this.now();
    sets.push("updated_at = ?");
    values.push(now);

    if (patch.status && ["succeeded", "failed", "aborted"].includes(patch.status)) {
      sets.push("finished_at = ?");
      values.push(now);
    }

    values.push(id);
    this.db
      .prepare(`UPDATE library_scan_jobs SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.getScanJob(id);
  }

  /** 停滞回收：进程崩溃后 running 无人推进，落到 failed 终态，杜绝 UI 卡死。 */
  recoverStaleScanJobs(libraryId: string, staleMs: number): number {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE library_scan_jobs
         SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
         WHERE library_id = ? AND status = 'running' AND locked_at IS NOT NULL AND locked_at < ?`,
      )
      .run("扫描进程失联，作业已自动回收", cutoff, cutoff, libraryId, cutoff);
    return result.changes;
  }
}

/**
 * 与既有仓储共享同一个 better-sqlite3 句柄。
 * BaseSqliteModule 的 protected db getter 在运行时就是原型上的普通属性，
 * 因此无需修改任何受棘轮约束的存量文件，也能保持「单连接 + WAL」铁律。
 */
export function createLibraryScanJobStore(host: BaseSqliteModule): LibraryScanJobStore {
  const db = (host as unknown as { db: Database.Database }).db;
  return new LibraryScanJobStore(db);
}

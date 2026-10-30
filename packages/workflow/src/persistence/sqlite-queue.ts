import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { EnqueueJobInput, IJobQueue, Job, JobStatus } from "@media-track/contracts";

/**
 * 纯 SQLite 持久化任务队列（任务单 S1.2，设计见
 * docs/architecture-remediation-and-governance.md §5.1）。
 *
 * 要点：
 * - 零外部依赖：不依赖 pg-boss / Redis / 独立队列容器，一张表 + 一条原子 SQL。
 * - 原子认领：`UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *` 包在
 *   `BEGIN IMMEDIATE` 里——先拿写锁再选任务，跨连接/跨 Worker 也不会重复消费。
 * - 失败退避：10s × (retry_count + 1) 指数退避；达到 max_retries 进死信。
 * - 停滞回收（G10）：status='running' 且 locked_at 超过阈值的任务视为 worker 已死，
 *   重新入队参与认领；重试用尽的进死信并写明原因。没有这条就是静默故障——
 *   worker 中途崩溃会让任务永远停在 running，无人认领且无任何提示。
 *
 * 规约：本类只实现契约端口 IJobQueue，调用方（Features）经 Contracts 依赖，
 * 不直接 import 本文件（依赖方向铁律见治理文档 §3.3）。
 */

/** 判定「worker 已死」的锁超时。一次认领可能跑很久（网盘转存要过 1.2s 漏桶，
 *  数十次调用是常态），所以默认 10 分钟——远长于任何正常任务，又短到崩溃后不会
 *  让用户等太久。调用方可按队列覆盖。 */
export const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;

const QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sys_queue_jobs (
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter')),
  payload_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
  locked_by TEXT,
  locked_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim
  ON sys_queue_jobs(queue_name, status, next_run_at, priority DESC);
`;

interface JobRow {
  id: string;
  queue_name: string;
  status: JobStatus;
  payload_json: string;
  priority: number;
  retry_count: number;
  max_retries: number;
  next_run_at: string;
  locked_by: string | null;
  locked_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 统一为秒精度 "YYYY-MM-DD HH:MM:SS"，与 SQLite `datetime('now')` 同格式，
 * 保证 next_run_at 能直接按字典序与库内时间比较。已是 SQLite 格式的串原样透传。
 */
function toSqliteUtc(value: string): string {
  if (!/[TZ]/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

function mapRow(row: JobRow): Job {
  return {
    id: row.id,
    queueName: row.queue_name,
    status: row.status,
    payload: JSON.parse(row.payload_json) as unknown,
    priority: row.priority,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    nextRunAt: row.next_run_at,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteJobQueue implements IJobQueue {
  constructor(private readonly db: Database.Database) {
    // 写锁冲突时等待而非直接 SQLITE_BUSY（黄金 PRAGMA 之一，S1.3 将统一收敛）
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(QUEUE_SCHEMA);
  }

  enqueue(input: EnqueueJobInput): Job {
    const row = this.db
      .prepare(
        `INSERT INTO sys_queue_jobs
           (id, queue_name, status, payload_json, priority, max_retries, next_run_at)
         VALUES (?, ?, 'queued', ?, ?, ?, COALESCE(?, datetime('now')))
         RETURNING *;`,
      )
      .get(
        randomUUID(),
        input.queueName,
        JSON.stringify(input.payload),
        input.priority ?? 0,
        input.maxRetries ?? 3,
        input.nextRunAt === undefined ? null : toSqliteUtc(input.nextRunAt),
      ) as JobRow;
    return mapRow(row);
  }

  claimNextJob(queueName: string, workerId: string, options?: { staleAfterMs?: number }): Job | null {
    const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_LOCK_MS;
    const staleSeconds = Math.max(1, Math.round(staleAfterMs / 1000));

    // 先在同一个 BEGIN IMMEDIATE 里回收停滞任务。为什么不在 SELECT 里顺手捞过来：
    // 一个反复崩溃的 worker 会让任务无限重新认领（原来的 bug 只是慢一点），所以
    // 回收必须推进 retry_count；而重试用尽的停滞任务不该再被认领，得进死信——
    // 死信是终态且可见，留在 running 才是「无提示」的静默故障。
    //
    // 回收不照搬 reportFailure 的 10s×(n+1) 退避：那是「任务自己失败」的礼遇，
    // 而这里是 worker 死了、任务本身可能没问题，延迟重试没有依据；且毒任务应该
    // 尽快走到死信（终态可见）而不是拖延。重试次数已经兜住总量上限。
    const reap = this.db.prepare(
      `UPDATE sys_queue_jobs
       SET status = CASE WHEN retry_count + 1 >= max_retries THEN 'dead_letter' ELSE 'queued' END,
           retry_count = retry_count + 1,
           next_run_at = datetime('now'),
           error_message = CASE
             WHEN retry_count + 1 >= max_retries THEN 'stale lock reaped: retries exhausted'
             ELSE 'stale lock reaped: worker presumed dead, requeued'
           END,
           locked_by = NULL,
           locked_at = NULL,
           updated_at = datetime('now')
       WHERE queue_name = ?
         AND status = 'running'
         AND locked_at IS NOT NULL
         AND locked_at <= datetime('now', '-' || ? || ' seconds');`,
    );

    const claim = this.db.prepare(
      `UPDATE sys_queue_jobs
       SET status = 'running',
           locked_by = ?,
           locked_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = (
         SELECT id FROM sys_queue_jobs
         WHERE queue_name = ?
           AND status = 'queued'
           AND next_run_at <= datetime('now')
         ORDER BY priority DESC, created_at ASC
         LIMIT 1
       )
       RETURNING *;`,
    );

    // BEGIN IMMEDIATE：先取写锁再选任务，杜绝两个 Worker 选中同一条
    this.db.exec("BEGIN IMMEDIATE");
    try {
      reap.run(queueName, staleSeconds);
      const row = claim.get(workerId, queueName) as JobRow | undefined;
      this.db.exec("COMMIT");
      return row ? mapRow(row) : null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markSucceeded(jobId: string): void {
    this.db
      .prepare(
        `UPDATE sys_queue_jobs
         SET status = 'succeeded', updated_at = datetime('now')
         WHERE id = ? AND status = 'running';`,
      )
      .run(jobId);
  }

  reportFailure(jobId: string, error: Error): void {
    this.db
      .prepare(
        `UPDATE sys_queue_jobs
         SET retry_count = retry_count + 1,
             status = CASE WHEN retry_count + 1 >= max_retries THEN 'dead_letter' ELSE 'queued' END,
             next_run_at = CASE
               WHEN retry_count + 1 >= max_retries THEN next_run_at
               ELSE datetime('now', '+' || (10 * (retry_count + 1)) || ' seconds')
             END,
             error_message = ?,
             locked_by = NULL,
             locked_at = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND status = 'running';`,
      )
      .run(error.message, jobId);
  }
}

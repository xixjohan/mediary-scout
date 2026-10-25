/**
 * 任务队列调度端口。
 *
 * 纯 SQLite 实现见 packages/workflow/src/sqlite-queue.ts（原子认领 + 指数退避 + 死信）。
 * 端口保持中立：不绑定 better-sqlite3，也不绑定任何外部队列（pg-boss / BullMQ）。
 */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "dead_letter";

export interface Job {
  readonly id: string;
  readonly queueName: string;
  readonly status: JobStatus;
  readonly payload: unknown;
  readonly priority: number;
  readonly retryCount: number;
  readonly maxRetries: number;
  /** ISO-8601 UTC 时间串，与 SQLite datetime('now') 同格式，便于直接比较 */
  readonly nextRunAt: string;
  readonly lockedBy: string | null;
  readonly lockedAt: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnqueueJobInput {
  readonly queueName: string;
  readonly payload: unknown;
  readonly priority?: number;
  readonly maxRetries?: number;
  /** 默认立即可执行（datetime('now')） */
  readonly nextRunAt?: string;
}

export interface IJobQueue {
  /** 投递任务，返回落库后的完整 Job */
  enqueue(input: EnqueueJobInput): Job;

  /** 原子认领下一个可执行任务；无任务返回 null。同一任务只会被认领一次。 */
  claimNextJob(queueName: string, workerId: string): Job | null;

  /** 标记成功 */
  markSucceeded(jobId: string): void;

  /** 标记失败：未达 maxRetries 回 queued 并按 10s×(n+1) 指数退避；达到则进死信 */
  reportFailure(jobId: string, error: Error): void;
}

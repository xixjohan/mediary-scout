import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteJobQueue } from "../../src/sqlite-queue.js";

/**
 * SqliteJobQueue 契约测试（任务单 S1.2，设计见
 * docs/architecture-remediation-and-governance.md §5.1）：
 * 纯内存 SQLite，毫秒级；覆盖认领唯一性、优先级、退避、死信与跨连接原子性。
 */
describe("SqliteJobQueue", () => {
  it("enqueue 落库默认值正确，claim 后状态变为 running 并记录 worker", () => {
    const db = new Database(":memory:");
    const queue = new SqliteJobQueue(db);

    const job = queue.enqueue({ queueName: "acquire", payload: { tmdbId: 1399 } });
    expect(job.status).toBe("queued");
    expect(job.priority).toBe(0);
    expect(job.maxRetries).toBe(3);
    expect(job.retryCount).toBe(0);
    expect(job.payload).toEqual({ tmdbId: 1399 });
    expect(job.lockedBy).toBeNull();

    const claimed = queue.claimNextJob("acquire", "worker-1");
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.lockedBy).toBe("worker-1");
    expect(claimed?.lockedAt).not.toBeNull();
  });

  it("空队列（或任务未到期）claim 返回 null", () => {
    const db = new Database(":memory:");
    const queue = new SqliteJobQueue(db);
    expect(queue.claimNextJob("acquire", "worker-1")).toBeNull();

    queue.enqueue({ queueName: "acquire", payload: 1, nextRunAt: "2099-01-01 00:00:00" });
    expect(queue.claimNextJob("acquire", "worker-1")).toBeNull();

    // 到期后（白盒把 next_run_at 拨回过去）即可认领
    db.prepare("UPDATE sys_queue_jobs SET next_run_at = datetime('now', '-1 minute')").run();
    expect(queue.claimNextJob("acquire", "worker-1")?.status).toBe("running");
  });

  it("按 priority DESC、同优先级按入队顺序认领", () => {
    const db = new Database(":memory:");
    const queue = new SqliteJobQueue(db);

    const low = queue.enqueue({ queueName: "acquire", payload: "low", priority: 1 });
    const high1 = queue.enqueue({ queueName: "acquire", payload: "high1", priority: 5 });
    const high2 = queue.enqueue({ queueName: "acquire", payload: "high2", priority: 5 });

    const first = queue.claimNextJob("acquire", "w");
    const second = queue.claimNextJob("acquire", "w");
    const third = queue.claimNextJob("acquire", "w");

    expect(first?.priority).toBe(5);
    expect(second?.priority).toBe(5);
    expect(new Set([first?.id, second?.id])).toEqual(new Set([high1.id, high2.id]));
    expect(third?.id).toBe(low.id);
  });

  it("每个任务只会被认领一次，认领完再 claim 返回 null", () => {
    const db = new Database(":memory:");
    const queue = new SqliteJobQueue(db);
    queue.enqueue({ queueName: "acquire", payload: 1 });
    queue.enqueue({ queueName: "acquire", payload: 2 });

    const ids = [queue.claimNextJob("acquire", "w")?.id, queue.claimNextJob("acquire", "w")?.id];
    expect(new Set(ids).size).toBe(2);
    expect(queue.claimNextJob("acquire", "w")).toBeNull();
  });

  it("markSucceeded 后状态为 succeeded，不再参与认领", () => {
    const db = new Database(":memory:");
    const queue = new SqliteJobQueue(db);
    const job = queue.enqueue({ queueName: "acquire", payload: 1 });
    const claimed = queue.claimNextJob("acquire", "w");
    queue.markSucceeded(claimed!.id);

    const row = db.prepare("SELECT status FROM sys_queue_jobs WHERE id = ?").get(job.id) as { status: string };
    expect(row.status).toBe("succeeded");
    expect(queue.claimNextJob("acquire", "w")).toBeNull();
  });

  it("reportFailure 未达上限：retry+1、回 queued、按 10s×(n+1) 指数退避", () => {
    const db = new Database(":memory:");
    const queue = new SqliteJobQueue(db);
    const job = queue.enqueue({ queueName: "acquire", payload: 1, maxRetries: 3 });
    queue.claimNextJob("acquire", "w");
    queue.reportFailure(job.id, new Error("transient boom"));

    const row = db
      .prepare(
        `SELECT status, retry_count, error_message,
                next_run_at BETWEEN datetime('now', '+5 seconds') AND datetime('now', '+11 seconds') AS backed_off
         FROM sys_queue_jobs WHERE id = ?`,
      )
      .get(job.id) as { status: string; retry_count: number; error_message: string; backed_off: number };
    expect(row.status).toBe("queued");
    expect(row.retry_count).toBe(1);
    expect(row.error_message).toBe("transient boom");
    expect(row.backed_off).toBe(1);
  });

  it("reportFailure 达到 max_retries：进入 dead_letter 且锁定被释放", () => {
    const db = new Database(":memory:");
    const queue = new SqliteJobQueue(db);
    const job = queue.enqueue({ queueName: "acquire", payload: 1, maxRetries: 1 });
    queue.claimNextJob("acquire", "w");
    queue.reportFailure(job.id, new Error("fatal"));

    const row = db
      .prepare("SELECT status, locked_by FROM sys_queue_jobs WHERE id = ?")
      .get(job.id) as { status: string; locked_by: string | null };
    expect(row.status).toBe("dead_letter");
    expect(row.locked_by).toBeNull();
    expect(queue.claimNextJob("acquire", "w")).toBeNull();
  });

  it("跨连接并发认领：BEGIN IMMEDIATE 保证同一任务只归一个 worker", () => {
    const file = join(tmpdir(), `sqlite-queue-${randomUUID()}.db`);
    const dbA = new Database(file);
    const dbB = new Database(file);
    const queueA = new SqliteJobQueue(dbA);
    const queueB = new SqliteJobQueue(dbB);
    try {
      for (let i = 0; i < 5; i += 1) {
        queueA.enqueue({ queueName: "acquire", payload: i });
      }
      const claimed: string[] = [];
      for (let turn = 0; turn < 5; turn += 1) {
        const fromA = queueA.claimNextJob("acquire", "worker-A");
        const fromB = queueB.claimNextJob("acquire", "worker-B");
        if (fromA) claimed.push(fromA.id);
        if (fromB) claimed.push(fromB.id);
      }
      expect(claimed).toHaveLength(5);
      expect(new Set(claimed).size).toBe(5);
      expect(queueA.claimNextJob("acquire", "worker-A")).toBeNull();
      expect(queueB.claimNextJob("acquire", "worker-B")).toBeNull();
    } finally {
      dbA.close();
      dbB.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${file}${suffix}`, { force: true });
      }
    }
  });
});

/**
 * G10 停滞任务回收。
 *
 * 静默故障：worker 在中途崩溃（进程被杀、OOM、未捕获异常没走到 reportFailure），
 * 任务永远停在 status='running' + locked_at。而 claimNextJob 只选 status='queued'
 * ——于是「某个任务永远不跑且无提示」。手动模式会大幅增加长时挂起任务数，不补会把
 * 问题放大。
 */
describe("SqliteJobQueue 停滞锁回收（G10）", () => {
  /** 直接把一行改成指定状态，模拟 worker 崩溃后的残留。 */
  function forceState(
    db: Database.Database,
    jobId: string,
    state: { status: string; lockedAt: string | null; retryCount?: number },
  ): void {
    db.prepare(
      `UPDATE sys_queue_jobs SET status = ?, locked_at = ?, locked_by = ?, retry_count = COALESCE(?, retry_count) WHERE id = ?`,
    ).run(state.status, state.lockedAt, state.lockedAt === null ? null : "worker-dead", state.retryCount ?? null, jobId);
  }

  /** 库内当前时间（SQLite datetime('now')），用于算超阈值的 locked_at。 */
  function dbNow(db: Database.Database): string {
    return (db.prepare(`SELECT datetime('now') AS n`).get() as { n: string }).n;
  }

  it("running 且 locked_at 未超阈值 → 不回收，仍归原 worker", () => {
    const db = new Database(":memory:");
    const queue = new SqliteJobQueue(db);
    const job = queue.enqueue({ queueName: "acquire", payload: {} });
    forceState(db, job.id, { status: "running", lockedAt: dbNow(db) });

    expect(queue.claimNextJob("acquire", "worker-2")).toBeNull();
  });

  it("running 且 locked_at 超阈值 → 被重新认领（G10 核心）", () => {
    const db = new Database(":memory:");
    const queue = new SqliteJobQueue(db);
    const job = queue.enqueue({ queueName: "acquire", payload: {} });
    // 2 小时前锁的，远超任何合理阈值
    forceState(db, job.id, { status: "running", lockedAt: "2000-01-01 00:00:00" });

    const reclaimed = queue.claimNextJob("acquire", "worker-2");
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.status).toBe("running");
    expect(reclaimed?.lockedBy).toBe("worker-2");
    expect(reclaimed?.lockedAt).not.toBe("2000-01-01 00:00:00");
  });

  it("回收会推进 retry_count（worker 反复崩溃不能无限重试）", () => {
    const db = new Database(":memory:");
    const queue = new SqliteJobQueue(db);
    const job = queue.enqueue({ queueName: "acquire", payload: {}, maxRetries: 3 });
    forceState(db, job.id, { status: "running", lockedAt: "2000-01-01 00:00:00" });

    const first = queue.claimNextJob("acquire", "w1");
    expect(first?.retryCount).toBe(1);
  });

  it("回收后再次崩溃仍可再回收，直到用尽重试", () => {
    const db = new Database(":memory:");
    const queue = new SqliteJobQueue(db);
    const job = queue.enqueue({ queueName: "acquire", payload: {}, maxRetries: 2 });
    forceState(db, job.id, { status: "running", lockedAt: "2000-01-01 00:00:00" });

    // 第 1 次回收：retry 0 → 1，仍未用尽
    expect(queue.claimNextJob("acquire", "w1")?.retryCount).toBe(1);
    // 再次崩溃
    forceState(db, job.id, { status: "running", lockedAt: "2000-01-01 00:00:00" });
    // 第 2 次回收：retry 1 → 2，达到 max_retries → 进死信，不再被认领
    const second = queue.claimNextJob("acquire", "w2");
    expect(second).toBeNull();

    const row = db.prepare(`SELECT status, error_message FROM sys_queue_jobs WHERE id = ?`).get(job.id) as {
      status: string;
      error_message: string | null;
    };
    expect(row.status).toBe("dead_letter");
    // 死信必须带原因，否则又是一个「无提示」的静默故障
    expect(row.error_message).toMatch(/stale lock|停滞/i);
  });

  it("queued 任务不受回收逻辑影响（照常认领，retry_count 不变）", () => {
    const db = new Database(":memory:");
    const queue = new SqliteJobQueue(db);
    const job = queue.enqueue({ queueName: "acquire", payload: {} });

    const claimed = queue.claimNextJob("acquire", "worker-1");
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.retryCount).toBe(0);
  });
});

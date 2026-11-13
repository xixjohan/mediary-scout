/**
 * 影视库扫描作业的契约与显式状态机。
 *
 * 设计对齐 docs/research/2026-11-13-library-scan-and-player-ux-performance-research.md §2.3，
 * 以及 packages/workflow/src/acquisition-v2/run-state-machine.ts 的分层原则：
 *   - 状态机只回答「当前在哪、这个事件是否合法、下一步去哪」，不执行任何副作用；
 *   - 副作用（写库、发 SSE、刷新网盘）由调用方（scan route）负责。
 *
 * 与旧实现的根本差异：终态与进度以 SQLite library_scan_jobs 表为唯一事实源 (SSOT)，
 * SSE 只是低延迟加速通道，不再是判定「扫描是否结束」的唯一依据。
 */
import type {
  LibraryScanProgressEvent,
  LibraryScanJob,
  LibraryScanJobStatus,
  ScanStepStage,
} from "@media-track/contracts";

export type { LibraryScanJob, LibraryScanJobStatus } from "@media-track/contracts";

export type ScanJobEvent =
  | { type: "CLAIM" }
  | { type: "PROGRESS" }
  | { type: "COMPLETE" }
  | { type: "FAIL"; reason: string }
  | { type: "ABORT" }
  | { type: "RECOVER" };

/** 停滞作业锁超时：进程崩溃后无人认领的 running 作业，超过该阈值视为已死。 */
export const STALE_SCAN_JOB_MS = 10 * 60 * 1000;

/** 轮询间隔：与项目内 reverse_scan_jobs 已上线范式保持一致。 */
export const SCAN_JOB_POLL_INTERVAL_MS = 1500;

/**
 * 显式迁移表。终态不接受任何事件——这保证「完成」不会被迟到的进度事件覆盖，
 * 也避免多个 binding 各自 emit 一次 COMPLETED 造成提前结束。
 */
const TRANSITIONS: Record<LibraryScanJobStatus, Partial<Record<ScanJobEvent["type"], LibraryScanJobStatus>>> = {
  queued: {
    CLAIM: "running",
    FAIL: "failed",
    ABORT: "aborted",
  },
  running: {
    PROGRESS: "running",
    COMPLETE: "succeeded",
    FAIL: "failed",
    ABORT: "aborted",
    RECOVER: "failed",
  },
  succeeded: {},
  failed: {},
  aborted: {},
};

export function transitionScanJob(
  from: LibraryScanJobStatus,
  event: ScanJobEvent,
): LibraryScanJobStatus | null {
  return TRANSITIONS[from][event.type] ?? null;
}

export function isTerminalScanJobStatus(status: LibraryScanJobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "aborted";
}

export function isActiveScanJobStatus(status: LibraryScanJobStatus): boolean {
  return status === "queued" || status === "running";
}

/** 把权威作业状态映射成既有进度条组件可消费的事件，避免前端另写一套渲染。 */
export function mapJobToProgressEvent(job: LibraryScanJob): LibraryScanProgressEvent {
  const terminalStage: ScanStepStage =
    job.status === "failed" ? "FAILED" : job.status === "aborted" ? "ABORTED" : "COMPLETED";
  const stage: ScanStepStage = isTerminalScanJobStatus(job.status)
    ? terminalStage
    : job.stage ?? "DISCOVERING_FOLDERS";

  return {
    libraryId: job.libraryId,
    stage,
    message: job.message ?? (isTerminalScanJobStatus(job.status) ? "扫描已结束" : "正在扫描..."),
    totalDiscovered: job.totalDiscovered,
    processedCount: job.processedCount,
    percent: job.percent,
    currentTitle: job.currentTitle ?? undefined,
    error: job.error ?? undefined,
    timestamp: job.updatedAt,
  };
}

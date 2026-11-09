import { StrmScanner, resolveEffectiveStrmBaseUrl, type StrmScanResult } from "@media-track/workflow";
import {
  getWorkflowRepository,
  getMediaServerCoordinator,
} from "../../../composition/runtime-container";
import { getAccountDriveFileManager } from "../../storage-drives";

export interface StrmScanExecutionResult {
  ok: boolean;
  scanResult?: StrmScanResult | undefined;
  recordId?: string | undefined;
  errorMessage?: string | undefined;
}

function createProgressReporter(
  repo: ReturnType<typeof getWorkflowRepository>,
  recordId: string | undefined,
) {
  let lastProgressWrite = 0;
  return async (p: any) => {
    const now = Date.now();
    if ((p.percent === 100 || p.percent <= 5 || now - lastProgressWrite >= 300) && recordId) {
      lastProgressWrite = now;
      await repo
        .updateStrmExecutionRecord({
          id: recordId,
          currentProgressPercent: p.percent,
          currentStepMessage: p.message ?? null,
          scannedCount: p.scannedCount,
          generatedCount: p.generatedCount,
          updatedCount: p.updatedCount,
          removedCount: p.removedCount,
        })
        .catch(() => {});
    }
  };
}

async function finishScanSuccess(
  repo: ReturnType<typeof getWorkflowRepository>,
  taskId: string,
  accountId: string,
  recordId: string | undefined,
  scanResult: StrmScanResult,
  startTime: number,
) {
  await repo.updateStrmTask({
    id: taskId,
    accountId,
    status: "idle",
    lastScanAt: new Date().toISOString(),
    lastScanStatus: "succeeded",
    lastErrorMessage: null,
  });

  if (recordId) {
    await repo
      .updateStrmExecutionRecord({
        id: recordId,
        status: "succeeded",
        currentProgressPercent: 100,
        currentStepMessage: scanResult.protectReason ?? "扫描同步完成",
        scannedCount: scanResult.scannedCount,
        generatedCount: scanResult.generatedCount,
        updatedCount: scanResult.updatedCount,
        removedCount: scanResult.removedCount,
        durationMs: Date.now() - startTime,
      })
      .catch(() => {});
  }

  if (scanResult.generatedPaths.length > 0) {
    getMediaServerCoordinator().notifyFilesChanged(accountId, scanResult.generatedPaths);
  }
}

async function finishScanFailure(
  repo: ReturnType<typeof getWorkflowRepository>,
  taskId: string,
  accountId: string,
  recordId: string | undefined,
  errorMsg: string,
  startTime: number,
) {
  await repo
    .updateStrmTask({
      id: taskId,
      accountId,
      status: "error",
      lastScanAt: new Date().toISOString(),
      lastScanStatus: "failed",
      lastErrorMessage: errorMsg,
    })
    .catch(() => {});

  if (recordId) {
    await repo
      .updateStrmExecutionRecord({
        id: recordId,
        status: "failed",
        errorMessage: errorMsg,
        durationMs: Date.now() - startTime,
      })
      .catch(() => {});
  }
}

export async function executeStrmTaskScan(
  taskId: string,
  accountId: string,
  options?: {
    triggerSource?: "manual" | "interval";
    baseUrl?: string;
  },
): Promise<StrmScanExecutionResult> {
  const repo = getWorkflowRepository();
  const task = await repo.getStrmTask(taskId, accountId);
  if (!task) {
    return { ok: false, errorMessage: "STRM 任务不存在" };
  }

  const triggerSource = options?.triggerSource ?? "manual";
  const baseUrl = await resolveEffectiveStrmBaseUrl(repo, options?.baseUrl);
  const scanner = new StrmScanner();
  const startTime = Date.now();
  let recordId: string | undefined;

  try {
    try {
      const rec = await repo.createStrmExecutionRecord({
        taskId: task.id,
        taskName: task.name,
        accountId,
        triggerSource,
        status: "running",
        currentProgressPercent: 0,
        currentStepMessage: "任务启动中...",
      });
      recordId = rec.id;
    } catch {
      // non-blocking
    }

    await repo.updateStrmTask({
      id: task.id,
      accountId,
      status: "running",
    });

    const fileManager = await getAccountDriveFileManager(accountId, task.storageId);
    if (!fileManager) {
      if (recordId) {
        await repo
          .updateStrmExecutionRecord({
            id: recordId,
            status: "failed",
            errorMessage: "网盘未连接或凭据已失效",
            durationMs: Date.now() - startTime,
          })
          .catch(() => {});
      }
      return { ok: false, errorMessage: "网盘未连接或凭据已失效" };
    }

    const onProgress = createProgressReporter(repo, recordId);
    const scanResult = await scanner.runScan({
      task,
      storage: fileManager,
      baseUrl,
      onProgress,
    });

    await finishScanSuccess(repo, task.id, accountId, recordId, scanResult, startTime);
    return { ok: true, scanResult, recordId };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await finishScanFailure(repo, task.id, accountId, recordId, errorMsg, startTime);
    return { ok: false, errorMessage: errorMsg, recordId };
  }
}

/**
 * 扫描并执行所有到期的周期性 STRM 任务
 */
export async function runDueStrmTasks(accountId?: string): Promise<number> {
  const repo = getWorkflowRepository();
  const targetAccountId = accountId ?? "acct_default";
  let count = 0;
  try {
    const tasks = await repo.listStrmTasks(targetAccountId);
    const activeTasks = tasks.filter((t) => t.status !== "paused" && t.isActive);
    const now = Date.now();

    for (const task of activeTasks) {
      const intervalMs = (task.scanIntervalMinutes || 360) * 60 * 1000;
      const lastScanTime = task.lastScanAt ? Date.parse(task.lastScanAt) : 0;
      if (now - lastScanTime >= intervalMs) {
        await executeStrmTaskScan(task.id, targetAccountId, { triggerSource: "interval" });
        count++;
      }
    }
  } catch (err) {
    console.error("[runDueStrmTasks] failed:", err);
  }
  return count;
}

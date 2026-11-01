import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../../../lib/auth-chain";
import {
  getWorkflowRepository,
  getAccountDriveFileManager,
} from "../../../../../../lib/workflow-runtime";
import { getMediaServerCoordinator } from "../../../../../../composition/runtime-container";
import { StrmScanner } from "@media-track/workflow";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const { id } = await context.params;
  const repo = getWorkflowRepository();
  const task = await repo.getStrmTask(id, accountId);
  if (!task) {
    return NextResponse.json({ error: "STRM 任务不存在" }, { status: 404 });
  }

  const origin = request.nextUrl.origin || "http://localhost:3000";
  const scanner = new StrmScanner();
  const startTime = Date.now();
  let recordId: string | undefined;

  try {
    // 1. 创建执行记录
    try {
      const rec = await repo.createStrmExecutionRecord({
        taskId: task.id,
        taskName: task.name,
        accountId,
        triggerSource: "manual",
        status: "running",
        currentProgressPercent: 0,
        currentStepMessage: "任务启动中...",
      });
      recordId = rec.id;
    } catch {
      // non-blocking
    }

    // 2. 标记任务运行中
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
      return NextResponse.json({ error: "网盘未连接或凭据已失效" }, { status: 400 });
    }

    let lastProgressWrite = 0;
    const scanResult = await scanner.runScan({
      task,
      storage: fileManager,
      baseUrl: origin,
      onProgress: async (p) => {
        const now = Date.now();
        if (p.percent === 100 || p.percent <= 5 || now - lastProgressWrite >= 300) {
          lastProgressWrite = now;
          if (recordId) {
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
        }
      },
    });

    const durationMs = Date.now() - startTime;

    // 3. 更新任务状态
    await repo.updateStrmTask({
      id: task.id,
      accountId,
      status: "idle",
      lastScanAt: new Date().toISOString(),
      lastScanStatus: "succeeded",
      lastErrorMessage: null,
    });

    // 4. 更新执行记录状态
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
          durationMs,
        })
        .catch(() => {});
    }

    // 5. 联动媒体服务器自动刷新
    if (scanResult.generatedPaths.length > 0) {
      const coordinator = getMediaServerCoordinator();
      coordinator.notifyFilesChanged(accountId, scanResult.generatedPaths);
    }

    return NextResponse.json({
      ok: true,
      scanResult,
      recordId,
    });
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    await repo.updateStrmTask({
      id: task.id,
      accountId,
      status: "error",
      lastScanAt: new Date().toISOString(),
      lastScanStatus: "failed",
      lastErrorMessage: errorMsg,
    });

    if (recordId) {
      await repo
        .updateStrmExecutionRecord({
          id: recordId,
          status: "failed",
          errorMessage: errorMsg,
          currentStepMessage: errorMsg,
          durationMs,
        })
        .catch(() => {});
    }

    return NextResponse.json(
      { ok: false, error: errorMsg },
      { status: 500 },
    );
  }
}

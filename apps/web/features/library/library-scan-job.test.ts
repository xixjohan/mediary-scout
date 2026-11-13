import { describe, expect, it } from "vitest";
import {
  SCAN_JOB_POLL_INTERVAL_MS,
  STALE_SCAN_JOB_MS,
  isActiveScanJobStatus,
  isTerminalScanJobStatus,
  mapJobToProgressEvent,
  transitionScanJob,
  type LibraryScanJob,
  type LibraryScanJobStatus,
} from "./library-scan-job";

function makeJob(status: LibraryScanJobStatus, overrides: Partial<LibraryScanJob> = {}): LibraryScanJob {
  return {
    id: "job-1",
    libraryId: "lib-1",
    accountId: "acct-1",
    bindingIds: ["binding-1"],
    status,
    stage: "PARSING_FILENAMES",
    message: "正在解析文件名...",
    percent: 40,
    totalDiscovered: 10,
    processedCount: 4,
    currentTitle: "示例剧集 E01",
    forceFullScan: false,
    lockedAt: "2026-11-13T00:00:00.000Z",
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:05.000Z",
    ...overrides,
  };
}

describe("影视库扫描作业状态机", () => {
  it("queued 经 CLAIM 进入 running", () => {
    expect(transitionScanJob("queued", { type: "CLAIM" })).toBe("running");
  });

  it("running 在 PROGRESS 上保持 running，在 COMPLETE 上进入 succeeded", () => {
    expect(transitionScanJob("running", { type: "PROGRESS" })).toBe("running");
    expect(transitionScanJob("running", { type: "COMPLETE" })).toBe("succeeded");
  });

  it("异常路径：queued 与 running 都能迁移到 failed 终态", () => {
    expect(transitionScanJob("queued", { type: "FAIL", reason: "参数错误" })).toBe("failed");
    expect(transitionScanJob("running", { type: "FAIL", reason: "网盘超时" })).toBe("failed");
  });

  it("取消与停滞回收都有确定终态", () => {
    expect(transitionScanJob("queued", { type: "ABORT" })).toBe("aborted");
    expect(transitionScanJob("running", { type: "ABORT" })).toBe("aborted");
    expect(transitionScanJob("running", { type: "RECOVER" })).toBe("failed");
  });

  it("终态是吸收态：迟到的进度事件不能覆盖扫描结果", () => {
    for (const status of ["succeeded", "failed", "aborted"] as LibraryScanJobStatus[]) {
      expect(transitionScanJob(status, { type: "PROGRESS" })).toBeNull();
      expect(transitionScanJob(status, { type: "COMPLETE" })).toBeNull();
      expect(transitionScanJob(status, { type: "CLAIM" })).toBeNull();
    }
  });

  it("非法迁移返回 null（queued 不能直接 COMPLETE）", () => {
    expect(transitionScanJob("queued", { type: "COMPLETE" })).toBeNull();
  });

  it("状态分类辅助函数一致", () => {
    expect(isActiveScanJobStatus("queued")).toBe(true);
    expect(isActiveScanJobStatus("running")).toBe(true);
    expect(isTerminalScanJobStatus("succeeded")).toBe(true);
    expect(isTerminalScanJobStatus("failed")).toBe(true);
    expect(isTerminalScanJobStatus("aborted")).toBe(true);
    expect(isTerminalScanJobStatus("running")).toBe(false);
  });

  it("终态作业映射成对应 SSE stage，失败原因不丢失", () => {
    const failed = makeJob("failed", { error: "网盘接口 403" });
    const event = mapJobToProgressEvent(failed);
    expect(event.stage).toBe("FAILED");
    expect(event.error).toBe("网盘接口 403");
    expect(event.libraryId).toBe("lib-1");
    expect(mapJobToProgressEvent(makeJob("aborted")).stage).toBe("ABORTED");
    expect(mapJobToProgressEvent(makeJob("succeeded")).stage).toBe("COMPLETED");
  });

  it("进行中作业保留持久化的进度字段（断线恢复的前提）", () => {
    const event = mapJobToProgressEvent(makeJob("running"));
    expect(event.stage).toBe("PARSING_FILENAMES");
    expect(event.percent).toBe(40);
    expect(event.totalDiscovered).toBe(10);
    expect(event.processedCount).toBe(4);
    expect(event.currentTitle).toBe("示例剧集 E01");
    expect(event.timestamp).toBe("2026-11-13T00:00:05.000Z");
  });

  it("轮询间隔与停滞阈值取项目既有范式", () => {
    expect(SCAN_JOB_POLL_INTERVAL_MS).toBe(1500);
    expect(STALE_SCAN_JOB_MS).toBe(10 * 60 * 1000);
  });
});

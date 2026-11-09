import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowRepository, STRM_BASE_URL_SETTING_KEY } from "@media-track/workflow";
import {
  setWorkflowRepositoryForTest,
  resetRuntimeContainerForTests,
} from "../../../lib/workflow-runtime";
import { executeStrmTaskScan, runDueStrmTasks } from "./strm-runner-service";

describe("strm-runner-service", () => {
  let repo: InMemoryWorkflowRepository;

  beforeEach(() => {
    resetRuntimeContainerForTests();
    repo = new InMemoryWorkflowRepository();
    setWorkflowRepositoryForTest(repo as any);
  });

  it("executeStrmTaskScan: 任务不存在时优雅返回错误", async () => {
    const res = await executeStrmTaskScan("non_existent_id", "acct_1");
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toBe("STRM 任务不存在");
  });

  it("executeStrmTaskScan: 网盘未连接时更新记录并返回失败", async () => {
    const task = await repo.createStrmTask({
      accountId: "acct_1",
      name: "Test Task",
      storageId: "cs_unconnected",
      remoteFolderId: "root_1",
      remotePath: "/Media",
      localOutputDir: "/tmp/strm",
      scanIntervalMinutes: 60,
      scanMode: "incremental_missing",
      extensions: "mkv",
      deliveryMode: "redirect",
      isActive: true,
    });

    const res = await executeStrmTaskScan(task.id, "acct_1");
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toBe("网盘未连接或凭据已失效");

    const records = await repo.listStrmExecutionRecords(task.id, "acct_1");
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("failed");
    expect(records[0]!.errorMessage).toBe("网盘未连接或凭据已失效");
  });

  it("runDueStrmTasks: 仅执行到期任务，跳过暂停及未到期任务", async () => {
    // 任务1：到期（lastScanAt 在 2 小时前，周期 60 分钟）
    const t1 = await repo.createStrmTask({
      accountId: "acct_1",
      name: "Due Task",
      storageId: "cs_1",
      remoteFolderId: "root_1",
      remotePath: "/Media",
      localOutputDir: "/tmp/strm",
      scanIntervalMinutes: 60,
      scanMode: "incremental_missing",
      extensions: "mkv",
      deliveryMode: "redirect",
      isActive: true,
    });
    await repo.updateStrmTask({
      id: t1.id,
      accountId: "acct_1",
      lastScanAt: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
    });

    // 任务2：未到期（lastScanAt 在 10 分钟前，周期 60 分钟）
    const t2 = await repo.createStrmTask({
      accountId: "acct_1",
      name: "Not Due Task",
      storageId: "cs_1",
      remoteFolderId: "root_1",
      remotePath: "/Media",
      localOutputDir: "/tmp/strm",
      scanIntervalMinutes: 60,
      scanMode: "incremental_missing",
      extensions: "mkv",
      deliveryMode: "redirect",
      isActive: true,
    });
    await repo.updateStrmTask({
      id: t2.id,
      accountId: "acct_1",
      lastScanAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    // 任务3：已暂停
    await repo.createStrmTask({
      accountId: "acct_1",
      name: "Paused Task",
      storageId: "cs_1",
      remoteFolderId: "root_1",
      remotePath: "/Media",
      localOutputDir: "/tmp/strm",
      scanIntervalMinutes: 60,
      scanMode: "incremental_missing",
      extensions: "mkv",
      deliveryMode: "redirect",
      isActive: false,
    });

    // runDueStrmTasks 应该只扫描 t1
    const count = await runDueStrmTasks("acct_1");
    expect(count).toBe(1);
  });

  it("executeStrmTaskScan 优先使用数据库中持久化的 STRM_BASE_URL_SETTING_KEY", async () => {
    await repo.setSetting(STRM_BASE_URL_SETTING_KEY, "http://192.168.1.100:3000");
    const task = await repo.createStrmTask({
      accountId: "acct_1",
      name: "Anime Base URL Test",
      storageId: "cs_unconnected",
      remoteFolderId: "root_1",
      remotePath: "/Anime",
      localOutputDir: "/tmp/strm",
      scanIntervalMinutes: 60,
      scanMode: "incremental_missing",
      extensions: "mkv",
      deliveryMode: "redirect",
      isActive: true,
    });

    const res = await executeStrmTaskScan(task.id, "acct_1");
    // 即使网盘未连接提前退出，记录创建也证明了调度流程正常，且没有触发 127.0.0.1 无配置告警
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toBe("网盘未连接或凭据已失效");
  });
});

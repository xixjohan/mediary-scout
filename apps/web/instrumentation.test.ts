import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 任务单 S2.2：常驻 worker 循环不再默认住在 Next 服务进程里。
 * 门控契约：
 *   - 默认（未设 MODE）→ 进程内循环照旧（桌面 / 单进程兼容）
 *   - MEDIA_TRACK_WORKER_MODE=external → 不启动循环，改由 apps/host-worker 专职
 *     poke；但孤儿恢复（有界一次性）仍留在 web 启动路径
 *   - 旧开关 MEDIA_TRACK_INPROCESS_WORKER=0 等价于 external（兼容老部署）
 *   - 非 nodejs runtime（Edge）→ 什么都不做
 */
const startBackgroundWorker = vi.fn();
const recoverOrphanedRuns = vi.fn(async () => 0);
const runStartupMigrations = vi.fn(async () => {});
const validateRuntimeConfig = vi.fn();

vi.mock("./lib/http-proxy", () => ({
  configureHttpProxyFromEnv: () => ({ enabled: false, proxyDisplay: "" }),
}));
vi.mock("@media-track/workflow", () => ({
  validateRuntimeConfig: (...args: unknown[]) => validateRuntimeConfig(...(args as [])),
}));
vi.mock("./lib/workflow-runtime", () => ({
  runStartupMigrations: (...args: unknown[]) => runStartupMigrations(...(args as [])),
  recoverOrphanedRuns: (...args: unknown[]) => recoverOrphanedRuns(...(args as [])),
}));
vi.mock("./lib/background-worker", () => ({
  startBackgroundWorker: (...args: unknown[]) => startBackgroundWorker(...(args as [])),
}));

async function loadInstrumentation() {
  vi.resetModules();
  return import("./instrumentation");
}

describe("instrumentation worker 模式门控", () => {
  const prev = { ...process.env };

  beforeEach(() => {
    startBackgroundWorker.mockClear();
    recoverOrphanedRuns.mockClear();
    runStartupMigrations.mockClear();
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.MEDIA_TRACK_WORKER_MODE;
    delete process.env.MEDIA_TRACK_INPROCESS_WORKER;
  });

  afterEach(() => {
    process.env = { ...prev };
  });

  it("默认模式：启动进程内循环（桌面/单进程兼容）", async () => {
    const { register } = await loadInstrumentation();
    await register();
    expect(startBackgroundWorker).toHaveBeenCalledTimes(1);
    expect(recoverOrphanedRuns).not.toHaveBeenCalled(); // 循环自己会恢复
    expect(runStartupMigrations).toHaveBeenCalledTimes(1);
  });

  it("external 模式：不启动进程内循环，孤儿恢复改由 web 启动时做一次", async () => {
    process.env.MEDIA_TRACK_WORKER_MODE = "external";
    const { register } = await loadInstrumentation();
    await register();
    expect(startBackgroundWorker).not.toHaveBeenCalled();
    expect(recoverOrphanedRuns).toHaveBeenCalledTimes(1);
    expect(runStartupMigrations).toHaveBeenCalledTimes(1); // 迁移照跑
  });

  it("旧开关 INPROCESS_WORKER=0 等价 external", async () => {
    process.env.MEDIA_TRACK_INPROCESS_WORKER = "0";
    const { register } = await loadInstrumentation();
    await register();
    expect(startBackgroundWorker).not.toHaveBeenCalled();
    expect(recoverOrphanedRuns).toHaveBeenCalledTimes(1);
  });

  it("INPROCESS_WORKER=1 显式开启：即使 MODE=external 也启动（逃生门）", async () => {
    process.env.MEDIA_TRACK_WORKER_MODE = "external";
    process.env.MEDIA_TRACK_INPROCESS_WORKER = "1";
    const { register } = await loadInstrumentation();
    await register();
    expect(startBackgroundWorker).toHaveBeenCalledTimes(1);
  });

  it("Edge runtime：整体跳过", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const { register } = await loadInstrumentation();
    await register();
    expect(startBackgroundWorker).not.toHaveBeenCalled();
    expect(runStartupMigrations).not.toHaveBeenCalled();
  });
});

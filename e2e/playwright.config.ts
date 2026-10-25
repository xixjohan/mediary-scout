import { defineConfig, devices } from "@playwright/test";

/**
 * E2E 配置（任务单 S4.3，治理文档 §7.4）。
 *
 * 基底是**全确定性 fake 栈**：demo 搜索源 + fake 存储 + stub agent + 独立
 * SQLite 文件 + 进程内 worker。不碰真实网盘/TMDB/LLM，因此可在 CI 跑。
 * stub agent 直接报无源，所以断言范围是完整的 UI↔服务端↔DB↔worker 回路：
 * 搜索 → 获取 → 入队 → worker 认领 → 终态 → UI 反映。真实落盘闭环需真实
 * 网盘凭据，属于 scripts/*-e2e.mts 的 live 套件（人工触发）。
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    trace: "off",
    screenshot: "off",
  },
  webServer: {
    command: "npm run e2e:server",
    url: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    // 全确定性 fake 栈：不碰真实网盘 / TMDB / LLM。
    env: {
      MEDIA_TRACK_AGENT_ADAPTER: "fake",
      MEDIA_TRACK_STORAGE_ADAPTER: "fake",
      MEDIA_TRACK_SEARCH_PROVIDER: "demo",
      MEDIA_TRACK_DEMO_SEED: "1",
      MEDIA_TRACK_SQLITE_PATH: process.env.E2E_SQLITE_PATH ?? "./e2e-run/mediary-e2e.db",
      MEDIA_TRACK_WORKER_MODE: "inprocess",
      PORT: "3100",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

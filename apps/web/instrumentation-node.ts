/**
 * Next.js Node.js-specific instrumentation logic.
 * Kept isolated in this file so that Turbopack's Edge runtime compilation
 * never inspects or bundles Node APIs (like node:dns, process.getBuiltinModule, sqlite, etc.).
 */

export async function registerNodeInstrumentation(): Promise<void> {
  // 锁死 IPv4 优先解析：Node 17+ 默认 verbatim (可能返回 IPv6 首位)，在容器/无 IPv6 外网路由环境下
  // 极易导致对国内网盘（如 115/夸克）的请求落入 IPv6 黑洞或触发 connect timeout。
  try {
    const dns = await import("node:dns");
    if (typeof dns.setDefaultResultOrder === "function") {
      dns.setDefaultResultOrder("ipv4first");
    }
  } catch {
    // 忽略特定运行时环境不支持的情况
  }

  // Opt-in outbound proxy: Node's built-in fetch (undici) ignores HTTP_PROXY /
  // HTTPS_PROXY on its own, so a self-hoster behind the GFW who sets them in
  // docker-compose still couldn't reach api.themoviedb.org directly (#68).
  // Install the env-driven dispatcher FIRST (before any outbound fetch) so TMDB /
  // PanSou / Prowlarr calls honor the proxy. No proxy env → installs nothing.
  const { configureHttpProxyFromEnv } = await import("./lib/http-proxy");
  const proxy = configureHttpProxyFromEnv();
  if (proxy.enabled) {
    console.log(`[instrumentation] outbound proxy enabled via env (${proxy.proxyDisplay})`);
  }

  // Fail fast + loud on a runtime misconfig (e.g. MEDIA_TRACK_AGENT_ADAPTER=real)
  // instead of booting a worker that can never drain the queue. Throwing here
  // aborts startup with a clear reason.
  const { validateRuntimeConfig } = await import("@media-track/workflow");
  validateRuntimeConfig(process.env);

  console.log("[instrumentation] register() — running startup migrations + worker");
  const { runStartupMigrations, recoverOrphanedRuns } = await import("./lib/workflow-runtime");
  await runStartupMigrations();

  // P1 解药（任务单 S2.2）：常驻 drain 循环默认不再住在 Next 服务进程里。
  //   MEDIA_TRACK_WORKER_MODE=external   → 循环交给独立宿主 apps/host-worker（compose 部署）
  //   MEDIA_TRACK_INPROCESS_WORKER=0     → 旧开关，等价 external（兼容老部署）
  //   MEDIA_TRACK_INPROCESS_WORKER=1     → 显式逃生门：即使 MODE=external 也进程内跑
  // 默认（都未设）保持进程内循环：桌面端与单进程部署零变化。
  const mode = process.env.MEDIA_TRACK_WORKER_MODE ?? "inprocess";
  const externalWorker = mode === "external" && process.env.MEDIA_TRACK_INPROCESS_WORKER !== "1";
  const legacyOptOut = process.env.MEDIA_TRACK_INPROCESS_WORKER === "0";
  if (externalWorker || legacyOptOut) {
    // 孤儿恢复是有界一次性动作（不是常驻循环），留在 web 启动路径，
    // 保证崩溃恢复不依赖 worker 宿主的首次 poke。
    const recovered = await recoverOrphanedRuns();
    if (recovered > 0) {
      console.log(`[instrumentation] recovered ${recovered} orphaned run(s) after crash`);
    }
    console.log(
      "[instrumentation] worker mode=external — in-process loop NOT started; " +
        "run the dedicated host (apps/host-worker) to drain the queue",
    );
    return;
  }
  const { startBackgroundWorker } = await import("./lib/background-worker");
  startBackgroundWorker();
}

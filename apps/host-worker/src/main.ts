/**
 * Worker 宿主入口（任务单 S2.1）。
 *
 * 常驻 drain 循环从 Next 服务进程（instrumentation.ts）搬到这里：
 * 本进程只做 HTTP poke，不 import 任何业务代码、不碰数据库——
 * web 保留全部逻辑，P1（Next 进程内嵌常驻 Worker）由此解除。
 *
 * 环境变量：
 *   MEDIA_TRACK_WEB_BASE        web 基址（默认 http://127.0.0.1:3000；compose 里 http://web:3000）
 *   MEDIA_TRACK_WORKER_SECRET   与 web 一致（多用户模式必配，否则 poke 全 401）
 *   MEDIA_TRACK_WORKER_POLL_MS  idle 轮询间隔（默认 3000，对齐原进程内循环）
 *   MEDIA_TRACK_WORKER_SWEEP_MS 巡检 poke 最小间隔（默认 900000 = 15 分钟）
 */
import { createWorkerPoker } from "./poker.js";

const baseUrl = (process.env.MEDIA_TRACK_WEB_BASE ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const workerSecret = process.env.MEDIA_TRACK_WORKER_SECRET?.trim() || undefined;
const pollMs = Number(process.env.MEDIA_TRACK_WORKER_POLL_MS ?? 3000);
const sweepEveryMs = Number(process.env.MEDIA_TRACK_WORKER_SWEEP_MS ?? 900_000);

if (process.env.MEDIA_TRACK_MULTI_USER === "1" && !workerSecret) {
  console.warn(
    "[host-worker] WARNING: MEDIA_TRACK_MULTI_USER=1 but MEDIA_TRACK_WORKER_SECRET is unset — " +
      "every poke will be rejected with 401. Set the same secret on web and here.",
  );
}

const poker = createWorkerPoker({
  baseUrl,
  workerSecret,
  pollMs,
  sweepEveryMs,
  fetchImpl: fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (message) => console.log(message),
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[host-worker] ${signal} received — stopping after the current tick`);
    poker.stop();
  });
}

await poker.run();

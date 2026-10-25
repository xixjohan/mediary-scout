/**
 * Worker 宿主（任务单 S2.1）：把常驻 drain 循环搬出 Next 服务进程。
 *
 * 宿主是个极简 poker——HTTP poke web 的 /api/workflows/run-next（认领并跑一个
 * 任务）与 /api/workflows/run-type3（每日巡检，服务端自行按天闸门）。两条路由
 * 本就带 worker secret 鉴权（worker-api-guard.ts），因此宿主零代码共享、零数据库
 * 访问：web 保留全部业务逻辑，常驻循环则完全离开 Next 进程——P1
 * （Next 进程内嵌常驻 Worker）的解药。
 *
 * 语义对齐原进程内循环（apps/web/lib/background-worker.ts）：
 *   - 非 idle（刚跑完一个）立即再 poke，不等节流；
 *   - idle 才睡 pollMs；
 *   - 网络错误不炸进程：记日志 + 退避后继续；
 *   - 巡检按 sweepEveryMs 节流（服务端还有按天闸门，双保险）。
 */
export interface PokerDeps {
  /** web 服务基址，如 http://web:3000（compose 服务名）或 http://127.0.0.1:3000。 */
  baseUrl: string;
  /** 与 web 的 MEDIA_TRACK_WORKER_SECRET 一致；多用户模式必配。 */
  workerSecret: string | undefined;
  /** idle 时的轮询间隔（ms）。 */
  pollMs: number;
  /** 巡检 poke 的最小间隔（ms）。 */
  sweepEveryMs: number;
  /** 可注入的 fetch（测试）。 */
  fetchImpl: typeof fetch;
  /** 可注入的等待（测试）。 */
  sleep: (ms: number) => Promise<void>;
  /** 可注入的时钟（测试）。 */
  now: () => number;
  log: (message: string) => void;
}

export interface WorkerPoker {
  /** 单轮：先按需 poke 巡检，再 drain 到 idle。 */
  tick: () => Promise<void>;
  /** 常驻循环，直到 stop()。 */
  run: () => Promise<void>;
  stop: () => void;
}

export function createWorkerPoker(deps: PokerDeps): WorkerPoker {
  let stopped = false;
  let lastSweepAt = Number.NEGATIVE_INFINITY;

  async function poke(path: string): Promise<{ ok: boolean; status: number; body: string }> {
    const headers: Record<string, string> = {};
    if (deps.workerSecret) {
      headers["x-media-track-worker-secret"] = deps.workerSecret;
    }
    const response = await deps.fetchImpl(`${deps.baseUrl}${path}`, {
      method: "POST",
      headers,
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  }

  function isIdle(body: string): boolean {
    try {
      return (JSON.parse(body) as { status?: string }).status === "idle";
    } catch {
      return false; // 解不动就别当 idle，立刻重试
    }
  }

  async function sweepIfDue(): Promise<void> {
    if (deps.now() - lastSweepAt < deps.sweepEveryMs) {
      return;
    }
    lastSweepAt = deps.now();
    const result = await poke("/api/workflows/run-type3");
    if (!result.ok) {
      deps.log(`[host-worker] sweep poke failed (HTTP ${result.status}): ${result.body.slice(0, 200)}`);
    }
  }

  async function drainOnce(): Promise<void> {
    for (;;) {
      const result = await poke("/api/workflows/run-next");
      if (!result.ok) {
        deps.log(`[host-worker] run-next poke failed (HTTP ${result.status}): ${result.body.slice(0, 200)}`);
        return;
      }
      if (isIdle(result.body)) {
        return;
      }
    }
  }

  async function tick(): Promise<void> {
    try {
      await sweepIfDue();
      await drainOnce();
    } catch (error) {
      // 网络抖动 / web 重启中：绝不炸进程，退避后继续。
      deps.log(`[host-worker] poke error: ${error instanceof Error ? error.message : String(error)}`);
    }
    await deps.sleep(deps.pollMs);
  }

  return {
    tick,
    async run() {
      deps.log(`[host-worker] started — poking ${deps.baseUrl} every ${deps.pollMs}ms`);
      while (!stopped) {
        await tick();
      }
      deps.log("[host-worker] stopped");
    },
    stop() {
      stopped = true;
    },
  };
}

import { describe, expect, it, vi } from "vitest";
import { createWorkerPoker, type PokerDeps } from "../src/poker.js";

/**
 * Worker 宿主（任务单 S2.1）：把常驻 drain 循环搬出 Next 服务进程。
 * 宿主是个极简 poker——HTTP poke web 的 /api/workflows/run-next 与
 * /api/workflows/run-type3（两条路由本就带 worker secret 鉴权），
 * 因此零代码共享、零数据库访问，web 保留全部业务逻辑。
 */
function deps(over: Partial<PokerDeps> = {}): PokerDeps {
  return {
    baseUrl: "http://web:3000",
    workerSecret: "s3cret",
    pollMs: 1000,
    sweepEveryMs: 900_000,
    fetchImpl: async () => new Response(JSON.stringify({ status: "idle" }), { status: 200 }),
    sleep: async () => {},
    now: () => 0,
    log: () => {},
    ...over,
  };
}

describe("worker poker", () => {
  it("idle 时按 pollMs 节流 poke，不 busy-loop", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "idle" })));
    const poker = createWorkerPoker(deps({ sleep, fetchImpl }));
    await poker.tick();
    // 首轮必先 poke 一次巡检（lastSweepAt=-Infinity），再 drain 到 idle
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("非 idle（刚跑完一个）立即再 poke，不等节流", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "succeeded" })))
      .mockResolvedValue(new Response(JSON.stringify({ status: "idle" })));
    const poker = createWorkerPoker(deps({ sleep, fetchImpl }));
    await poker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1); // 只在最终 idle 后睡
  });

  it("poke 带 worker secret 头，指向 run-next", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "idle" })));
    const poker = createWorkerPoker(deps({ fetchImpl }));
    await poker.tick();
    const call = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>).find(([u]) =>
      u.endsWith("/run-next"),
    );
    expect(call).toBeDefined();
    const [url, init] = call as unknown as [string, RequestInit];
    expect(url).toBe("http://web:3000/api/workflows/run-next");
    expect((init.headers as Record<string, string>)["x-media-track-worker-secret"]).toBe("s3cret");
    expect(init.method).toBe("POST");
  });

  it("到点 poke 每日巡检 run-type3（服务端自行按天闸门）", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "idle" })));
    let clock = 0;
    const poker = createWorkerPoker(
      deps({ fetchImpl, now: () => clock, sweepEveryMs: 900_000 }),
    );
    clock = 0;
    await poker.tick(); // 首次：到点（0 - -Infinity >= 间隔）
    clock = 900_001;
    await poker.tick(); // 第二次：间隔已到
    const urls = fetchImpl.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls.filter((u) => u.endsWith("/run-type3")).length).toBeGreaterThanOrEqual(2);
  });

  it("未到点不 poke 巡检", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "idle" })));
    let clock = 0;
    const poker = createWorkerPoker(deps({ fetchImpl, now: () => clock, sweepEveryMs: 900_000 }));
    await poker.tick();
    clock = 60_000; // 1 分钟后
    await poker.tick();
    const urls = fetchImpl.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls.filter((u) => u.endsWith("/run-type3"))).toHaveLength(1);
  });

  it("网络错误不炸进程：记录并退避后继续", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const poker = createWorkerPoker(deps({ fetchImpl, sleep, log }));
    await expect(poker.tick()).resolves.toBeUndefined(); // 不 throw
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
    expect(sleep).toHaveBeenCalled();
  });

  it("401/403（secret 不配）明确报错但不退出", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const log = vi.fn();
    const poker = createWorkerPoker(deps({ fetchImpl, log }));
    await poker.tick();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("401"));
  });

  it("stop() 后 loop 退出", async () => {
    const poker = createWorkerPoker(deps());
    const loop = poker.run();
    poker.stop();
    await loop; // 必须 resolve，不能挂住
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createBrandPacer,
  LeakyBucketPacer,
  TokenBucketPacer,
  type Pacer,
} from "./rate-limiter.js";

/**
 * 任务单 S3.3（P13：115 并发风暴封号风险）：可复用的限速原语。
 * 治理文档参数：115 = 漏桶 1.2s/发（burst 1）；夸克 = 令牌桶 3/s（burst 5）。
 * 纯逻辑 + 注入时钟/等待 → 确定性单测，不依赖真实时间。
 */
function harness() {
  let now = 0;
  const slept: number[] = [];
  const clock = () => now;
  const sleep = async (ms: number) => {
    slept.push(ms);
    now += ms; // 睡眠推进时钟（真实语义）
  };
  const advance = (ms: number) => {
    now += ms;
  };
  return { clock, sleep, slept, advance };
}

describe("LeakyBucketPacer", () => {
  it("两次调用至少间隔 interval（115 的 1.2s）", async () => {
    const h = harness();
    const pacer = new LeakyBucketPacer({ intervalMs: 1200, clock: h.clock, sleep: h.sleep });
    await pacer.wait();
    await pacer.wait();
    expect(h.slept).toEqual([1200]);
  });

  it("间隔已过则不睡（首发与久隔后都零等待）", async () => {
    const h = harness();
    const pacer = new LeakyBucketPacer({ intervalMs: 1200, clock: h.clock, sleep: h.sleep });
    await pacer.wait(); // 首发：无历史，不睡
    h.advance(5000); // 远超间隔
    await pacer.wait(); // 不睡
    expect(h.slept).toEqual([]);
  });

  it("并发等待按顺序放行（第 N 个等待者面对第 N-1 个的放行时刻）", async () => {
    const h = harness();
    const pacer = new LeakyBucketPacer({ intervalMs: 1000, clock: h.clock, sleep: h.sleep });
    await Promise.all([pacer.wait(), pacer.wait(), pacer.wait()]);
    expect(h.slept).toEqual([1000, 1000]);
    // 三次调用总耗时 ≈ 2 个间隔
    expect(h.clock()).toBe(2000);
  });
});

describe("TokenBucketPacer", () => {
  it("burst 内不睡，超出才按速率等待（夸克 3/s burst 5）", async () => {
    const h = harness();
    const pacer = new TokenBucketPacer({ perSecond: 3, burst: 5, clock: h.clock, sleep: h.sleep });
    for (let i = 0; i < 5; i += 1) await pacer.wait();
    expect(h.slept).toEqual([]); // 5 发都在 burst 里
    await pacer.wait(); // 第 6 发：桶空，等 1/3s
    expect(h.slept).toEqual([333]);
  });

  it("令牌随时间恢复", async () => {
    const h = harness();
    const pacer = new TokenBucketPacer({ perSecond: 2, burst: 2, clock: h.clock, sleep: h.sleep });
    await pacer.wait();
    await pacer.wait();
    h.advance(1000); // 1 秒恢复 2 个令牌
    await pacer.wait();
    await pacer.wait();
    expect(h.slept).toEqual([]);
  });
});

describe("createBrandPacer", () => {
  it("pan115 → 漏桶 1.2s", () => {
    const pacer = createBrandPacer("pan115", { clock: () => 0, sleep: async () => {} });
    expect(pacer).toBeInstanceOf(LeakyBucketPacer);
  });

  it("quark → 令牌桶 3/s burst 5", () => {
    const pacer = createBrandPacer("quark", { clock: () => 0, sleep: async () => {} });
    expect(pacer).toBeInstanceOf(TokenBucketPacer);
  });

  it("未登记品牌 → 空操作（不改变行为）", async () => {
    const pacer = createBrandPacer("some-new-brand", { clock: () => 0, sleep: async () => {} });
    await pacer.wait();
    expect(pacer.kind).toBe("noop");
  });

  it("Pacer 接口统一：wait() 返回 Promise", () => {
    const pacer: Pacer = createBrandPacer("pan115", { clock: () => 0, sleep: async () => {} });
    expect(typeof pacer.wait).toBe("function");
  });
});

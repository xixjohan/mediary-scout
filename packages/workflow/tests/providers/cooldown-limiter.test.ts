import { describe, expect, it } from "vitest";
import { CooldownLimiter } from "../../src/providers/cooldown-limiter.js";

/**
 * 60s 限流的两个方向都要测：放行，以及**拒绝不延长冷却**。
 *
 * 后半段是最容易写错的：如果被拒的尝试也去盖时间戳，用户连点按钮会把自己锁死在
 * 冷却里——一个「防刷」的设计变成了惩罚好奇心的设计。
 */

const COOLDOWN = 60_000;

function fakeClock(startAt = 1_700_000_000_000) {
  let t = startAt;
  return {
    now: () => t,
    advance(ms: number): void {
      t += ms;
    },
  };
}

describe("CooldownLimiter — 冷却期内拒绝", () => {
  it("首次放行并盖章", () => {
    const clock = fakeClock();
    const limiter = new CooldownLimiter({ now: clock.now, cooldownMs: COOLDOWN });
    expect(limiter.tryAcquire("k")).toBe(true);
    expect(limiter.size).toBe(1);
  });

  it("冷却期内第二次被拒", () => {
    const clock = fakeClock();
    const limiter = new CooldownLimiter({ now: clock.now, cooldownMs: COOLDOWN });
    expect(limiter.tryAcquire("k")).toBe(true);
    clock.advance(COOLDOWN - 1);
    expect(limiter.tryAcquire("k")).toBe(false);
  });

  it("刚好到冷却时长即放行（>= 边界）", () => {
    const clock = fakeClock();
    const limiter = new CooldownLimiter({ now: clock.now, cooldownMs: COOLDOWN });
    expect(limiter.tryAcquire("k")).toBe(true);
    clock.advance(COOLDOWN);
    expect(limiter.tryAcquire("k")).toBe(true);
  });
});

describe("CooldownLimiter — 被拒不延长冷却", () => {
  it("连点被拒后，仍按最初那次的时间点解冻", () => {
    const clock = fakeClock();
    const limiter = new CooldownLimiter({ now: clock.now, cooldownMs: COOLDOWN });
    expect(limiter.tryAcquire("k")).toBe(true);

    // 用户在冷却期内连点 5 次
    for (let i = 0; i < 5; i += 1) {
      clock.advance(1000);
      expect(limiter.tryAcquire("k"), `第 ${i + 1} 次连点应被拒`).toBe(false);
    }

    // 推进到距最初那次正好 60s
    clock.advance(COOLDOWN - 5000);
    expect(limiter.tryAcquire("k"), "连点不应把解冻时间推后").toBe(true);
  });

  it("remainingMs 反映剩余冷却，供 Retry-After 使用", () => {
    const clock = fakeClock();
    const limiter = new CooldownLimiter({ now: clock.now, cooldownMs: COOLDOWN });
    expect(limiter.remainingMs("k")).toBe(0); // 从未用过

    limiter.tryAcquire("k");
    clock.advance(10_000);
    expect(limiter.remainingMs("k")).toBe(50_000);

    clock.advance(50_000);
    expect(limiter.remainingMs("k")).toBe(0);
  });
});

describe("CooldownLimiter — 键隔离与重置", () => {
  it("不同 key 互不影响", () => {
    const clock = fakeClock();
    const limiter = new CooldownLimiter({ now: clock.now, cooldownMs: COOLDOWN });
    expect(limiter.tryAcquire("a")).toBe(true);
    expect(limiter.tryAcquire("b")).toBe(true);
    expect(limiter.tryAcquire("a")).toBe(false);
  });

  it("reset 清掉盖章（成功动作不应被自己的冷却挡住）", () => {
    const clock = fakeClock();
    const limiter = new CooldownLimiter({ now: clock.now, cooldownMs: COOLDOWN });
    limiter.tryAcquire("k");
    limiter.reset("k");
    expect(limiter.remainingMs("k")).toBe(0);
    expect(limiter.tryAcquire("k")).toBe(true);
  });

  it("cooldownMs 非正数直接抛错", () => {
    expect(() => new CooldownLimiter({ now: () => 0, cooldownMs: 0 })).toThrow(/cooldownMs/);
  });
});

import { describe, expect, it } from "vitest";
import { drivePacer, type DriveClock } from "../src/drive-pacer.js";
import { getStorageBrand, STORAGE_BRANDS, type StorageProvider } from "../src/index.js";

/**
 * 网盘调用间隔是注册表数据，不是散落的 `provider === "pan123"` 硬判。
 *
 * 计划 §2.3 点名这是风控缺口：`withBrandPacing` 对未登记品牌「零包装」，
 * 新驱动默认不限速——那是封号风险的入口。所以间隔必须显式登记在每个
 * 品牌的条目里，且**必填**：加一家网盘时逼你回答「这家要不要限速」。
 */

/** A clock that records sleeps and advances virtual time — no real waiting. */
function fakeClock(): DriveClock & { now: number; slept: number[] } {
  const clock = {
    now: 0,
    slept: [] as number[],
    sleep: async (ms: number) => {
      clock.slept.push(ms);
      clock.now += ms;
    },
  };
  // DriveClock.now() is a method; the fake's property is convenient to read.
  return {
    now: () => clock.now,
    sleep: clock.sleep,
    get slept() {
      return clock.slept;
    },
  } as DriveClock & { now: number; slept: number[] };
}

describe("网盘调用间隔来自注册表", () => {
  it("每个品牌都显式登记了 minApiIntervalMs（必填，逼迫新品牌回答限速问题）", () => {
    for (const brand of STORAGE_BRANDS) {
      expect(typeof brand.minApiIntervalMs, `${brand.provider} 未登记调用间隔`).toBe("number");
    }
  });

  it("123 登记了 1500ms（它用 code=100011 请勿频繁操作 回应突发）", () => {
    expect(getStorageBrand("pan123").minApiIntervalMs).toBe(1500);
  });

  it("其余品牌为 0——它们在自己的 client 内部限速，不能再被外层二次限速", () => {
    for (const brand of STORAGE_BRANDS) {
      if (brand.provider === "pan123") continue;
      expect(brand.minApiIntervalMs, `${brand.provider} 会被二次限速`).toBe(0);
    }
  });

  it("drivePacer 按注册表值决定间隔：123 第二次调用前等待", async () => {
    const clock = fakeClock();
    const pace = drivePacer("pan123", clock);
    await pace(async () => "first"); // 首次不等
    await pace(async () => "second");
    expect(clock.slept).toEqual([1500]);
  });

  it("drivePacer 对不限速的品牌不等待", async () => {
    const clock = fakeClock();
    const pace = drivePacer("pan115", clock);
    await pace(async () => "first");
    await pace(async () => "second");
    expect(clock.slept).toEqual([]);
  });

  it("未知 provider 不抛错，退化为不限速（与旧行为一致）", async () => {
    const clock = fakeClock();
    const pace = drivePacer("some-future-brand", clock);
    await pace(async () => "first");
    await pace(async () => "second");
    expect(clock.slept).toEqual([]);
  });

  it("provider 缺省不抛错", async () => {
    const clock = fakeClock();
    const pace = drivePacer(undefined, clock);
    await pace(async () => "first");
    await pace(async () => "second");
    expect(clock.slept).toEqual([]);
  });

  it("限速退避仍然生效（123 的 code=100011）", async () => {
    const clock = fakeClock();
    const pace = drivePacer("pan123", clock);
    await expect(
      pace(async () => {
        throw new Error("code=100011 请勿频繁操作");
      }),
    ).rejects.toThrow(/100011/);
    // 三次退避 30s/60s/120s 后抛出
    expect(clock.slept).toEqual([30_000, 60_000, 120_000]);
  });

  it("注册表里每个 provider 都是合法品牌（拼写错误会在上面第一条暴露）", () => {
    const providers = STORAGE_BRANDS.map((b) => b.provider);
    for (const p of providers) {
      expect(() => getStorageBrand(p)).not.toThrow();
    }
    expect(providers).toEqual(expect.arrayContaining<StorageProvider>(["pan115", "quark", "pan123"]));
  });
});

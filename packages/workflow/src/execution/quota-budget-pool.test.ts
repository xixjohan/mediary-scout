import { describe, expect, it } from "vitest";
import {
  calculateBudgetPools,
  evaluateQuotaBudget,
} from "./quota-budget-pool.js";

describe("calculateBudgetPools", () => {
  it("默认 50 次配额切分：前台交互保留 20 次 (40%)，后台巡检上限 30 次", () => {
    const pools = calculateBudgetPools(50);
    expect(pools.interactiveReserved).toBe(20);
    expect(pools.patrolLimit).toBe(30);
  });

  it("低配额 (15 次) 场景：保底前台交互保留 10 次，巡检仅允许 5 次", () => {
    const pools = calculateBudgetPools(15);
    expect(pools.interactiveReserved).toBe(10);
    expect(pools.patrolLimit).toBe(5);
  });

  it("支持自定义配置覆盖", () => {
    const pools = calculateBudgetPools(100, {
      interactiveReserveRatio: 0.3,
      minimumInteractiveReserve: 15,
    });
    expect(pools.interactiveReserved).toBe(30);
    expect(pools.patrolLimit).toBe(70);
  });
});

describe("evaluateQuotaBudget", () => {
  it("前台手动交互任务：只要剩余配额 > 0，始终放行通行", () => {
    const verdict = evaluateQuotaBudget({
      taskKind: "interactive",
      currentDailyRemaining: 5, // 虽然很低，但手动任务仍然放行
      patrolConsumedToday: 0,
    });

    expect(verdict.allowed).toBe(true);
    expect(verdict.circuitState).toBe("closed");
    expect(verdict.reason).toBe("allowed");
  });

  it("后台巡检任务：当网盘今日剩余触及低水位 (<= 10 次) 时，主动熔断休眠", () => {
    const verdict = evaluateQuotaBudget({
      taskKind: "patrol",
      currentDailyRemaining: 8, // <= 10
      patrolConsumedToday: 5,
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.circuitState).toBe("open");
    expect(verdict.reason).toBe("low_watermark_tripped");
    expect(verdict.message).toContain("触及安全低水位");
  });

  it("后台巡检任务：当今日巡检消耗达到上限 (30 次) 时，自动熔断休眠", () => {
    const verdict = evaluateQuotaBudget({
      taskKind: "patrol",
      currentDailyRemaining: 25, // 虽然网盘还有，但巡检池已耗尽
      patrolConsumedToday: 30,
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.circuitState).toBe("open");
    expect(verdict.reason).toBe("patrol_budget_exhausted");
    expect(verdict.message).toContain("达到预算上限");
  });

  it("后台巡检任务：配额池充足且在安全水位以上，正常放行", () => {
    const verdict = evaluateQuotaBudget({
      taskKind: "patrol",
      currentDailyRemaining: 40,
      patrolConsumedToday: 5,
    });

    expect(verdict.allowed).toBe(true);
    expect(verdict.circuitState).toBe("closed");
    expect(verdict.reason).toBe("allowed");
  });

  it("网盘报告剩余为 0 时：所有任务均判定耗尽并拒绝", () => {
    const verdict = evaluateQuotaBudget({
      taskKind: "interactive",
      currentDailyRemaining: 0,
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.circuitState).toBe("open");
    expect(verdict.reason).toBe("daily_exhausted");
  });
});

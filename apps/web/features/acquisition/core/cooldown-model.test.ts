import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceCandidateView } from "@media-track/workflow";
import type { PanelState } from "../contracts/acquisition-types";
import {
  calculateRemainingMs,
  calculateRemainingSeconds,
  CooldownTimer,
  createCooldownDescriptor,
  DEFAULT_RETRY_AFTER_MS,
  formatCooldownButton,
  formatCooldownHint,
  transitionOnCooldownExpired,
  transitionToThrottled,
} from "./cooldown-model";

function mockCandidate(id: string): ResourceCandidateView {
  return {
    candidateId: id,
    title: `Candidate ${id}`,
    type: "115",
    source: "pansou",
  };
}

describe("cooldown-model — 绝对时钟与倒计时计算", () => {
  it("createCooldownDescriptor 产生精确的目标时间戳与向上取整秒数", () => {
    const baseNow = 1_000_000;
    const desc = createCooldownDescriptor(38_200, baseNow);

    expect(desc.durationMs).toBe(38_200);
    expect(desc.targetTimestamp).toBe(1_038_200);
    expect(desc.remainingMs).toBe(38_200);
    // 38200ms -> Math.ceil(38.2) = 39s
    expect(desc.remainingSeconds).toBe(39);
    expect(desc.isThrottled).toBe(true);
  });

  it("当输入非正常值或缺省时回退到默认 60s", () => {
    const baseNow = 500_000;
    const desc = createCooldownDescriptor(undefined, baseNow);
    expect(desc.durationMs).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(desc.targetTimestamp).toBe(500_000 + DEFAULT_RETRY_AFTER_MS);
    expect(desc.remainingSeconds).toBe(60);
  });

  it("calculateRemainingMs 与 calculateRemainingSeconds 截断负数与零边界", () => {
    const target = 100_000;
    // 剩余 500ms -> 向上取整为 1s
    expect(calculateRemainingMs(target, 99_500)).toBe(500);
    expect(calculateRemainingSeconds(target, 99_500)).toBe(1);

    // 正好到期 -> 0s
    expect(calculateRemainingMs(target, 100_000)).toBe(0);
    expect(calculateRemainingSeconds(target, 100_000)).toBe(0);

    // 已经超时 2000ms -> 依然为 0s，绝不返回负数
    expect(calculateRemainingMs(target, 102_000)).toBe(0);
    expect(calculateRemainingSeconds(target, 102_000)).toBe(0);
  });
});

describe("cooldown-model — 格式化策略 (Strategy)", () => {
  it("formatCooldownButton 覆盖 busy、冷却中与恢复状态", () => {
    // 优先级 1: busy
    expect(formatCooldownButton(38, "查询资源", true)).toBe("查询中…");

    // 优先级 2: remainingSeconds > 0
    expect(formatCooldownButton(38, "查询资源", false)).toBe("请稍候 38s");
    expect(formatCooldownButton(1, "查询资源", false)).toBe("请稍候 1s");

    // 优先级 3: 归零恢复
    expect(formatCooldownButton(0, "查询资源", false)).toBe("查询资源");
    expect(formatCooldownButton(0, "立即检索", false)).toBe("立即检索");
  });

  it("formatCooldownHint 支持秒级与分秒级自适应", () => {
    expect(formatCooldownHint(38)).toBe("查询太频繁，38 秒后可再查。");
    expect(formatCooldownHint(1)).toBe("查询太频繁，1 秒后可再查。");
    expect(formatCooldownHint(75)).toBe("查询太频繁，约 1 分 15 秒后可再查。");
    expect(formatCooldownHint(120)).toBe("查询太频繁，约 2 分 后可再查。");
    expect(formatCooldownHint(0)).toBe("");
  });
});

describe("cooldown-model — FSM 状态机转移与存量保留", () => {
  it("transitionToThrottled 从 ready 进入限流态时，完整保留历史候选集与快照句柄", () => {
    const candidates = [mockCandidate("c1"), mockCandidate("c2")];
    const readyState: PanelState = {
      kind: "ready",
      candidates,
      cached: false,
      snapshotId: "snap-123",
      sourceHealth: { status: "healthy", unhealthySources: [] },
    };

    const throttled = transitionToThrottled(readyState, 42_000);
    expect(throttled.kind).toBe("throttled");
    if (throttled.kind !== "throttled") return;

    expect(throttled.retryAfterMs).toBe(42_000);
    expect(throttled.previousCandidates).toEqual(candidates);
    expect(throttled.previousSnapshotId).toBe("snap-123");
    expect(throttled.sourceHealth).toEqual({ status: "healthy", unhealthySources: [] });
  });

  it("transitionToThrottled 从 idle 进入限流态时正常返回 throttled", () => {
    const throttled = transitionToThrottled({ kind: "idle" }, 30_000);
    expect(throttled.kind).toBe("throttled");
    if (throttled.kind !== "throttled") return;
    expect(throttled.retryAfterMs).toBe(30_000);
    expect(throttled.previousCandidates).toBeUndefined();
  });

  it("transitionToThrottled 从带有 previousCandidates 的 loading 态进入限流态时完整保留候选集", () => {
    const candidates = [mockCandidate("c1")];
    const loadingState: PanelState = {
      kind: "loading",
      previousCandidates: candidates,
      previousSnapshotId: "snap-abc",
    };
    const throttled = transitionToThrottled(loadingState, 35_000);
    expect(throttled.kind).toBe("throttled");
    if (throttled.kind !== "throttled") return;
    expect(throttled.retryAfterMs).toBe(35_000);
    expect(throttled.previousCandidates).toEqual(candidates);
    expect(throttled.previousSnapshotId).toBe("snap-abc");
  });

  it("transitionOnCooldownExpired 在拥有存量候选集时，自动自愈恢复为 ready 态并附带 cached: true", () => {
    const candidates = [mockCandidate("c1")];
    const throttledState: PanelState = {
      kind: "throttled",
      retryAfterMs: 38_000,
      previousCandidates: candidates,
      previousSnapshotId: "snap-999",
      sourceHealth: { status: "healthy", unhealthySources: [] },
    };

    const recovered = transitionOnCooldownExpired(throttledState);
    expect(recovered.kind).toBe("ready");
    if (recovered.kind !== "ready") return;

    expect(recovered.candidates).toEqual(candidates);
    expect(recovered.snapshotId).toBe("snap-999");
    expect(recovered.cached).toBe(true);
  });

  it("transitionOnCooldownExpired 无存量候选集时，平滑自愈回退至 idle 初始态", () => {
    const throttledState: PanelState = {
      kind: "throttled",
      retryAfterMs: 38_000,
    };

    const recovered = transitionOnCooldownExpired(throttledState);
    expect(recovered.kind).toBe("idle");
  });

  it("transitionOnCooldownExpired 对非 throttled 状态无副作用", () => {
    const loadingState: PanelState = { kind: "loading" };
    expect(transitionOnCooldownExpired(loadingState)).toBe(loadingState);
  });
});

describe("CooldownTimer — 高内聚绝对时钟倒计时引擎", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("启动 38s 倒计时：首帧即刻通知 38s，按秒递减并在到期时触发 onRecover", () => {
    const onTick = vi.fn();
    const onRecover = vi.fn();

    const timer = new CooldownTimer();
    timer.start(38_000, onTick, onRecover);

    expect(timer.isActive()).toBe(true);
    expect(timer.getRemainingSeconds()).toBe(38);
    expect(onTick).toHaveBeenCalledWith(38, 38_000);

    // 前进 1000ms
    vi.advanceTimersByTime(1000);
    expect(timer.getRemainingSeconds()).toBe(37);
    expect(onTick).toHaveBeenCalledWith(37, 37_000);

    // 前进 37_000ms 达到归零
    vi.advanceTimersByTime(37_000);
    expect(timer.getRemainingSeconds()).toBe(0);
    expect(timer.isActive()).toBe(false);
    expect(onRecover).toHaveBeenCalledTimes(1);

    timer.stop();
  });

  it("模拟浏览器休眠跳跃：时间跃迁超过倒计时长度时立即自愈", () => {
    const onRecover = vi.fn();
    const timer = new CooldownTimer();
    timer.start(20_000, undefined, onRecover);

    expect(timer.getRemainingSeconds()).toBe(20);

    // 模拟跳跃 25 秒
    vi.advanceTimersByTime(25_000);
    expect(timer.getRemainingSeconds()).toBe(0);
    expect(timer.isActive()).toBe(false);
    expect(onRecover).toHaveBeenCalledTimes(1);

    timer.stop();
  });

  it("非正数输入不启动定时器", () => {
    const onTick = vi.fn();
    const timer = new CooldownTimer();
    timer.start(0, onTick);
    expect(timer.isActive()).toBe(false);
    expect(onTick).not.toHaveBeenCalled();

    timer.start(-1000, onTick);
    expect(timer.isActive()).toBe(false);
  });

  it("手动 stop() 终止定时器与监听", () => {
    const onRecover = vi.fn();
    const timer = new CooldownTimer();
    timer.start(30_000, undefined, onRecover);
    expect(timer.isActive()).toBe(true);

    timer.stop();
    expect(timer.isActive()).toBe(false);
    expect(timer.getRemainingSeconds()).toBe(0);

    // 推进时间不会再触发 onRecover
    vi.advanceTimersByTime(35_000);
    expect(onRecover).not.toHaveBeenCalled();
  });
});

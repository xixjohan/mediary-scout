/**
 * 资源检索限流冷却领域模型与状态机策略
 *
 * 核心设计原则：
 * 1. 绝对时间戳对齐 (Wall-Clock Target Alignment)：通过 (now + retryAfterMs) 锁定未来到期时刻，
 *    解决定时器在浏览器后台休眠、CPU 负载积压时造成的计时漂移问题；
 * 2. 向上取整原则 (Math.ceil)：0.1s~1.0s 稳定显示 1s，消灭“显示 0s 却因毫秒级微小差额依然被服务端拦截”的假死体验；
 * 3. 历史数据保留原则 (State Preservation)：进入冷却态时不抹除已获取的历史有效候选集与 snapshotId；
 * 4. 策略格式化：统一收敛按钮提示与面板警告文案；
 * 5. 端口与适配器设计 (Hexagonal Architecture)：核心时钟引擎 CooldownTimer 纯逻辑无 React 依赖，便于全面单测。
 */

import type { ResourceCandidateView } from "@media-track/workflow";
import type { PanelState } from "../contracts/acquisition-types";

export const DEFAULT_RETRY_AFTER_MS = 60_000;

export interface CooldownDescriptor {
  durationMs: number;
  targetTimestamp: number;
  remainingMs: number;
  remainingSeconds: number;
  isThrottled: boolean;
}

/**
 * 根据服务端返回的冷却毫秒数与当前基准时间，构造绝对时钟描述符
 */
export function createCooldownDescriptor(
  retryAfterMs: number = DEFAULT_RETRY_AFTER_MS,
  nowMs: number = Date.now(),
): CooldownDescriptor {
  const safeDuration = Math.max(0, Number.isFinite(retryAfterMs) ? retryAfterMs : DEFAULT_RETRY_AFTER_MS);
  const targetTimestamp = nowMs + safeDuration;
  const remainingSeconds = Math.ceil(safeDuration / 1000);

  return {
    durationMs: safeDuration,
    targetTimestamp,
    remainingMs: safeDuration,
    remainingSeconds,
    isThrottled: safeDuration > 0,
  };
}

/**
 * 基于目标时间戳计算剩余毫秒数（下限截断为 0）
 */
export function calculateRemainingMs(targetTimestamp: number, nowMs: number = Date.now()): number {
  return Math.max(0, targetTimestamp - nowMs);
}

/**
 * 基于目标时间戳计算剩余秒数（向上取整）
 */
export function calculateRemainingSeconds(targetTimestamp: number, nowMs: number = Date.now()): number {
  const ms = calculateRemainingMs(targetTimestamp, nowMs);
  return Math.ceil(ms / 1000);
}

/**
 * 按钮文案格式化策略
 */
export function formatCooldownButton(
  remainingSeconds: number,
  defaultText: string = "查询资源",
  busy: boolean = false,
): string {
  if (busy) {
    return "查询中…";
  }
  if (remainingSeconds > 0) {
    return `请稍候 ${remainingSeconds}s`;
  }
  return defaultText;
}

/**
 * 状态提示区文案格式化策略
 */
export function formatCooldownHint(remainingSeconds: number): string {
  if (remainingSeconds <= 0) {
    return "";
  }
  if (remainingSeconds >= 60) {
    const mins = Math.floor(remainingSeconds / 60);
    const secs = remainingSeconds % 60;
    return `查询太频繁，约 ${mins} 分 ${secs > 0 ? `${secs} 秒` : ""}后可再查。`;
  }
  return `查询太频繁，${remainingSeconds} 秒后可再查。`;
}

/**
 * 有限状态机 (FSM)：处理进入限流态时的状态保留逻辑
 * 若前置状态已经加载了候选集 (ready)，则保留其候选列表与快照句柄，避免用户界面突兀闪退为空白
 */
export function transitionToThrottled(
  prevState: PanelState,
  retryAfterMs: number,
): PanelState {
  const safeMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : DEFAULT_RETRY_AFTER_MS;

  if (prevState.kind === "ready") {
    return {
      kind: "throttled",
      retryAfterMs: safeMs,
      previousCandidates: prevState.candidates,
      previousSnapshotId: prevState.snapshotId,
      sourceHealth: prevState.sourceHealth,
    };
  }

  if (
    (prevState.kind === "throttled" || prevState.kind === "loading") &&
    prevState.previousCandidates
  ) {
    return {
      kind: "throttled",
      retryAfterMs: safeMs,
      previousCandidates: prevState.previousCandidates,
      previousSnapshotId: prevState.previousSnapshotId,
      sourceHealth: prevState.sourceHealth,
    };
  }

  return {
    kind: "throttled",
    retryAfterMs: safeMs,
  };
}

/**
 * 有限状态机 (FSM)：处理倒计时归零自愈时的状态恢复逻辑
 * 如果先前存在已保留的候选结果，自愈恢复为 ready 态；否则平滑回退至初始 idle 态
 */
export function transitionOnCooldownExpired(
  prevState: PanelState,
): PanelState {
  if (prevState.kind !== "throttled") {
    return prevState;
  }

  if (prevState.previousCandidates && prevState.previousCandidates.length > 0) {
    return {
      kind: "ready",
      candidates: prevState.previousCandidates,
      cached: true,
      snapshotId: prevState.previousSnapshotId ?? null,
      sourceHealth: prevState.sourceHealth,
    };
  }

  return { kind: "idle" };
}

/**
 * 高内聚、零依赖的绝对墙上时钟倒计时引擎 (Domain Port)
 */
export class CooldownTimer {
  private targetTimestamp: number | null = null;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private onTickCallback?: ((seconds: number, ms: number) => void) | undefined;
  private onRecoverCallback?: (() => void) | undefined;
  private visibilityHandler?: (() => void) | undefined;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  start(
    retryAfterMs: number,
    onTick?: (seconds: number, ms: number) => void,
    onRecover?: () => void,
  ): void {
    this.stop();
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
      return;
    }

    this.onTickCallback = onTick;
    this.onRecoverCallback = onRecover;
    this.targetTimestamp = this.clock() + retryAfterMs;

    const initialMs = retryAfterMs;
    const initialSec = Math.ceil(initialMs / 1000);
    this.onTickCallback?.(initialSec, initialMs);

    this.timerId = setInterval(() => this.tick(), 1000);
    this.attachListeners();
  }

  stop(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.targetTimestamp = null;
    this.detachListeners();
  }

  tick(): void {
    if (this.targetTimestamp === null) return;
    const now = this.clock();
    const leftMs = calculateRemainingMs(this.targetTimestamp, now);
    const leftSec = calculateRemainingSeconds(this.targetTimestamp, now);

    this.onTickCallback?.(leftSec, leftMs);

    if (leftMs <= 0) {
      const recover = this.onRecoverCallback;
      this.stop();
      recover?.();
    }
  }

  recalibrate(): void {
    this.tick();
  }

  getRemainingMs(): number {
    if (this.targetTimestamp === null) return 0;
    return calculateRemainingMs(this.targetTimestamp, this.clock());
  }

  getRemainingSeconds(): number {
    if (this.targetTimestamp === null) return 0;
    return calculateRemainingSeconds(this.targetTimestamp, this.clock());
  }

  isActive(): boolean {
    return this.targetTimestamp !== null && this.getRemainingSeconds() > 0;
  }

  private attachListeners(): void {
    if (typeof document === "undefined") return;
    this.visibilityHandler = () => {
      if (document.visibilityState === "visible") {
        this.recalibrate();
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
    if (typeof window !== "undefined") {
      window.addEventListener("focus", this.visibilityHandler);
    }
  }

  private detachListeners(): void {
    if (this.visibilityHandler) {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", this.visibilityHandler);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", this.visibilityHandler);
      }
      this.visibilityHandler = undefined;
    }
  }
}

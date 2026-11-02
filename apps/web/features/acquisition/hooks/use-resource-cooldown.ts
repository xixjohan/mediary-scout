"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CooldownTimer,
  formatCooldownButton,
  formatCooldownHint,
} from "../core/cooldown-model";

export interface UseResourceCooldownOptions {
  /**
   * 服务端下发的冷却毫秒数，当传入有效正数时激活倒计时
   */
  retryAfterMs?: number | undefined;
  /**
   * 是否正处于被限流态
   */
  isThrottled?: boolean | undefined;
  /**
   * 默认查询按钮显示文案，默认 "查询资源"
   */
  defaultButtonLabel?: string | undefined;
  /**
   * 是否正在网络查询中 (busy)
   */
  busy?: boolean | undefined;
  /**
   * 倒计时自然到期归零时的自动恢复回调
   */
  onRecover?: (() => void) | undefined;
}

export interface UseResourceCooldownResult {
  /**
   * 剩余秒数（向上取整），当归零后为 0
   */
  remainingSeconds: number;
  /**
   * 剩余毫秒数
   */
  remainingMs: number;
  /**
   * 是否仍处于倒计时冷却期
   */
  isCooldownActive: boolean;
  /**
   * 根据当前状态格式化好的按钮文本（如 "查询中…", "请稍候 38s", "查询资源"）
   */
  buttonText: string;
  /**
   * 根据当前状态格式化好的提示文本（如 "查询太频繁，38 秒后可再查。"）
   */
  hintText: string;
  /**
   * 手动提前重置/清除倒计时
   */
  resetCooldown: () => void;
}

export function useResourceCooldown({
  retryAfterMs,
  isThrottled = false,
  defaultButtonLabel = "查询资源",
  busy = false,
  onRecover,
}: UseResourceCooldownOptions): UseResourceCooldownResult {
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() => {
    return isThrottled && retryAfterMs && retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 0;
  });
  const [remainingMs, setRemainingMs] = useState<number>(() => {
    return isThrottled && retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 0;
  });

  const timerRef = useRef<CooldownTimer | null>(null);
  if (!timerRef.current) {
    timerRef.current = new CooldownTimer();
  }

  const onRecoverRef = useRef(onRecover);
  onRecoverRef.current = onRecover;

  const resetCooldown = useCallback(() => {
    timerRef.current?.stop();
    setRemainingSeconds(0);
    setRemainingMs(0);
  }, []);

  useEffect(() => {
    const timer = timerRef.current;
    if (!timer) return;

    if (!isThrottled || !retryAfterMs || retryAfterMs <= 0) {
      resetCooldown();
      return;
    }

    timer.start(
      retryAfterMs,
      (sec, ms) => {
        setRemainingSeconds(sec);
        setRemainingMs(ms);
      },
      () => {
        setRemainingSeconds(0);
        setRemainingMs(0);
        onRecoverRef.current?.();
      },
    );

    return () => {
      timer.stop();
    };
  }, [isThrottled, retryAfterMs, resetCooldown]);

  const isCooldownActive = isThrottled && remainingSeconds > 0;
  const buttonText = formatCooldownButton(remainingSeconds, defaultButtonLabel, busy);
  const hintText = formatCooldownHint(remainingSeconds);

  return {
    remainingSeconds,
    remainingMs,
    isCooldownActive,
    buttonText,
    hintText,
    resetCooldown,
  };
}

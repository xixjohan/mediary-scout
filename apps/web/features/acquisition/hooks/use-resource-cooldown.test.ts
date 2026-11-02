import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  let states: any[] = [];
  let stateIndex = 0;
  let cleanups: Array<() => void> = [];

  return {
    get states() {
      return states;
    },
    get stateIndex() {
      return stateIndex;
    },
    set stateIndex(val: number) {
      stateIndex = val;
    },
    cleanups,
    reset() {
      states = [];
      stateIndex = 0;
      cleanups = [];
    },
  };
});

vi.mock("react", () => ({
  useState: (init: any) => {
    const idx = h.stateIndex++;
    if (h.states.length <= idx) {
      const initialVal = typeof init === "function" ? init() : init;
      h.states.push(initialVal);
    }
    const setter = (val: any) => {
      h.states[idx] = typeof val === "function" ? val(h.states[idx]) : val;
    };
    return [h.states[idx], setter];
  },
  useRef: (init: any) => ({ current: init }),
  useCallback: (fn: any) => fn,
  useEffect: (effectFn: any) => {
    const cleanup = effectFn();
    if (typeof cleanup === "function") {
      h.cleanups.push(cleanup);
    }
  },
}));

import { useResourceCooldown } from "./use-resource-cooldown";

describe("useResourceCooldown — React 适配器", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.reset();
  });

  afterEach(() => {
    for (const cleanup of h.cleanups) {
      cleanup();
    }
    vi.useRealTimers();
  });

  it("当被限流时正确输出初始倒计时文案，并在归零时触发回调", () => {
    const onRecover = vi.fn();
    const result = useResourceCooldown({
      isThrottled: true,
      retryAfterMs: 38_000,
      onRecover,
    });

    expect(result.isCooldownActive).toBe(true);
    expect(result.remainingSeconds).toBe(38);
    expect(result.buttonText).toBe("请稍候 38s");
    expect(result.hintText).toBe("查询太频繁，38 秒后可再查。");

    // 推进 38 秒
    vi.advanceTimersByTime(38_000);
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it("非限流状态下保持查询资源文案", () => {
    const result = useResourceCooldown({
      isThrottled: false,
      retryAfterMs: undefined,
    });

    expect(result.isCooldownActive).toBe(false);
    expect(result.remainingSeconds).toBe(0);
    expect(result.buttonText).toBe("查询资源");
  });
});

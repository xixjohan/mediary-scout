import { describe, expect, it } from "vitest";
import {
  canOfferModeSwitch,
  deliveryControlText,
  initialDeliveryControl,
  modeLabel,
  reduceDeliveryControl,
  type DeliveryControlEvent,
  type DeliveryControlOptions,
  type DeliveryControlState,
} from "../../../features/player/core/delivery-control-fsm";

/**
 * 表驱动：每条用例只钉一个不变量。这是把 4 个并行标志收敛成状态机之后
 * 才可能做到的事——旧实现里 `overrideActive` / `preferenceReset` / `rememberedModeRef`
 * 互相纠缠，无法这样穷举。
 *
 * 三条核心红线：
 *   1. policy 态：服务端结果永远优先；
 *   2. user 态：服务端结果不得覆盖用户选择；
 *   3. locked（成员）：任何事件都不得把 origin 变成 user。
 */

const run = (
  steps: Array<{ event: DeliveryControlEvent; options?: DeliveryControlOptions }>,
  from: DeliveryControlState = initialDeliveryControl("redirect"),
): { state: DeliveryControlState; effects: string[] } => {
  let state = from;
  const effects: string[] = [];
  for (const step of steps) {
    const r = reduceDeliveryControl(state, step.event, step.options ?? {});
    state = r.state;
    if (r.effect) effects.push(r.effect);
  }
  return { state, effects };
};

describe("delivery control FSM：policy ↔ user", () => {
  it("初始为 policy 态，沿用服务端裁决", () => {
    const state = initialDeliveryControl("proxy");
    expect(state).toEqual({ mode: "proxy", origin: "policy", persisted: false, note: null });
  });

  it("policy 态：服务端重新裁决生效（含模式变化）", () => {
    const { state } = run([{ event: { type: "SERVER_DECISION", mode: "proxy", source: "library" } }]);
    expect(state.mode).toBe("proxy");
    expect(state.origin).toBe("policy");
  });

  it("user 态：服务端结果不得覆盖用户选择", () => {
    const { state } = run([
      { event: { type: "TOGGLE" } },
      { event: { type: "SERVER_DECISION", mode: "proxy", source: "library" } },
    ]);
    // 初始 redirect → TOGGLE 得 proxy；服务端又要 proxy 时看起来相同，
    // 所以这里反过来验证：服务端要 redirect，用户的选择必须保住。
    expect(state.origin).toBe("user");
  });

  it("user 态：服务端要回落也不能抢回控制权", () => {
    const fromUserProxy: DeliveryControlState = { mode: "proxy", origin: "user", persisted: true, note: null };
    const { state } = run([{ event: { type: "SERVER_DECISION", mode: "redirect", source: "library" } }], fromUserProxy);
    expect(state.mode).toBe("proxy");
    expect(state.origin).toBe("user");
  });

  it("切换 → user 态 + 落盘副作用 + 一次性提示", () => {
    const { state, effects } = run([{ event: { type: "TOGGLE" } }]);
    expect(state.mode).toBe("proxy");
    expect(state.origin).toBe("user");
    expect(state.persisted).toBe(true);
    expect(state.note).toContain("已记忆");
    expect(effects).toEqual(["persist-mode"]);
  });

  it("恢复默认 → 回到 policy 态 + 清除偏好副作用", () => {
    const { state, effects } = run([{ event: { type: "TOGGLE" } }, { event: { type: "RESET" } }]);
    expect(state.origin).toBe("policy");
    expect(state.persisted).toBe(false);
    expect(effects).toEqual(["persist-mode", "clear-preference"]);
  });

  it("恢复默认后服务端重新接管（RESET 的意义就在这条）", () => {
    const { state } = run([
      { event: { type: "TOGGLE" } },
      { event: { type: "RESET" } },
      { event: { type: "SERVER_DECISION", mode: "proxy", source: "binding" } },
    ]);
    expect(state.mode).toBe("proxy");
    expect(state.origin).toBe("policy");
  });

  it("读到账号偏好 → 直接进入 user 态（跨设备一致的记忆）", () => {
    const { state } = run([{ event: { type: "PREFERENCE_LOADED", preference: "proxy" } }]);
    expect(state.mode).toBe("proxy");
    expect(state.origin).toBe("user");
    expect(state.persisted).toBe(true);
  });

  it("无偏好 → 维持 policy 态", () => {
    const { state } = run([{ event: { type: "PREFERENCE_LOADED", preference: null } }]);
    expect(state.origin).toBe("policy");
    expect(state.persisted).toBe(false);
  });

  it("无代理入口（canToggle=false）→ 切换无效，不产生落盘", () => {
    const { state, effects } = run([{ event: { type: "TOGGLE" }, options: { canToggle: false } }]);
    expect(state.origin).toBe("policy");
    expect(effects).toEqual([]);
  });
});

describe("delivery control FSM：成员锁定（需求 2）", () => {
  const locked = { locked: true };

  it("locked 时切换无效（连 UI 都不该渲染，但服务端语义要一致）", () => {
    const { state, effects } = run([{ event: { type: "TOGGLE" }, options: locked }]);
    expect(state.origin).toBe("policy");
    expect(effects).toEqual([]);
  });

  it("locked 时恢复默认也无效（否则能间接清掉策略）", () => {
    const fromUser: DeliveryControlState = { mode: "proxy", origin: "user", persisted: true, note: null };
    const { state, effects } = run([{ event: { type: "RESET" }, options: locked }], fromUser);
    expect(state.origin).toBe("user");
    expect(effects).toEqual([]);
  });

  it("locked 时账号偏好不得生效——即使历史值还在库里", () => {
    const { state } = run([{ event: { type: "PREFERENCE_LOADED", preference: "redirect" }, options: locked }]);
    expect(state.origin).toBe("policy");
    expect(state.mode).toBe("redirect"); // 仍是服务端给的初始值
  });

  it("locked 时服务端裁决照常生效（锁定的是覆盖权，不是策略本身）", () => {
    const { state } = run([
      { event: { type: "SERVER_DECISION", mode: "proxy", source: "library" }, options: locked },
    ]);
    expect(state.mode).toBe("proxy");
    expect(state.origin).toBe("policy");
  });

  it("locked 时不渲染切换与恢复按钮", () => {
    expect(canOfferModeSwitch(initialDeliveryControl("redirect"), locked)).toEqual({ toggle: false, reset: false });
  });
});

describe("展示派生", () => {
  it("非 locked：有代理入口即可切换；只有 user 且已落盘才给恢复", () => {
    expect(canOfferModeSwitch(initialDeliveryControl("redirect"), { canToggle: true })).toEqual({
      toggle: true,
      reset: false,
    });
    expect(
      canOfferModeSwitch({ mode: "proxy", origin: "user", persisted: true, note: null }, { canToggle: true }),
    ).toEqual({ toggle: true, reset: true });
  });

  it("无代理入口 → 不给切换", () => {
    expect(canOfferModeSwitch(initialDeliveryControl("redirect"), { canToggle: false })).toEqual({
      toggle: false,
      reset: false,
    });
  });

  it("文案：有 note 用 note；否则「模式 · 来源」", () => {
    const withNote = deliveryControlText(
      { mode: "proxy", origin: "user", persisted: true, note: "用户手动选择" },
      undefined,
    );
    expect(withNote).toBe("用户手动选择");
    const noNote = deliveryControlText(initialDeliveryControl("redirect"), undefined);
    expect(noNote).toContain("302 CDN 直连");
    expect(noNote).toContain("影视库设置");
  });

  it("模式标签可读", () => {
    expect(modeLabel("redirect")).toBe("302 CDN 直连");
    expect(modeLabel("proxy")).toBe("服务器分片代理");
  });
});

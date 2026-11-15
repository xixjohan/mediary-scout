/**
 * 播放器投送模式控制的状态机。
 *
 * 为什么需要显式状态机：原来用 4 个并行标志（currentMode / rememberedModeRef /
 * overrideActive / preferenceReset）表达同一个事实——"当前模式是跟策略还是用户选的"。
 * 再加"成员不可切换"就是第 5 个标志，组合会爆炸且无法穷举测试。
 *
 * 这里把它收敛成**两个维度**：
 *   - `mode`   ：当前实际使用的投送方式
 *   - `origin` ：policy（跟随影视库设置）｜user（用户显式选择）
 * 其余都是派生态（是否已落盘、是否可切换、提示文案）。
 *
 * 纯函数 + 显式 events，表驱动测试。副作用（写账号偏好）由调用方按返回的 `effect` 执行。
 */

export type DeliveryMode = "redirect" | "proxy";
export type DeliveryOrigin = "policy" | "user";

export interface DeliveryControlState {
  mode: DeliveryMode;
  origin: DeliveryOrigin;
  /** 用户选择是否已写入账号（决定「恢复默认」是否可用）。 */
  persisted: boolean;
  /** 一次性提示文案（渲染后由 UI 消费）。 */
  note: string | null;
}

export type DeliveryControlEvent =
  /** 服务端解析结果到达（影视库设置的最终裁决）。 */
  | { type: "SERVER_DECISION"; mode: DeliveryMode; source: string | undefined }
  /** 账号级偏好读取完成（null = 无偏好）。 */
  | { type: "PREFERENCE_LOADED"; preference: "proxy" | "redirect" | null }
  /** 用户点击切换。 */
  | { type: "TOGGLE" }
  /** 用户点击「恢复默认」。 */
  | { type: "RESET" };

export type DeliveryControlEffect = "persist-mode" | "clear-preference" | null;

export interface DeliveryControlOptions {
  /** 成员等无切换权的账号：TOGGLE / RESET 一律 no-op，服务端结果不可被覆盖。 */
  locked?: boolean;
  /** 是否存在代理入口（无 proxyUrl 时不能切换）。 */
  canToggle?: boolean;
}

const MODE_LABEL: Record<DeliveryMode, string> = {
  redirect: "302 CDN 直连",
  proxy: "服务器分片代理",
};

export function modeLabel(mode: DeliveryMode): string {
  return MODE_LABEL[mode];
}

export function initialDeliveryControl(serverMode: DeliveryMode): DeliveryControlState {
  return { mode: serverMode, origin: "policy", persisted: false, note: null };
}

export function oppositeMode(mode: DeliveryMode): DeliveryMode {
  return mode === "redirect" ? "proxy" : "redirect";
}

/**
 * 归约：state + event (+ options) → 新 state + 需要执行的副作用。
 *
 * 关键不变量（这里正是 4 个旧标志容易失守的地方）：
 *   - **policy 态下服务端结果永远优先**：用户在跟随策略时，服务端重新裁决必须生效；
 *   - **user 态下服务端结果不得覆盖**：用户已显式选择，服务端结果只在 RESET 后重新接管；
 *   - **locked 时任何事件都不得把 origin 变成 user**。
 */
export function reduceDeliveryControl(
  state: DeliveryControlState,
  event: DeliveryControlEvent,
  options: DeliveryControlOptions = {},
): { state: DeliveryControlState; effect: DeliveryControlEffect } {
  const locked = options.locked === true;

  switch (event.type) {
    case "SERVER_DECISION": {
      // user 态保持用户选择；policy 态接受服务端裁决（含来源变化）。
      if (state.origin === "user") return { state, effect: null };
      return { state: { ...state, mode: event.mode, note: null }, effect: null };
    }

    case "PREFERENCE_LOADED": {
      if (locked) return { state, effect: null };
      if (event.preference === null) {
        // 无偏好：保持当前策略结果（可能是刚到达的服务端裁决）。
        return { state: { ...state, origin: "policy", persisted: false }, effect: null };
      }
      return {
        state: {
          mode: event.preference,
          origin: "user",
          persisted: true,
          note: `已记忆的投送偏好：${modeLabel(event.preference)}（刷新后保持）`,
        },
        effect: null,
      };
    }

    case "TOGGLE": {
      if (locked) return { state, effect: null };
      if (options.canToggle === false) return { state, effect: null };
      const next = oppositeMode(state.mode);
      return {
        state: {
          mode: next,
          origin: "user",
          persisted: true,
          note: `用户手动选择：${modeLabel(next)}（已记忆，下次打开保持）`,
        },
        effect: "persist-mode",
      };
    }

    case "RESET": {
      if (locked) return { state, effect: null };
      return {
        state: {
          mode: state.mode,
          origin: "policy",
          persisted: false,
          note: "已恢复默认：下次打开重新按路径绑定 / 影视库配置解析投送模式",
        },
        effect: "clear-preference",
      };
    }
  }
}

/** 是否给用户渲染切换 / 恢复按钮。 */
export function canOfferModeSwitch(
  state: DeliveryControlState,
  options: DeliveryControlOptions = {},
): { toggle: boolean; reset: boolean } {
  if (options.locked === true) return { toggle: false, reset: false };
  return {
    toggle: options.canToggle !== false,
    reset: state.origin === "user" && state.persisted,
  };
}

/** 常驻说明文案（无 note 时退回「当前模式 · 来源」）。 */
export function deliveryControlText(
  state: DeliveryControlState,
  fallbackSource: string | undefined,
): string {
  if (state.note) return state.note;
  return `${modeLabel(state.mode)} · 来源 ${fallbackSource ?? (state.origin === "policy" ? "影视库设置" : "用户偏好")}`;
}

"use client";

/**
 * 播放器左下角提示条的可见性偏好（策略模式的配置端）。
 *
 * 旧实现是一段 `pointerEvents: none` 的常驻 overlay，只能随鼠标 3.5s 渐隐，
 * 用户无法关闭，也与 media-library-and-enhanced-player-design.md §9.1
 * 「快捷键说明收纳于右键或设置菜单，杜绝冗余元素干扰观影」相冲突。
 *
 * 先用 localStorage 做即时生效的本地偏好（零后端改动、刷新后仍记忆）；
 * 若后续要多设备同步，可把同一枚举值经 account_settings 白名单键持久化。
 */
export type HintVisibility = "always" | "auto" | "hidden";

const STORAGE_KEY = "mediary.player.hintVisibility";
const VALID: readonly HintVisibility[] = ["always", "auto", "hidden"];

export const HINT_VISIBILITY_LABELS: Record<HintVisibility, string> = {
  always: "常显",
  auto: "自动渐隐",
  hidden: "隐藏",
};

export function readHintVisibility(): HintVisibility {
  if (typeof window === "undefined") return "auto";
  try {
    const value = window.localStorage.getItem(STORAGE_KEY) as HintVisibility | null;
    return value && VALID.includes(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export function writeHintVisibility(value: HintVisibility): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 隐私模式 / 存储禁用时静默降级为本次会话内有效
  }
}

import type { ResolvedDeliveryMode } from "./delivery-mode-resolver.js";

/**
 * 播放器投送模式的账号级记忆（P2-B）。
 *
 * 单一真相源：`account_settings.player_delivery_mode`。服务端解析链
 * （/api/library/play）与播放器弹窗（含不走该接口的文件夹视图）读同一个键，
 * 避免多入口出现两套偏好语义。
 *
 * 键名不进入 `SECRET_SETTING_KEYS`：它只是非敏感的枚举偏好，明文存储便于排障。
 * 值采用**严格白名单**，任何越界值（含脏数据、注入串）一律视为「未设置」。
 */

export const PLAYER_DELIVERY_MODE_SETTING_KEY = "player_delivery_mode";

export type PlayerDeliveryPreference = "proxy" | "redirect" | "auto";

const VALID_PREFERENCES: ReadonlySet<string> = new Set(["proxy", "redirect", "auto"]);

/** 把落盘值收敛到白名单枚举；非法值返回 null（交回责任链默认策略）。 */
export function parsePlayerDeliveryPreference(
  raw: string | null | undefined,
): PlayerDeliveryPreference | null {
  const value = raw?.trim().toLowerCase();
  return value && VALID_PREFERENCES.has(value)
    ? (value as PlayerDeliveryPreference)
    : null;
}

/**
 * 转成责任链最高优先级的 sessionOverride。
 * `auto`（或 null）表示「恢复默认」，不参与覆盖，让 binding/library/global 重新生效。
 */
export function toSessionOverride(
  preference: PlayerDeliveryPreference | null,
): ResolvedDeliveryMode | null {
  return preference === "proxy" || preference === "redirect" ? preference : null;
}

/** 校验写入侧输入，避免前端把任意字符串落盘。 */
export function normalizePlayerDeliveryPreferenceInput(
  input: unknown,
): PlayerDeliveryPreference | null {
  return typeof input === "string" ? parsePlayerDeliveryPreference(input) : null;
}

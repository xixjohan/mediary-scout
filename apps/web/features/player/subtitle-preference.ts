"use client";

import type { PlayerSubtitleTrack } from "./subtitle-tracks";
import { pickDefaultTrack } from "./subtitle-tracks";

/**
 * 字幕偏好（本地记忆）。
 *
 * 目标：解决「每次打开都要手动选字幕」「换集后回到自动」的问题。
 * 先用 localStorage 做设备级记忆（零后端改动、刷新与换集后仍生效）；
 * 若后续要多设备同步，可把同一枚举值经 account_settings 白名单键持久化
 * ——与 `player_delivery_mode` 的账号级方案同构。
 */

export interface SubtitlePreference {
  /** off = 用户主动关闭字幕；auto = 按语言偏好或自动选轨。 */
  mode: "auto" | "off";
  /** 上次选择的语言标签（如 zh-Hans）；null 表示未指定。 */
  language: string | null;
}

const STORAGE_KEY = "mediary.player.subtitlePreference";
const LANGUAGES = new Set(["zh-Hans", "zh-Hant", "zh", "en", "ja", "ko", "und"]);

export const DEFAULT_SUBTITLE_PREFERENCE: SubtitlePreference = { mode: "auto", language: null };

/** 纯函数：解析存储值，任何非法输入都退回默认，绝不抛错。 */
export function parseSubtitlePreference(raw: string | null | undefined): SubtitlePreference {
  if (!raw) return { ...DEFAULT_SUBTITLE_PREFERENCE };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_SUBTITLE_PREFERENCE };
    const record = parsed as Record<string, unknown>;
    const mode = record["mode"] === "off" ? "off" : "auto";
    const languageRaw = record["language"];
    const language =
      typeof languageRaw === "string" && LANGUAGES.has(languageRaw) ? languageRaw : null;
    return { mode, language };
  } catch {
    return { ...DEFAULT_SUBTITLE_PREFERENCE };
  }
}

export function readSubtitlePreference(): SubtitlePreference {
  if (typeof window === "undefined") return { ...DEFAULT_SUBTITLE_PREFERENCE };
  try {
    return parseSubtitlePreference(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULT_SUBTITLE_PREFERENCE };
  }
}

export function writeSubtitlePreference(preference: SubtitlePreference): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // 隐私模式 / 存储禁用：静默降级为本次会话内有效
  }
}

/**
 * 依据偏好选出默认轨道：
 * - off → 不挂字幕；
 * - 指定语言 → 命中该语言（含 `zh` 与 `zh-Hans/zh-Hant` 的互相兼容）；
 * - 否则回落到自动选轨（简→繁→英→日→韩→首条）。
 */
export function resolvePreferredTrack(
  tracks: readonly PlayerSubtitleTrack[],
  preference: SubtitlePreference,
): PlayerSubtitleTrack | null {
  if (tracks.length === 0) return null;
  if (preference.mode === "off") return null;
  const language = preference.language;
  if (language) {
    const exact = tracks.find((track) => track.language === language);
    if (exact) return exact;
    if (language.startsWith("zh")) {
      // 泛化 `zh` 优先简体，再繁体，最后任意中文轨（顺序不能依赖列表顺序）。
      for (const tag of ["zh-Hans", "zh-Hant"]) {
        const hit = tracks.find((track) => track.language === tag);
        if (hit) return hit;
      }
      const anyChinese = tracks.find((track) => track.language.startsWith("zh"));
      if (anyChinese) return anyChinese;
    }
  }
  return pickDefaultTrack(tracks);
}

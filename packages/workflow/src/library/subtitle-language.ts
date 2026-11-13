/**
 * 从字幕文件名推断语言。
 *
 * 背景：扫描阶段原先把所有外挂字幕写死成 `language: "und"`，导致播放器无法
 * 按语言自动选轨——盘里同时有 `Movie.zh-CN.ass` 与 `Movie.eng.srt` 时只能盲选第一条。
 *
 * 约束：只做「文件名启发式」，不做内容识别。判定失败一律返回 `und`，
 * 让上层降级为「按顺序取第一条」而不是抛错或猜错。
 */

export type SubtitleLanguageTag =
  | "zh-Hans"
  | "zh-Hant"
  | "en"
  | "ja"
  | "ko"
  | "und";

const SIMPLIFIED = /(简体|简中|简英|简繁|中字|中文|中英|双语|\bchs\b|\bsc\b|zh[-_]?(?:cn|hans|sg))/i;
const TRADITIONAL = /(繁体|繁中|繁英|\bcht\b|\btc\b|zh[-_]?(?:tw|hk|hant)|big5)/i;
const ENGLISH = /(\beng\b|\benglish\b|en[-_]?(?:us|gb)|英语|英文)/i;
const JAPANESE = /(\bjpn?\b|\bjapanese\b|ja[-_]?jp|日语|日文)/i;
const KOREAN = /(\bkor\b|\bkorean\b|ko[-_]?kr|韩语|韩文)/i;

export function detectSubtitleLanguage(fileName: string): SubtitleLanguageTag {
  const name = fileName ?? "";
  // 繁体优先于简体：`Movie.繁中.chs.ass` 这类混合命名里繁体是更强的信号。
  if (TRADITIONAL.test(name)) return "zh-Hant";
  if (SIMPLIFIED.test(name)) return "zh-Hans";
  if (ENGLISH.test(name)) return "en";
  if (JAPANESE.test(name)) return "ja";
  if (KOREAN.test(name)) return "ko";
  return "und";
}

const LABELS: Record<SubtitleLanguageTag, string> = {
  "zh-Hans": "简体中文",
  "zh-Hant": "繁体中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  und: "未识别语言",
};

/** 展示用语言名；未知标签原样返回，避免把第三方数据吞掉。 */
export function subtitleLanguageLabel(tag: string): string {
  return LABELS[tag as SubtitleLanguageTag] ?? (tag || "未识别语言");
}

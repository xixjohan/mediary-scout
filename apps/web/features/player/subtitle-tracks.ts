import type { SubtitleTrackInfo } from "@media-track/contracts";
import { subtitleLanguageLabel } from "@media-track/workflow";

/**
 * 播放器字幕轨道装配（纯函数）。
 *
 * 为什么单独抽出：字幕能否显示，取决于「格式 → ArtPlayer 类型」的映射是否正确。
 * 旧实现把所有非 ASS 格式都声明成 `vtt`，而 ArtPlayer 只在 `type === "srt"` 时
 * 调用 `srtToVtt()`（artplayer.mjs:4583-4597），SRT 原样透传后浏览器解析不出 cue，
 * 字幕整条不显示。这条契约必须可单测。
 */

export type ArtSubtitleType = "srt" | "ass" | "vtt";

export interface PlayerSubtitleTrack {
  id: string;
  url: string;
  type: ArtSubtitleType;
  language: string;
  /** 面板展示名：语言 + 文件名（去扩展名）。 */
  label: string;
}

/** 浏览器只能渲染文本轨；PGS/SUB 位图字幕直接判为不可用，而不是错标成 vtt。 */
export function toArtSubtitleType(format: string): ArtSubtitleType | null {
  const normalized = (format ?? "").toLowerCase().trim();
  if (normalized === "srt" || normalized === "ass" || normalized === "vtt") return normalized;
  return null;
}

function stripExtension(title: string): string {
  return title.replace(/\.[a-zA-Z0-9]+$/, "");
}

export function buildPlayerSubtitleTracks(
  subtitles: readonly SubtitleTrackInfo[] | undefined | null,
): PlayerSubtitleTrack[] {
  if (!subtitles || subtitles.length === 0) return [];
  const seen = new Set<string>();
  const tracks: PlayerSubtitleTrack[] = [];
  for (const sub of subtitles) {
    if (!sub?.url) continue;
    const type = toArtSubtitleType(sub.format);
    if (!type) continue;
    if (seen.has(sub.url)) continue;
    seen.add(sub.url);
    const language = sub.language || "und";
    tracks.push({
      id: sub.id,
      url: sub.url,
      type,
      language,
      label: `${subtitleLanguageLabel(language)} · ${stripExtension(sub.title || "字幕")}`,
    });
  }
  return tracks;
}

const LANGUAGE_PRIORITY = ["zh-Hans", "zh-Hant", "zh", "en", "ja", "ko"] as const;

/** 默认选轨：优先中文（简→繁），其次英文/日文/韩文，最后退回第一条。 */
export function pickDefaultTrack(
  tracks: readonly PlayerSubtitleTrack[],
): PlayerSubtitleTrack | null {
  if (tracks.length === 0) return null;
  for (const language of LANGUAGE_PRIORITY) {
    const hit = tracks.find((track) => track.language === language);
    if (hit) return hit;
  }
  return tracks[0] ?? null;
}

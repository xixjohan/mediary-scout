"use client";

import type ArtplayerType from "artplayer";
import type { SubtitleTrackInfo } from "@media-track/contracts";
import { subtitleLanguageLabel } from "@media-track/workflow";
import { buildPlayerSubtitleTracks, type PlayerSubtitleTrack } from "./subtitle-tracks";
import {
  readSubtitlePreference,
  resolvePreferredTrack,
  writeSubtitlePreference,
} from "./subtitle-preference";

/**
 * 字幕控制器：把「轨道装配 / 选轨 / 开关 / 编码 / 偏好记忆 / 控制条按钮」收敛到一处。
 *
 * 抽出的原因：
 * 1. 播放器组件已经承担布局、音频增益、遥测、状态机，字幕再堆进去会继续膨胀；
 * 2. 字幕状态（当前轨、编码）与 DOM 细节（<track> 清理）耦合，独立后便于单测与复用；
 * 3. ArtPlayer 的 `switch("")` 是空操作，关闭字幕必须显式清 track —— 这个坑值得集中注释。
 */
export interface SubtitleController {
  readonly tracks: readonly PlayerSubtitleTrack[];
  readonly initialTrack: PlayerSubtitleTrack | null;
  /** 当前激活轨道（关闭时为 null）。 */
  current(): PlayerSubtitleTrack | null;
  /** 应用轨道；persist=false 时不写入本地偏好（用于初始化回放）。 */
  apply(track: PlayerSubtitleTrack | null, encoding?: string, persist?: boolean): void;
  /** 关闭 → 第 1 条 → … → 最后一条 → 关闭。 */
  cycle(): void;
  /** 控制条按钮文案，如「字幕 简体中文」/「字幕关」。 */
  buttonLabel(): string;
  /** 把控制条按钮元素交给控制器，用于同步文案。 */
  attachButton(element: HTMLElement | undefined): void;
}

export interface SubtitleControllerOptions {
  /** 延迟取播放器实例：控制器在 art 构造前创建。 */
  getArt: () => ArtplayerType | null;
  subtitles: readonly SubtitleTrackInfo[] | undefined | null;
}

const DEFAULT_ENCODING = "utf-8";

export function createSubtitleController(options: SubtitleControllerOptions): SubtitleController {
  const tracks = buildPlayerSubtitleTracks(options.subtitles);
  const initialTrack = resolvePreferredTrack(tracks, readSubtitlePreference());

  let active: PlayerSubtitleTrack | null = initialTrack;
  let encoding = DEFAULT_ENCODING;
  let button: HTMLElement | undefined;

  const buttonLabel = () =>
    active ? `字幕 ${subtitleLanguageLabel(active.language)}` : "字幕关";

  const refreshButton = () => {
    if (button) button.textContent = buttonLabel();
  };

  // ArtPlayer 的 init() 在无 url 时直接 return，switch("") 不会清掉已有轨道。
  const clearTrack = () => {
    const template = options.getArt()?.template;
    if (!template) return;
    try {
      template.$track.track.mode = "disabled";
    } catch {
      // track 尚未加载时访问 track 可能抛错，忽略
    }
    template.$track.removeAttribute("src");
    template.$subtitle.innerHTML = "";
  };

  const apply = (track: PlayerSubtitleTrack | null, nextEncoding = encoding, persist = true) => {
    active = track;
    encoding = nextEncoding;
    if (persist) {
      writeSubtitlePreference(
        track ? { mode: "auto", language: track.language } : { mode: "off", language: null },
      );
    }
    const art = options.getArt();
    if (art) {
      try {
        if (!track) {
          clearTrack();
        } else {
          void art.subtitle
            .switch(track.url, { type: track.type, name: track.label, encoding })
            .catch(() => {});
        }
      } catch {
        // 切轨失败不影响播放，静默降级
      }
    }
    refreshButton();
  };

  return {
    tracks,
    initialTrack,
    current: () => active,
    apply,
    cycle() {
      if (tracks.length === 0) return;
      const index = active ? tracks.findIndex((track) => track.id === active?.id) : -1;
      apply(index + 1 >= tracks.length ? null : tracks[index + 1] ?? null);
    },
    buttonLabel,
    attachButton(element) {
      button = element;
      refreshButton();
    },
  };
}

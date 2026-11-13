"use client";

import { useEffect, useRef, type RefObject } from "react";
import type ArtplayerType from "artplayer";
import { getPlayerApi } from "./player-api";

/**
 * 播放器快捷键命令注册表（唯一事实源）。
 *
 * 背景：旧实现依赖 ArtPlayer 内置 hotkey，而 5.4.0 的 Hotkey 类有
 * `if (art.isFocus)` 门槛（artplayer.mjs:2028），且 isFocus 只有在点击命中
 * $player DOM 时才置 true。本项目的沉浸式弹窗把顶部工具栏做成了 $player 的
 * 兄弟节点，点一下就把焦点打回 false，导致空格/左右键时灵时不灵；同时内置
 * 键位只有 6 个，根本没有提示条宣称的 F 全屏。
 *
 * 解决方案：关闭内置 hotkey（core 里 `hotkey: false`），由本注册表在 window
 * 上做一次统一分派（命令模式 + 适配器 + 全局焦点策略），并让提示条文案、
 * 帮助面板、键位行为全部由同一份数据生成，杜绝「文案与实现不一致」。
 */
export interface PlayerCommandContext {
  onClose: () => void;
  onToggleHelp: () => void;
}

export interface PlayerCommand {
  code: string;
  keyLabel: string;
  label: string;
  run: (art: ArtplayerType, ctx: PlayerCommandContext) => void;
}

const SEEK_STEP = 5;
const VOLUME_STEP = 0.1;
const RATE_STEP = 0.25;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toggleFullscreenWeb(art: ArtplayerType): void {
  const player = art as unknown as { fullscreenWeb?: boolean };
  player.fullscreenWeb = !player.fullscreenWeb;
}

export const PLAYER_COMMANDS: readonly PlayerCommand[] = [
  {
    code: "Space",
    keyLabel: "空格 / K",
    label: "播放 / 暂停",
    run: (art) => art.toggle(),
  },
  {
    code: "KeyK",
    keyLabel: "空格 / K",
    label: "播放 / 暂停",
    run: (art) => art.toggle(),
  },
  {
    code: "ArrowLeft",
    keyLabel: "← / J",
    label: `后退 ${SEEK_STEP} 秒`,
    run: (art) => {
      art.currentTime = Math.max(0, art.currentTime - SEEK_STEP);
    },
  },
  {
    code: "KeyJ",
    keyLabel: "← / J",
    label: `后退 ${SEEK_STEP} 秒`,
    run: (art) => {
      art.currentTime = Math.max(0, art.currentTime - SEEK_STEP);
    },
  },
  {
    code: "ArrowRight",
    keyLabel: "→ / L",
    label: `快进 ${SEEK_STEP} 秒`,
    run: (art) => {
      art.currentTime = Math.min(art.duration || 0, art.currentTime + SEEK_STEP);
    },
  },
  {
    code: "KeyL",
    keyLabel: "→ / L",
    label: `快进 ${SEEK_STEP} 秒`,
    run: (art) => {
      art.currentTime = Math.min(art.duration || 0, art.currentTime + SEEK_STEP);
    },
  },
  {
    code: "ArrowUp",
    keyLabel: "↑ / ↓",
    label: "音量增减",
    run: (art) => {
      art.volume = clamp(art.volume + VOLUME_STEP, 0, 1);
    },
  },
  {
    code: "ArrowDown",
    keyLabel: "↑ / ↓",
    label: "音量增减",
    run: (art) => {
      art.volume = clamp(art.volume - VOLUME_STEP, 0, 1);
    },
  },
  {
    code: "KeyF",
    keyLabel: "F",
    label: "全屏 / 退出全屏",
    run: (art) => toggleFullscreenWeb(art),
  },
  {
    code: "KeyM",
    keyLabel: "M",
    label: "静音 / 取消静音",
    run: (art) => {
      art.muted = !art.muted;
    },
  },
  {
    code: "KeyV",
    keyLabel: "V",
    label: "字幕开关 / 切换下一条",
    run: (art) => {
      // 字幕轨道由播放器组件持有，经 WeakMap 命令注册表调用，避免全局状态。
      getPlayerApi(art)?.cycleSubtitle();
    },
  },
  {
    code: "BracketLeft",
    keyLabel: "[ / ]",
    label: "降低 / 提高倍速",
    run: (art) => {
      art.video.playbackRate = clamp(art.video.playbackRate - RATE_STEP, 0.5, 3);
    },
  },
  {
    code: "BracketRight",
    keyLabel: "[ / ]",
    label: "降低 / 提高倍速",
    run: (art) => {
      art.video.playbackRate = clamp(art.video.playbackRate + RATE_STEP, 0.5, 3);
    },
  },
  ...Array.from({ length: 10 }, (_, digit) => ({
    code: `Digit${digit}`,
    keyLabel: "0 - 9",
    label: `跳转到 ${digit * 10}%`,
    run: (art: ArtplayerType) => {
      art.currentTime = (art.duration || 0) * (digit / 10);
    },
  })),
  {
    code: "Slash",
    keyLabel: "?",
    label: "显示 / 隐藏快捷键说明",
    run: (_art, ctx) => ctx.onToggleHelp(),
  },
];

const COMMAND_BY_CODE = new Map(PLAYER_COMMANDS.map((cmd) => [cmd.code, cmd]));

/** 提示条与帮助面板共用的去重键位说明。 */
export const SHORTCUT_SUMMARY = Array.from(
  new Map(
    PLAYER_COMMANDS.filter((cmd) => !cmd.code.startsWith("Digit")).map((cmd) => [
      cmd.keyLabel,
      cmd.label,
    ]),
  ).entries(),
);

/** 左下角胶囊的一行提示，由注册表生成而非写死。 */
export const SHORTCUT_HINT =
  "空格播放/暂停 · 左右快进退 · F 全屏 · M 静音 · V 字幕 · [ ] 倍速 · ? 查看全部";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toUpperCase();
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export interface UsePlayerShortcutsOptions {
  playerRef: RefObject<ArtplayerType | null>;
  onClose: () => void;
  onToggleHelp: () => void;
  enabled?: boolean;
}

/**
 * 全局焦点策略：沉浸式弹窗内 body 聚焦即生效，仅过滤可编辑元素与修饰键。
 * Escape 在此单一归属，消除 ArtPlayer 与 modal 的双重处理。
 */
export function usePlayerShortcuts({
  playerRef,
  onClose,
  onToggleHelp,
  enabled = true,
}: UsePlayerShortcutsOptions): void {
  const handlersRef = useRef({ onClose, onToggleHelp });
  handlersRef.current = { onClose, onToggleHelp };

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;

      const art = playerRef.current;
      const ctx: PlayerCommandContext = {
        onClose: handlersRef.current.onClose,
        onToggleHelp: handlersRef.current.onToggleHelp,
      };

      if (event.code === "Escape") {
        event.preventDefault();
        const player = art as unknown as { fullscreenWeb?: boolean } | null;
        if (player?.fullscreenWeb) {
          player.fullscreenWeb = false;
        } else {
          ctx.onClose();
        }
        return;
      }

      // "?" 在美式键盘上是 Shift+Slash，用 event.key 兜住不同布局。
      if (event.key === "?" || (event.shiftKey && event.code === "Slash")) {
        event.preventDefault();
        ctx.onToggleHelp();
        return;
      }

      // Slash 无 Shift 时不触发帮助，避免与未来输入场景冲突。
      if (event.code === "Slash" && !event.shiftKey) return;

      const command = COMMAND_BY_CODE.get(event.code);
      if (!command || !art) return;
      event.preventDefault();
      command.run(art, ctx);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, playerRef]);
}

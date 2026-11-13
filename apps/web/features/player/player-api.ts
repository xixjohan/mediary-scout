"use client";

import type ArtplayerType from "artplayer";

/**
 * 播放器命令注册表（WeakMap）。
 *
 * 背景：快捷键注册表（player-shortcuts.ts）只能拿到 `art` 实例，而字幕轨道列表
 * 与当前选轨状态属于播放器组件内部。用 WeakMap 把「实例 → 命令」关联起来，
 * 既避免往 DOM/实例上挂私有字段，也不会造成内存泄漏（实例回收即释放）。
 */

export interface MediaryPlayerApi {
  /** 循环切换字幕：关闭 → 各轨 → 关闭。 */
  cycleSubtitle: () => void;
  /** 当前字幕轨道的展示名；关闭时为 null。 */
  currentSubtitleLabel: () => string | null;
}

const registry = new WeakMap<ArtplayerType, MediaryPlayerApi>();

export function registerPlayerApi(art: ArtplayerType, api: MediaryPlayerApi): void {
  registry.set(art, api);
}

export function unregisterPlayerApi(art: ArtplayerType): void {
  registry.delete(art);
}

export function getPlayerApi(art: ArtplayerType | null | undefined): MediaryPlayerApi | undefined {
  return art ? registry.get(art) : undefined;
}

import { afterEach, describe, expect, it, vi } from "vitest";
import type ArtplayerType from "artplayer";
import {
  PLAYER_COMMANDS,
  SHORTCUT_HINT,
  SHORTCUT_SUMMARY,
} from "./player-shortcuts";
import {
  HINT_VISIBILITY_LABELS,
  readHintVisibility,
  writeHintVisibility,
  type HintVisibility,
} from "./player-preferences";

function commandByCode(code: string) {
  const command = PLAYER_COMMANDS.find((item) => item.code === code);
  if (!command) throw new Error(`missing command: ${code}`);
  return command;
}

function makeFakeArt() {
  return {
    toggle: vi.fn(),
    play: vi.fn(),
    currentTime: 100,
    duration: 200,
    volume: 0.5,
    muted: false,
    fullscreenWeb: false,
    video: { playbackRate: 1, style: {} },
  };
}

const noopContext = { onClose: vi.fn(), onToggleHelp: vi.fn() };

describe("播放器快捷键命令注册表", () => {
  it("包含提示条宣称的全部键位（含旧实现缺失的 F 全屏）", () => {
    const codes = new Set(PLAYER_COMMANDS.map((cmd) => cmd.code));
    for (const code of [
      "Space",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "KeyF",
      "KeyM",
      "BracketLeft",
      "BracketRight",
      "Slash",
      "Digit0",
      "Digit9",
    ]) {
      expect(codes.has(code)).toBe(true);
    }
    expect(SHORTCUT_HINT).toContain("F 全屏");
    expect(SHORTCUT_HINT).toContain("?");
  });

  it("提示条文案与帮助面板由同一份注册表生成", () => {
    expect(SHORTCUT_SUMMARY.length).toBeGreaterThan(5);
    expect(SHORTCUT_SUMMARY.some(([key]) => key === "F")).toBe(true);
    expect(SHORTCUT_SUMMARY.some(([key]) => key === "[ / ]")).toBe(true);
  });

  it("空格 / K 切换播放，左右键按 5 秒快进退", () => {
    const art = makeFakeArt();
    commandByCode("Space").run(art as unknown as ArtplayerType, noopContext);
    expect(art.toggle).toHaveBeenCalledTimes(1);

    commandByCode("ArrowRight").run(art as unknown as ArtplayerType, noopContext);
    expect(art.currentTime).toBe(105);
    commandByCode("ArrowLeft").run(art as unknown as ArtplayerType, noopContext);
    expect(art.currentTime).toBe(100);
  });

  it("F 切换网页全屏，M 切换静音，[ ] 调整倍速", () => {
    const art = makeFakeArt();
    commandByCode("KeyF").run(art as unknown as ArtplayerType, noopContext);
    expect(art.fullscreenWeb).toBe(true);
    commandByCode("KeyM").run(art as unknown as ArtplayerType, noopContext);
    expect(art.muted).toBe(true);
    commandByCode("BracketRight").run(art as unknown as ArtplayerType, noopContext);
    expect(art.video.playbackRate).toBe(1.25);
    commandByCode("BracketLeft").run(art as unknown as ArtplayerType, noopContext);
    expect(art.video.playbackRate).toBe(1);
  });

  it("数字键跳到百分比进度，音量与倍速都有边界钳制", () => {
    const art = makeFakeArt();
    commandByCode("Digit5").run(art as unknown as ArtplayerType, noopContext);
    expect(art.currentTime).toBe(100);

    art.volume = 0.97;
    commandByCode("ArrowUp").run(art as unknown as ArtplayerType, noopContext);
    expect(art.volume).toBeLessThanOrEqual(1);
    art.video.playbackRate = 3;
    commandByCode("BracketRight").run(art as unknown as ArtplayerType, noopContext);
    expect(art.video.playbackRate).toBe(3);
  });

  it("? 打开帮助面板（命令与 UI 使用同一回调）", () => {
    const ctx = { onClose: vi.fn(), onToggleHelp: vi.fn() };
    commandByCode("Slash").run(makeFakeArt() as unknown as ArtplayerType, ctx);
    expect(ctx.onToggleHelp).toHaveBeenCalledTimes(1);
  });
});

describe("提示条可见性偏好", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("无存储环境时默认自动渐隐", () => {
    vi.stubGlobal("window", undefined);
    expect(readHintVisibility()).toBe("auto");
  });

  it("写入后读取到同一枚举值，非法值回退默认", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });

    const order: HintVisibility[] = ["always", "hidden", "auto"];
    for (const value of order) {
      writeHintVisibility(value);
      expect(readHintVisibility()).toBe(value);
      expect(HINT_VISIBILITY_LABELS[value]).toBeTruthy();
    }

    store.set("mediary.player.hintVisibility", "not-a-valid-mode");
    expect(readHintVisibility()).toBe("auto");
  });
});

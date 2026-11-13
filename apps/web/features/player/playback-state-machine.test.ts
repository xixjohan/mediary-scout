import { describe, expect, it } from "vitest";
import {
  createPlaybackMachine,
  isStartupPhase,
  nextPhase,
  playbackStageLabel,
  type PlaybackEvent,
  type PlaybackPhase,
} from "./playback-state-machine";

function machineWithClock() {
  let now = 1000;
  const machine = createPlaybackMachine({ clock: () => now });
  return {
    machine,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("nextPhase 迁移表", () => {
  it("正常启动链路 idle → resolving → connecting → buffering → playing", () => {
    expect(nextPhase("idle", "RESOLVE_START")).toBe("resolving");
    expect(nextPhase("resolving", "RESOLVE_OK")).toBe("connecting");
    expect(nextPhase("connecting", "FIRST_BYTES")).toBe("buffering");
    expect(nextPhase("buffering", "PLAYING")).toBe("playing");
  });

  it("播放中卡顿与 seek 走独立分支，不被 playing 覆盖", () => {
    expect(nextPhase("playing", "WAITING")).toBe("stalled");
    expect(nextPhase("stalled", "PROGRESS")).toBe("playing");
    expect(nextPhase("playing", "SEEK_START")).toBe("seeking");
    expect(nextPhase("seeking", "SEEK_END")).toBe("buffering");
  });

  it("非法迁移返回 null，不产生隐式跳变", () => {
    expect(nextPhase("idle", "PLAYING")).toBeNull();
    expect(nextPhase("ended", "WAITING")).toBeNull();
    expect(nextPhase("buffering", "SEEK_END")).toBeNull();
  });
});

describe("createPlaybackMachine", () => {
  it("记录各阶段首次进入的时间偏移，用于分段耗时", () => {
    const { machine, advance } = machineWithClock();
    machine.dispatch("RESOLVE_START");
    advance(300);
    machine.dispatch("RESOLVE_OK");
    advance(500);
    machine.dispatch("FIRST_BYTES");
    advance(200);
    machine.dispatch("PLAYING");

    const snap = machine.snapshot();
    expect(snap.phase).toBe("playing");
    expect(snap.marks.resolving).toBe(0);
    expect(snap.marks.connecting).toBe(300);
    expect(snap.marks.buffering).toBe(800);
    expect(snap.marks.playing).toBe(1000);
    expect(snap.totalMs).toBe(1000);
    expect(snap.transitions).toBe(4);
  });

  it("非法事件只增加 ignored 计数，不改变阶段", () => {
    const { machine } = machineWithClock();
    machine.dispatch("RESOLVE_START");
    const before = machine.snapshot();
    const after = machine.dispatch("PLAYING");
    expect(after.phase).toBe(before.phase);
    expect(after.ignored).toBe(1);
    expect(after.transitions).toBe(1);
  });

  it("同一阶段内的重复事件不重复计迁移", () => {
    const { machine } = machineWithClock();
    machine.dispatch("RESOLVE_START");
    machine.dispatch("RESOLVE_OK");
    const a = machine.dispatch("METADATA");
    const b = machine.dispatch("CAN_PLAY");
    expect(a.phase).toBe("buffering");
    expect(b.phase).toBe("buffering");
    expect(b.transitions).toBe(3);
  });

  it("elapsedInPhaseMs 随时钟推进", () => {
    const { machine, advance } = machineWithClock();
    machine.dispatch("RESOLVE_START");
    advance(750);
    expect(machine.snapshot().elapsedInPhaseMs).toBe(750);
  });

  it("RESET 清空历史标记并回到 idle", () => {
    const { machine } = machineWithClock();
    machine.dispatch("RESOLVE_START");
    machine.dispatch("RESOLVE_OK");
    const snap = machine.reset();
    expect(snap.phase).toBe("idle");
    expect(snap.marks.resolving).toBeUndefined();
    expect(snap.totalMs).toBe(0);
  });

  it("ERROR 后可经 RESET 重新起播", () => {
    const { machine } = machineWithClock();
    machine.dispatch("RESOLVE_START");
    machine.dispatch("ERROR");
    expect(machine.snapshot().phase).toBe("error");
    machine.dispatch("RESET");
    machine.dispatch("RESOLVE_START");
    expect(machine.snapshot().phase).toBe("resolving");
  });
});

describe("文案与阶段判定", () => {
  it("启动中阶段给出可读文案，播放中不显示提示", () => {
    const startup: PlaybackPhase[] = ["resolving", "connecting", "buffering", "fallback"];
    for (const phase of startup) {
      expect(isStartupPhase(phase)).toBe(true);
      expect(playbackStageLabel(phase)).toBeTruthy();
    }
    expect(isStartupPhase("playing")).toBe(false);
    expect(playbackStageLabel("playing")).toBeNull();
  });

  it("stalled / seeking 有独立文案，便于区分卡顿与跳转", () => {
    const labels = new Set<PlaybackEvent | string>();
    labels.add(playbackStageLabel("stalled") ?? "");
    labels.add(playbackStageLabel("seeking") ?? "");
    expect(labels.size).toBe(2);
    expect(playbackStageLabel("stalled")).toContain("缓冲");
  });
});

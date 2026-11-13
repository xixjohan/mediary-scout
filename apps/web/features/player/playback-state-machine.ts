/**
 * 播放生命周期状态机（纯函数，无 React 依赖）。
 *
 * 为什么需要它：此前「布局阶段 / 是否降级 / 是否在等元数据 / 是否卡顿」散落在
 * useState + useRef + 多个 useEffect 里，排障时无法回答「到底卡在哪一步」，
 * 兜底计时器与 video:waiting 逻辑还会互相覆盖。
 *
 * 设计约束：
 * 1. 迁移表显式声明，非法迁移一律忽略并计数（不抛错，播放链路不能被诊断逻辑打断）；
 * 2. 每次进入新阶段记录 enteredAt 与累计耗时，天然产出分段指标；
 * 3. 布局维度（player-viewport 的 pending/fitted/fallback）与本状态机正交，
 *    互不覆盖——这是 R3 阶段「诊断标记残留」的教训。
 */

export type PlaybackPhase =
  | "idle"
  | "resolving"
  | "connecting"
  | "buffering"
  | "playing"
  | "stalled"
  | "seeking"
  | "fallback"
  | "ended"
  | "error";

export type PlaybackEvent =
  | "RESET"
  | "RESOLVE_START"
  | "RESOLVE_OK"
  | "FIRST_BYTES"
  | "METADATA"
  | "CAN_PLAY"
  | "PLAYING"
  | "WAITING"
  | "PROGRESS"
  | "SEEK_START"
  | "SEEK_END"
  | "FALLBACK"
  | "ERROR"
  | "ENDED";

/** 迁移表：phase → event → next phase。未列出的组合视为非法迁移。 */
const TRANSITIONS: Record<PlaybackPhase, Partial<Record<PlaybackEvent, PlaybackPhase>>> = {
  idle: { RESOLVE_START: "resolving", FALLBACK: "fallback" },
  resolving: { RESOLVE_OK: "connecting", FIRST_BYTES: "connecting", ERROR: "error", FALLBACK: "fallback" },
  connecting: {
    FIRST_BYTES: "buffering",
    METADATA: "buffering",
    CAN_PLAY: "buffering",
    ERROR: "error",
    FALLBACK: "fallback",
  },
  buffering: {
    METADATA: "buffering",
    CAN_PLAY: "buffering",
    PROGRESS: "buffering",
    PLAYING: "playing",
    ERROR: "error",
    FALLBACK: "fallback",
  },
  playing: {
    WAITING: "stalled",
    SEEK_START: "seeking",
    ENDED: "ended",
    ERROR: "error",
    FALLBACK: "fallback",
  },
  stalled: {
    PROGRESS: "playing",
    PLAYING: "playing",
    SEEK_START: "seeking",
    ERROR: "error",
    FALLBACK: "fallback",
  },
  seeking: {
    SEEK_END: "buffering",
    PROGRESS: "playing",
    PLAYING: "playing",
    ERROR: "error",
    FALLBACK: "fallback",
  },
  fallback: {
    FIRST_BYTES: "buffering",
    METADATA: "buffering",
    PLAYING: "playing",
    ERROR: "error",
  },
  ended: { RESET: "idle", RESOLVE_START: "resolving" },
  error: { RESET: "idle", FALLBACK: "fallback", RESOLVE_START: "resolving" },
};

export function nextPhase(phase: PlaybackPhase, event: PlaybackEvent): PlaybackPhase | null {
  return TRANSITIONS[phase][event] ?? null;
}

export interface PlaybackSnapshot {
  phase: PlaybackPhase;
  /** 进入当前阶段的绝对时间戳（ms，由注入的 clock 提供）。 */
  enteredAtMs: number;
  /** 在当前阶段已停留的毫秒数。 */
  elapsedInPhaseMs: number;
  /** 从首次 RESOLVE_START 到当前的总毫秒数。 */
  totalMs: number;
  /** 各阶段首次进入的时间偏移（ms，相对起始点），用于分段耗时。 */
  marks: Partial<Record<PlaybackPhase, number>>;
  /** 成功迁移次数。 */
  transitions: number;
  /** 被忽略的非法迁移次数（诊断用）。 */
  ignored: number;
}

export interface PlaybackMachine {
  dispatch(event: PlaybackEvent): PlaybackSnapshot;
  snapshot(): PlaybackSnapshot;
  reset(): PlaybackSnapshot;
}

export function createPlaybackMachine(options?: {
  clock?: () => number;
  initialPhase?: PlaybackPhase;
}): PlaybackMachine {
  const clock = options?.clock ?? (() => Date.now());
  const startedAt = clock();
  let current: PlaybackPhase = options?.initialPhase ?? "idle";
  let enteredAt = startedAt;
  let origin = startedAt;
  let transitions = 0;
  let ignored = 0;
  const marks: Partial<Record<PlaybackPhase, number>> = { [current]: 0 };

  const build = (): PlaybackSnapshot => {
    const now = clock();
    return {
      phase: current,
      enteredAtMs: enteredAt,
      elapsedInPhaseMs: Math.max(0, now - enteredAt),
      totalMs: Math.max(0, now - origin),
      marks: { ...marks },
      transitions,
      ignored,
    };
  };

  return {
    dispatch(event) {
      if (event === "RESET") {
        current = "idle";
        enteredAt = clock();
        origin = enteredAt;
        transitions += 1;
        for (const key of Object.keys(marks) as PlaybackPhase[]) delete marks[key];
        marks.idle = 0;
        return build();
      }
      const next = nextPhase(current, event);
      if (next === null) {
        ignored += 1;
        return build();
      }
      const now = clock();
      if (current === "idle" && event === "RESOLVE_START") {
        origin = now;
      }
      if (next !== current) {
        current = next;
        enteredAt = now;
        transitions += 1;
      }
      if (marks[current] === undefined) {
        marks[current] = Math.max(0, now - origin);
      }
      return build();
    },
    snapshot: build,
    reset() {
      return this.dispatch("RESET");
    },
  };
}

const STAGE_LABELS: Record<PlaybackPhase, string> = {
  idle: "准备播放",
  resolving: "正在解析直链…",
  connecting: "正在连接网盘 CDN…",
  buffering: "正在读取视频元数据…",
  playing: "正在播放",
  stalled: "缓冲不足，正在等待数据…",
  seeking: "正在跳转…",
  fallback: "直连不可用，已切换代理重试…",
  ended: "播放结束",
  error: "播放失败",
};

/** 面向用户的阶段文案；playing 之后返回 null，由调用方隐藏提示。 */
export function playbackStageLabel(phase: PlaybackPhase): string | null {
  if (phase === "playing" || phase === "idle" || phase === "ended") return null;
  return STAGE_LABELS[phase];
}

/** 是否属于「启动中」阶段（用于展示加载提示）。 */
export function isStartupPhase(phase: PlaybackPhase): boolean {
  return phase === "resolving" || phase === "connecting" || phase === "buffering" || phase === "fallback";
}

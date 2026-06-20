export interface PlaybackStep {
  label: string;
  /** Milliseconds from playback start when this step becomes active. */
  atMs: number;
  /** Progress bar value (0–100) at this step. */
  progress: number;
}

/** A canned, believable agent-acquisition timeline for the read-only demo. Pure
 *  client-side playback — drives a scripted progress bar + action ticker without
 *  ever touching the DB / a real workflow. */
export const DEMO_PLAYBACK_STEPS: PlaybackStep[] = [
  { label: "搜索资源…", atMs: 0, progress: 8 },
  { label: "核对入库目录…", atMs: 6000, progress: 32 },
  { label: "转存到网盘…", atMs: 12000, progress: 66 },
  { label: "验证落盘文件…", atMs: 20000, progress: 88 },
  { label: "入库完成", atMs: 26000, progress: 100 },
];

export const DEMO_PLAYBACK_TOTAL_MS = DEMO_PLAYBACK_STEPS[DEMO_PLAYBACK_STEPS.length - 1]!.atMs;

/** The active step at time t (ms): the last step whose atMs <= t. */
export function playbackStateAt(t: number, steps: PlaybackStep[] = DEMO_PLAYBACK_STEPS): PlaybackStep {
  let current = steps[0]!;
  for (const step of steps) {
    if (t >= step.atMs) {
      current = step;
    }
  }
  return current;
}

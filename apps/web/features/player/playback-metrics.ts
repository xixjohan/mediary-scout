/**
 * 播放链路耗时埋点（opt-in，默认静默）。
 *
 * 与项目已有的 MEDIA_TRACK_AGENT_LOG 约定一致：默认不把播放细节写进日志，
 * 需要在浏览器控制台执行
 *   localStorage.setItem("mediary.player.metrics", "1")
 * 后才会输出，便于在不改业务逻辑的前提下量化首播/拖动优化效果。
 */
const ENABLED_KEY = "mediary.player.metrics";

export type PlaybackMetricName =
  | "T_first_frame"
  | "T_first_byte"
  | "T_seek"
  | "rebuffer"
  | "stream_switch";

export function isPlaybackMetricsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function reportPlaybackMetric(
  name: PlaybackMetricName,
  valueMs: number,
  meta?: Record<string, string | number | boolean>,
): void {
  if (!isPlaybackMetricsEnabled()) return;
  console.info(`[MediaryPlayerMetrics] ${name}`, Math.round(valueMs), meta ?? {});
}

export function startPlaybackTimer(): () => number {
  const started = performance.now();
  return () => performance.now() - started;
}

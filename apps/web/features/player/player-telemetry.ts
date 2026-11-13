/**
 * 播放遥测采样（纯函数为主，可在无 DOM 环境单测）。
 *
 * 与参考实现（油猴脚本 `PlaybackDiagnostics`）的对齐点不是字段数量，而是三条约束：
 * 1. 有界：缓冲区间最多保留 8 段，避免长播内存膨胀；
 * 2. 脱敏：本模块只产出数值与状态枚举，**绝不携带 URL / Cookie / pickCode**；
 * 3. 只读快照：调用方拿到的是一次性快照，不持有 video 元素引用。
 */

export interface VideoTelemetrySource {
  currentTime: number;
  duration: number;
  buffered: ReadonlyArray<readonly [number, number]>;
  readyState: number;
  networkState: number;
  paused: boolean;
  seeking: boolean;
  videoWidth: number;
  videoHeight: number;
  droppedVideoFrames: number | null;
  totalVideoFrames: number | null;
  errorCode: number | null;
}

export interface TelemetrySample extends VideoTelemetrySource {
  /** 当前位置之后的连续缓冲秒数（无缓冲为 0）。 */
  bufferedAheadSeconds: number;
  /** 已缓冲区间总跨度（多段之和，用于识别碎片化缓冲）。 */
  bufferedSpanSeconds: number;
  /** 缓冲增速：每秒播放时间新增多少秒缓冲；采样间隔不足时返回 null。 */
  bufferGrowthPerSecond: number | null;
  /** 丢帧比例（0–1），拿不到质量统计时为 null。 */
  droppedFrameRatio: number | null;
  sampledAtMs: number;
}

const MAX_RANGES = 8;

function normalizeRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const range of ranges.slice(0, MAX_RANGES)) {
    const start = Number(range[0]);
    const end = Number(range[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    out.push([start, end]);
  }
  return out;
}

/** 从真实 media 元素读取快照；所有非标准 API 都做了存在性与异常兜底。 */
export function readVideoTelemetry(video: HTMLVideoElement): VideoTelemetrySource {
  const ranges: Array<[number, number]> = [];
  try {
    const buffered = video.buffered;
    for (let i = 0; i < buffered.length && i < MAX_RANGES; i += 1) {
      ranges.push([buffered.start(i), buffered.end(i)]);
    }
  } catch {
    // buffered 在 MEDIA_ERR 后可能抛错，忽略即可
  }

  let dropped: number | null = null;
  let total: number | null = null;
  try {
    if (typeof video.getVideoPlaybackQuality === "function") {
      const quality = video.getVideoPlaybackQuality();
      dropped = Number.isFinite(quality.droppedVideoFrames) ? quality.droppedVideoFrames : null;
      total = Number.isFinite(quality.totalVideoFrames) ? quality.totalVideoFrames : null;
    }
  } catch {
    dropped = null;
    total = null;
  }

  return {
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    buffered: ranges,
    readyState: video.readyState,
    networkState: video.networkState,
    paused: video.paused,
    seeking: video.seeking,
    videoWidth: video.videoWidth || 0,
    videoHeight: video.videoHeight || 0,
    droppedVideoFrames: dropped,
    totalVideoFrames: total,
    errorCode: video.error?.code ?? null,
  };
}

export function bufferedAhead(
  currentTime: number,
  ranges: ReadonlyArray<readonly [number, number]>,
): number {
  let ahead = 0;
  for (const [start, end] of ranges) {
    if (currentTime >= start - 0.001 && currentTime <= end) {
      ahead = Math.max(ahead, end - currentTime);
    }
  }
  return Math.max(0, ahead);
}

export function bufferedSpan(ranges: ReadonlyArray<readonly [number, number]>): number {
  return ranges.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0);
}

export function buildTelemetrySample(
  source: VideoTelemetrySource,
  previous?: { bufferedAheadSeconds: number; sampledAtMs: number } | undefined,
  nowMs: number = Date.now(),
): TelemetrySample {
  const ranges = normalizeRanges(source.buffered);
  const ahead = bufferedAhead(source.currentTime, ranges);
  const span = bufferedSpan(ranges);

  let growth: number | null = null;
  if (previous) {
    const deltaMs = nowMs - previous.sampledAtMs;
    if (deltaMs >= 250) {
      const deltaSeconds = deltaMs / 1000;
      const added = ahead - previous.bufferedAheadSeconds;
      // 跳转或清空缓冲会让 ahead 骤降，此时增速没有意义。
      if (added >= -1) growth = Math.max(0, added) / deltaSeconds;
    }
  }

  const ratio =
    source.droppedVideoFrames !== null && source.totalVideoFrames !== null && source.totalVideoFrames > 0
      ? source.droppedVideoFrames / source.totalVideoFrames
      : null;

  return {
    ...source,
    buffered: ranges,
    bufferedAheadSeconds: ahead,
    bufferedSpanSeconds: span,
    bufferGrowthPerSecond: growth,
    droppedFrameRatio: ratio,
    sampledAtMs: nowMs,
  };
}

const READY_STATE_LABELS = ["HAVE_NOTHING", "HAVE_METADATA", "HAVE_CURRENT_DATA", "HAVE_FUTURE_DATA", "HAVE_ENOUGH_DATA"];
const NETWORK_STATE_LABELS = ["NETWORK_EMPTY", "NETWORK_IDLE", "NETWORK_LOADING", "NETWORK_NO_SOURCE"];

export function describeReadyState(value: number): string {
  return READY_STATE_LABELS[value] ?? `READY_${value}`;
}

export function describeNetworkState(value: number): string {
  return NETWORK_STATE_LABELS[value] ?? `NETWORK_${value}`;
}

/** 秒 → mm:ss / h:mm:ss。未知时长统一显示 --:--。 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatBufferRanges(ranges: ReadonlyArray<readonly [number, number]>): string {
  if (ranges.length === 0) return "无";
  return ranges.map(([start, end]) => `${start.toFixed(1)}-${end.toFixed(1)}s`).join(", ");
}

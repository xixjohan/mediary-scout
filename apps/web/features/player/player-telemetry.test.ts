import { describe, expect, it } from "vitest";
import {
  bufferedAhead,
  bufferedSpan,
  buildTelemetrySample,
  describeNetworkState,
  describeReadyState,
  formatBufferRanges,
  formatClock,
  type VideoTelemetrySource,
} from "./player-telemetry";

function source(overrides: Partial<VideoTelemetrySource> = {}): VideoTelemetrySource {
  return {
    currentTime: 10,
    duration: 600,
    buffered: [[0, 30]],
    readyState: 4,
    networkState: 2,
    paused: false,
    seeking: false,
    videoWidth: 1920,
    videoHeight: 1080,
    droppedVideoFrames: 0,
    totalVideoFrames: 0,
    errorCode: null,
    ...overrides,
  };
}

describe("bufferedAhead", () => {
  it("取包含当前位置的那段缓冲的剩余量", () => {
    expect(bufferedAhead(10, [[0, 30]])).toBe(20);
  });

  it("多段缓冲时取覆盖当前位置的段，不被后段干扰", () => {
    expect(bufferedAhead(35, [[0, 30], [40, 80]])).toBe(0);
    expect(bufferedAhead(45, [[0, 30], [40, 80]])).toBe(35);
  });

  it("当前位置不在任何区间内时为 0", () => {
    expect(bufferedAhead(120, [[0, 30]])).toBe(0);
  });
});

describe("buildTelemetrySample", () => {
  it("汇总缓冲裕量、跨度与丢帧比例", () => {
    const sample = buildTelemetrySample(
      source({ buffered: [[0, 30], [40, 50]], droppedVideoFrames: 5, totalVideoFrames: 200 }),
      undefined,
      1000,
    );
    expect(sample.bufferedAheadSeconds).toBe(20);
    expect(sample.bufferedSpanSeconds).toBe(40);
    expect(sample.droppedFrameRatio).toBeCloseTo(0.025);
    expect(sample.bufferGrowthPerSecond).toBeNull();
  });

  it("按采样间隔计算缓冲增速", () => {
    // 2s 内缓冲裕量由 20s 增至 30s → 5s 缓冲/秒
    const sample = buildTelemetrySample(source({ currentTime: 10, buffered: [[0, 40]] }), {
      bufferedAheadSeconds: 20,
      sampledAtMs: 1000,
    }, 3000);
    expect(sample.bufferGrowthPerSecond).toBeCloseTo(5);
  });

  it("采样间隔过短或跳转导致缓冲回退时不给增速", () => {
    const tooShort = buildTelemetrySample(source(), { bufferedAheadSeconds: 5, sampledAtMs: 1000 }, 1100);
    expect(tooShort.bufferGrowthPerSecond).toBeNull();

    const seeked = buildTelemetrySample(
      source({ currentTime: 500, buffered: [[500, 505]] }),
      { bufferedAheadSeconds: 20, sampledAtMs: 1000 },
      3000,
    );
    expect(seeked.bufferGrowthPerSecond).toBeNull();
  });

  it("缓冲区间上限 8 段，避免长播膨胀", () => {
    const many: Array<[number, number]> = Array.from({ length: 20 }, (_, i) => [i * 10, i * 10 + 5]);
    const sample = buildTelemetrySample(source({ buffered: many }), undefined, 0);
    expect(sample.buffered).toHaveLength(8);
  });

  it("非法区间被过滤，不产生 NaN", () => {
    const sample = buildTelemetrySample(
      source({ buffered: [[10, 5], [Number.NaN, 3], [0, 20]] as Array<[number, number]> }),
      undefined,
      0,
    );
    expect(sample.buffered).toEqual([[0, 20]]);
    expect(Number.isNaN(sample.bufferedSpanSeconds)).toBe(false);
  });

  it("拿不到质量统计时丢帧比例为 null", () => {
    const sample = buildTelemetrySample(
      source({ droppedVideoFrames: null, totalVideoFrames: null }),
      undefined,
      0,
    );
    expect(sample.droppedFrameRatio).toBeNull();
  });
});

describe("展示格式化", () => {
  it("状态枚举有可读名称，未知值不崩", () => {
    expect(describeReadyState(4)).toBe("HAVE_ENOUGH_DATA");
    expect(describeReadyState(9)).toBe("READY_9");
    expect(describeNetworkState(2)).toBe("NETWORK_LOADING");
    expect(describeNetworkState(9)).toBe("NETWORK_9");
  });

  it("时长格式化为 mm:ss / h:mm:ss", () => {
    expect(formatClock(65)).toBe("01:05");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(Number.NaN)).toBe("--:--");
    expect(formatClock(-1)).toBe("--:--");
  });

  it("缓冲区间格式化，空区间显示无", () => {
    expect(formatBufferRanges([])).toBe("无");
    expect(formatBufferRanges([[0, 12.34]])).toBe("0.0-12.3s");
  });
});

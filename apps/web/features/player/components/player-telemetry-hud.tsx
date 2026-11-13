"use client";

import type { CSSProperties } from "react";
import {
  describeNetworkState,
  describeReadyState,
  formatBufferRanges,
  formatClock,
  type TelemetrySample,
} from "../player-telemetry";
import type { PlaybackPhase } from "../playback-state-machine";

export type TelemetryLevel = "off" | "compact" | "detail";

export interface PlayerTelemetryHudProps {
  level: Exclude<TelemetryLevel, "off">;
  sample: TelemetrySample | null;
  phase: PlaybackPhase;
  delivery?: { mode?: string | undefined; source?: string | undefined } | undefined;
}

const panelStyle: CSSProperties = {
  position: "absolute",
  top: 52,
  right: 12,
  zIndex: 30,
  maxWidth: "min(360px, calc(100% - 24px))",
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(0, 0, 0, 0.62)",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  color: "#f4f4f5",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  lineHeight: 1.7,
  pointerEvents: "none",
  whiteSpace: "pre-wrap",
};

export function PlayerTelemetryHud({ level, sample, phase, delivery }: PlayerTelemetryHudProps) {
  if (!sample) {
    return (
      <div style={panelStyle} data-testid="player-telemetry-hud">
        播放统计：等待采样…
      </div>
    );
  }

  const ahead = sample.bufferedAheadSeconds;
  const growth = sample.bufferGrowthPerSecond;
  const growthText = growth === null ? "—" : `${growth.toFixed(1)} s/s`;
  const droppedText =
    sample.droppedFrameRatio === null ? "—" : `${(sample.droppedFrameRatio * 100).toFixed(1)}%`;

  const lines = [
    `进度 ${formatClock(sample.currentTime)} / ${formatClock(sample.duration)}`,
    `缓冲 ${ahead.toFixed(1)}s · 增速 ${growthText}`,
  ];

  if (level === "detail") {
    lines.push(
      `就绪 ${describeReadyState(sample.readyState)} · 网络 ${describeNetworkState(sample.networkState)}`,
      `缓冲区间 ${formatBufferRanges(sample.buffered)}`,
      `画面 ${sample.videoWidth}×${sample.videoHeight} · 丢帧 ${droppedText}`,
      `阶段 ${phase}${sample.paused ? " · 暂停" : ""}${sample.seeking ? " · 跳转中" : ""}`,
      `投送 ${delivery?.mode ?? "—"}${delivery?.source ? ` (${delivery.source})` : ""}`,
    );
    if (sample.errorCode !== null) {
      lines.push(`原生错误 code=${sample.errorCode}`);
    }
  }

  return (
    <div style={panelStyle} data-testid="player-telemetry-hud" data-level={level}>
      {lines.join("\n")}
    </div>
  );
}

/**
 * 播放器视口适配策略（P1 收尾 + P2-A）。
 *
 * 设计约束（见 docs/research/2026-11-13-player-viewport-fit-and-delivery-mode-resolution-research.md §2.3）：
 * 1. 容器恒为 100% 填充（autoSize:false），控制条贴底是**不变量**，任何画面适配
 *    都只能作用于 video 层，不得回写 $player 的宽高或 aspect-ratio。
 * 2. 布局不得隐式依赖视频元数据：videoWidth=0 / 加载失败必须落到确定性 fallback。
 * 3. 竖屏与超宽片源有专用策略，禁止用 cover 硬裁竖屏（切头切尾）。
 *
 * 本文件只做纯计算，不触碰 DOM——便于单测覆盖四种片源比例与两种窗口尺寸。
 */

export type LayoutPhase = "pending" | "fitted" | "fallback";

export type VideoFitMode = "contain" | "cover" | "fill";

export type ViewportFitKind =
  | "pending"
  | "fallback"
  | "portrait"
  | "ultrawide"
  | "standard";

/** 竖屏判定阈值：低于该宽高比视为竖屏。 */
export const PORTRAIT_RATIO_THRESHOLD = 0.8;
/** 超宽判定阈值：高于该宽高比视为超宽（含 2.39:1 之外的 2.76:1 等）。 */
export const ULTRAWIDE_RATIO_THRESHOLD = 2.4;

export interface LayoutProbe {
  videoWidth: number;
  videoHeight: number;
  hasError?: boolean | undefined;
}

/**
 * pending → fitted / fallback 的显式判定。
 * 组件在 loadedmetadata、error 以及元数据超时三个时机调用它；
 * videoWidth=0（凭据失效、格式不支持、元数据拿不到）一律视为 fallback。
 */
export function resolveLayoutPhase(probe: LayoutProbe): LayoutPhase {
  if (probe.hasError) return "fallback";
  const { videoWidth, videoHeight } = probe;
  if (
    !Number.isFinite(videoWidth) ||
    !Number.isFinite(videoHeight) ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    return "fallback";
  }
  return "fitted";
}

export interface VideoFitInput {
  layoutPhase: LayoutPhase;
  videoWidth: number;
  videoHeight: number;
  containerWidth: number;
  containerHeight: number;
  userFitMode: VideoFitMode;
}

export interface VideoFitDecision {
  kind: ViewportFitKind;
  objectFit: VideoFitMode;
  /** 竖屏专用：按「容器高度 × 源比例」折算出的最大画面宽度（px）。 */
  maxWidthPx: number | null;
  sourceRatio: number | null;
  reason: string;
}

/**
 * 依据「布局阶段 × 源比例 × 容器尺寸 × 用户策略」计算 video 层适配结果。
 *
 * - pending / fallback：强制 contain，清除所有几何覆写，保证控制条位置不变量。
 * - 竖屏（< 0.8）：禁用 cover，按容器高度等比限制画面宽度并居中。
 * - 超宽（> 2.4）：否决 cover（避免裁掉两侧画面 / 字幕），保留 contain 的上下黑边。
 * - 常规比例：完全尊重用户选择的 contain / cover / fill。
 */
export function resolveVideoFit(input: VideoFitInput): VideoFitDecision {
  if (input.layoutPhase !== "fitted") {
    const pending = input.layoutPhase === "pending";
    return {
      kind: pending ? "pending" : "fallback",
      objectFit: "contain",
      maxWidthPx: null,
      sourceRatio: null,
      reason: pending
        ? "等待视频元数据，保持确定性 contain 布局"
        : "视频元数据缺失或加载失败，强制 contain 兜底",
    };
  }

  const ratio = input.videoWidth / input.videoHeight;
  const containerUsable = input.containerWidth > 0 && input.containerHeight > 0;

  if (ratio < PORTRAIT_RATIO_THRESHOLD) {
    return {
      kind: "portrait",
      objectFit: "contain",
      maxWidthPx: containerUsable
        ? Math.max(
            1,
            Math.min(
              Math.round(input.containerWidth),
              Math.round(input.containerHeight * ratio),
            ),
          )
        : null,
      sourceRatio: ratio,
      reason: "竖屏片源：禁用 cover 硬裁，按容器高度等比居中并限制最大宽度",
    };
  }

  if (ratio > ULTRAWIDE_RATIO_THRESHOLD) {
    return {
      kind: "ultrawide",
      objectFit: input.userFitMode === "cover" ? "contain" : input.userFitMode,
      maxWidthPx: null,
      sourceRatio: ratio,
      reason: "超宽片源：否决 cover 裁切，保留完整画面（上下黑边由 video 承担）",
    };
  }

  return {
    kind: "standard",
    objectFit: input.userFitMode,
    maxWidthPx: null,
    sourceRatio: ratio,
    reason: `常规比例，按用户策略 ${input.userFitMode} 适配`,
  };
}

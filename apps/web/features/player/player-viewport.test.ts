import { describe, expect, it } from "vitest";
import {
  PORTRAIT_RATIO_THRESHOLD,
  ULTRAWIDE_RATIO_THRESHOLD,
  resolveLayoutPhase,
  resolveVideoFit,
  type VideoFitInput,
} from "./player-viewport";

const CONTAINER = { width: 1440, height: 810 };

function fit(overrides: Partial<VideoFitInput> = {}) {
  return resolveVideoFit({
    layoutPhase: "fitted",
    videoWidth: 1920,
    videoHeight: 1080,
    containerWidth: CONTAINER.width,
    containerHeight: CONTAINER.height,
    userFitMode: "contain",
    ...overrides,
  });
}

describe("resolveLayoutPhase（P1 布局 fallback 显式化）", () => {
  it("拿到有效元数据 → fitted", () => {
    expect(resolveLayoutPhase({ videoWidth: 1920, videoHeight: 1080 })).toBe("fitted");
  });

  it("videoWidth=0（凭据失效 / 元数据缺失）→ fallback", () => {
    expect(resolveLayoutPhase({ videoWidth: 0, videoHeight: 0 })).toBe("fallback");
    expect(resolveLayoutPhase({ videoWidth: 0, videoHeight: 1080 })).toBe("fallback");
  });

  it("播放错误 → fallback", () => {
    expect(
      resolveLayoutPhase({ videoWidth: 1920, videoHeight: 1080, hasError: true }),
    ).toBe("fallback");
  });

  it("非有限值 / 负数不会误判为 fitted", () => {
    expect(
      resolveLayoutPhase({ videoWidth: Number.NaN, videoHeight: 1080 }),
    ).toBe("fallback");
    expect(resolveLayoutPhase({ videoWidth: -1, videoHeight: 1080 })).toBe("fallback");
  });
});

describe("resolveVideoFit（容器填充不变量 + 四类片源）", () => {
  it("pending 与 fallback 均强制 contain，且清除几何覆写", () => {
    for (const phase of ["pending", "fallback"] as const) {
      const decision = fit({ layoutPhase: phase, userFitMode: "cover" });
      expect(decision.kind).toBe(phase);
      expect(decision.objectFit).toBe("contain");
      expect(decision.maxWidthPx).toBeNull();
    }
  });

  it("16:9 与 4:3 走用户策略（含 fill）", () => {
    expect(fit().kind).toBe("standard");
    expect(fit({ userFitMode: "cover" }).objectFit).toBe("cover");
    expect(fit({ userFitMode: "fill" }).objectFit).toBe("fill");
    expect(fit({ videoWidth: 1440, videoHeight: 1080 }).kind).toBe("standard");
  });

  it("2.39:1 仍属常规区间，只有超过阈值才是超宽", () => {
    const scope = fit({ videoWidth: 2390, videoHeight: 1000 });
    expect(scope.sourceRatio).toBeLessThan(ULTRAWIDE_RATIO_THRESHOLD);
    expect(scope.kind).toBe("standard");
  });

  it("超宽 2.76:1 否决 cover，保留 contain 的完整画面", () => {
    const decision = fit({ videoWidth: 2760, videoHeight: 1000, userFitMode: "cover" });
    expect(decision.kind).toBe("ultrawide");
    expect(decision.objectFit).toBe("contain");
    expect(decision.maxWidthPx).toBeNull();
  });

  it("竖屏 9:16 禁用 cover 硬裁，按容器高度等比限宽", () => {
    const decision = fit({ videoWidth: 1080, videoHeight: 1920, userFitMode: "cover" });
    expect(decision.sourceRatio).toBeLessThan(PORTRAIT_RATIO_THRESHOLD);
    expect(decision.kind).toBe("portrait");
    expect(decision.objectFit).toBe("contain");
    // 810 * (1080/1920) = 456
    expect(decision.maxWidthPx).toBe(456);
  });

  it("竖屏在 fill 下依然受保护，且容器尺寸未知时不做几何覆写", () => {
    expect(fit({ videoWidth: 1080, videoHeight: 1920, userFitMode: "fill" }).objectFit).toBe(
      "contain",
    );
    const unknown = fit({
      videoWidth: 1080,
      videoHeight: 1920,
      containerWidth: 0,
      containerHeight: 0,
    });
    expect(unknown.kind).toBe("portrait");
    expect(unknown.maxWidthPx).toBeNull();
  });

  it("超宽窗口下竖屏宽度受容器宽度上限约束", () => {
    const decision = fit({
      videoWidth: 1080,
      videoHeight: 1920,
      containerWidth: 3440,
      containerHeight: 1440,
    });
    expect(decision.maxWidthPx).toBe(810);
    expect(decision.maxWidthPx).toBeLessThanOrEqual(3440);
  });
});

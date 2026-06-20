import { describe, expect, it } from "vitest";
import { playbackStateAt, DEMO_PLAYBACK_STEPS, DEMO_PLAYBACK_TOTAL_MS } from "./demo-playback-timeline";

describe("demo playback timeline", () => {
  it("t=0 → first step", () => {
    expect(playbackStateAt(0).label).toBe(DEMO_PLAYBACK_STEPS[0]!.label);
  });
  it("mid → the step whose atMs just passed", () => {
    expect(playbackStateAt(13000).label).toBe("转存到网盘…");
  });
  it("past the end → 100% 入库完成", () => {
    const end = playbackStateAt(DEMO_PLAYBACK_TOTAL_MS + 9999);
    expect(end.progress).toBe(100);
    expect(end.label).toBe("入库完成");
  });
  it("progress is monotonic non-decreasing", () => {
    let prev = -1;
    for (let t = 0; t <= DEMO_PLAYBACK_TOTAL_MS; t += 1000) {
      const p = playbackStateAt(t).progress;
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

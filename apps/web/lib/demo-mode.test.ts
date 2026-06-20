import { describe, expect, it } from "vitest";
import { isDemoModeFromEnv, assertNotDemoFromEnv, DemoReadOnlyError } from "./demo-mode";

describe("demo-mode", () => {
  it("isDemoModeFromEnv true only when flag is '1'", () => {
    expect(isDemoModeFromEnv({ MEDIA_TRACK_DEMO_MODE: "1" })).toBe(true);
    expect(isDemoModeFromEnv({ MEDIA_TRACK_DEMO_MODE: "0" })).toBe(false);
    expect(isDemoModeFromEnv({})).toBe(false);
  });
  it("assertNotDemoFromEnv throws DemoReadOnlyError in demo mode, no-op otherwise", () => {
    expect(() => assertNotDemoFromEnv({ MEDIA_TRACK_DEMO_MODE: "1" })).toThrow(DemoReadOnlyError);
    expect(() => assertNotDemoFromEnv({})).not.toThrow();
  });
});

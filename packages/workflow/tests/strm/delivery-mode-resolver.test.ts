import { describe, expect, it } from "vitest";
import { resolveDeliveryMode } from "../../src/strm/delivery-mode-resolver.js";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const POTPLAYER_UA = "PotPlayer/1.7.22077 (Windows NT 10.0; Win64; x64)";

describe("投送模式解析责任链", () => {
  it("session 覆盖 binding 与 library", () => {
    const decision = resolveDeliveryMode({
      sessionOverride: "proxy",
      bindingMode: "redirect",
      libraryMode: "redirect",
      userAgent: CHROME_UA,
    });
    expect(decision.mode).toBe("proxy");
    expect(decision.source).toBe("session");
  });

  it("binding 非 inherit 时覆盖 library", () => {
    const decision = resolveDeliveryMode({
      bindingMode: "proxy",
      libraryMode: "redirect",
      userAgent: CHROME_UA,
    });
    expect(decision.mode).toBe("proxy");
    expect(decision.source).toBe("binding");
  });

  it("binding=inherit 时向上继承 library", () => {
    const decision = resolveDeliveryMode({
      bindingMode: "inherit",
      libraryMode: "proxy",
      userAgent: CHROME_UA,
    });
    expect(decision.mode).toBe("proxy");
    expect(decision.source).toBe("library");
  });

  it("全空时通用驱动 + 浏览器 UA 走 auto 策略 → redirect", () => {
    const decision = resolveDeliveryMode({ userAgent: CHROME_UA });
    expect(decision.mode).toBe("redirect");
    expect(decision.source).toBe("default");
  });

  it("全空时 115 走 auto 策略 → proxy", () => {
    const decision = resolveDeliveryMode({ provider: "pan115", userAgent: CHROME_UA });
    expect(decision.mode).toBe("proxy");
    expect(decision.source).toBe("default");
  });

  it("夸克物理约束否决用户 redirect 配置", () => {
    const decision = resolveDeliveryMode({
      libraryMode: "redirect",
      provider: "quark",
      userAgent: CHROME_UA,
    });
    expect(decision.mode).toBe("proxy");
    expect(decision.source).toBe("driver-rule");
    expect(decision.reason).toContain("quark");
  });

  it("115 + 高危播放器 UA 时安全回退 proxy", () => {
    const decision = resolveDeliveryMode({
      libraryMode: "redirect",
      provider: "pan115",
      userAgent: POTPLAYER_UA,
    });
    expect(decision.mode).toBe("proxy");
    expect(decision.source).toBe("driver-rule");
  });

  it("115 + 标准浏览器 + 用户显式 redirect 时尊重配置", () => {
    const decision = resolveDeliveryMode({
      libraryMode: "redirect",
      provider: "pan115",
      userAgent: CHROME_UA,
    });
    expect(decision.mode).toBe("redirect");
    expect(decision.source).toBe("library");
  });

  it("用户显式 proxy 不会被驱动降级", () => {
    const decision = resolveDeliveryMode({
      libraryMode: "proxy",
      provider: "pan115",
      userAgent: CHROME_UA,
    });
    expect(decision.mode).toBe("proxy");
    expect(decision.source).toBe("library");
  });

  it("session 显式 redirect 优先于 binding proxy", () => {
    const decision = resolveDeliveryMode({
      sessionOverride: "redirect",
      bindingMode: "proxy",
      provider: "pan115",
      userAgent: CHROME_UA,
    });
    expect(decision.mode).toBe("redirect");
    expect(decision.source).toBe("session");
  });

  it("global 在 library 缺省时生效", () => {
    const decision = resolveDeliveryMode({
      globalMode: "proxy",
      userAgent: CHROME_UA,
    });
    expect(decision.mode).toBe("proxy");
    expect(decision.source).toBe("global");
  });

  it("始终返回可读 reason，便于排障", () => {
    const decision = resolveDeliveryMode({ libraryMode: "proxy", userAgent: CHROME_UA });
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.reason).toContain("library");
  });
});

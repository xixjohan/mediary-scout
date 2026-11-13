import { describe, expect, it } from "vitest";
import {
  normalizeUserAgentCategory,
  isUserAgentProneToRedirectFailure,
  determineEffectiveDeliveryMode,
  buildStrmLinkCacheKey,
} from "../../src/strm/strm-delivery.js";

describe("STRM Delivery and Cache Key Module (strm-delivery.ts)", () => {
  describe("normalizeUserAgentCategory", () => {
    it("正确归类常见媒体播放器", () => {
      expect(normalizeUserAgentCategory("PotPlayer64/23.09.05")).toBe("potplayer");
      expect(normalizeUserAgentCategory("PotPlayer/1.7.21566")).toBe("potplayer");
      expect(normalizeUserAgentCategory("VidHub/3.0.2")).toBe("vidhub");
      expect(normalizeUserAgentCategory("Infuse-Core/7.5.1")).toBe("infuse");
      expect(normalizeUserAgentCategory("VLC/3.0.18 LibVLC/3.0.18")).toBe("vlc");
      expect(normalizeUserAgentCategory("mpv 0.35.1")).toBe("mpv");
      expect(normalizeUserAgentCategory("PlexMediaServer/1.32.5")).toBe("plex");
      expect(normalizeUserAgentCategory("Lavf/58.76.100")).toBe("ffmpeg");
    });

    it("正确归类主流桌面与移动端浏览器", () => {
      expect(normalizeUserAgentCategory("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36")).toBe("chrome");
      expect(normalizeUserAgentCategory("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/126.0.0.0")).toBe("edge");
      expect(normalizeUserAgentCategory("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15")).toBe("safari");
      expect(normalizeUserAgentCategory("Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/115.0")).toBe("firefox");
    });

    it("空值与未识别 UA 稳健降级", () => {
      expect(normalizeUserAgentCategory(null)).toBe("anonymous");
      expect(normalizeUserAgentCategory("")).toBe("anonymous");
      expect(normalizeUserAgentCategory("   ")).toBe("anonymous");
      expect(normalizeUserAgentCategory("CustomClient/1.0")).toBe("other");
    });
  });

  describe("isUserAgentProneToRedirectFailure", () => {
    it("PotPlayer, VLC, MPV, FFmpeg 及空 UA 判定为高危重定向播放器", () => {
      expect(isUserAgentProneToRedirectFailure("PotPlayer64")).toBe(true);
      expect(isUserAgentProneToRedirectFailure("VLC/3.0")).toBe(true);
      expect(isUserAgentProneToRedirectFailure("libmpv")).toBe(true);
      expect(isUserAgentProneToRedirectFailure("Lavf/58.29.100")).toBe(true);
      expect(isUserAgentProneToRedirectFailure("")).toBe(true);
      expect(isUserAgentProneToRedirectFailure(null)).toBe(true);
    });

    it("桌面浏览器及原生支持直连播放器判定为安全直连", () => {
      expect(isUserAgentProneToRedirectFailure("Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36")).toBe(false);
      expect(isUserAgentProneToRedirectFailure("Infuse/7.5")).toBe(false);
      expect(isUserAgentProneToRedirectFailure("VidHub/3.0.2")).toBe(false);
    });
  });

  describe("determineEffectiveDeliveryMode", () => {
    it("显式配置为 proxy 时，无条件返回 proxy", () => {
      expect(determineEffectiveDeliveryMode({ configuredMode: "proxy", provider: "pan115" })).toBe("proxy");
      expect(determineEffectiveDeliveryMode({ configuredMode: "proxy", provider: "generic" })).toBe("proxy");
    });

    it("Quark 与 UC 网盘驱动硬性约束返回 proxy", () => {
      expect(determineEffectiveDeliveryMode({ configuredMode: "redirect", provider: "quark" })).toBe("proxy");
      expect(determineEffectiveDeliveryMode({ configuredMode: "auto", provider: "uc" })).toBe("proxy");
    });

    it("115 网盘驱动针对 PotPlayer 即使配置了 redirect 也自适应回退到 proxy", () => {
      const mode = determineEffectiveDeliveryMode({
        configuredMode: "redirect",
        provider: "pan115",
        userAgent: "PotPlayer64/23.09.05",
      });
      expect(mode).toBe("proxy");
    });

    it("115 网盘驱动针对 Chrome 允许 redirect 直连", () => {
      const mode = determineEffectiveDeliveryMode({
        configuredMode: "redirect",
        provider: "pan115",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36",
      });
      expect(mode).toBe("redirect");
    });

    it("115 网盘在 auto 或未传模式时默认安全走 proxy", () => {
      expect(determineEffectiveDeliveryMode({ configuredMode: "auto", provider: "pan115" })).toBe("proxy");
      expect(determineEffectiveDeliveryMode({ provider: "pan115" })).toBe("proxy");
    });

    it("通用驱动配置 auto 时，PotPlayer 走 proxy，Chrome 走 redirect", () => {
      expect(determineEffectiveDeliveryMode({
        configuredMode: "auto",
        provider: "generic",
        userAgent: "PotPlayer",
      })).toBe("proxy");

      expect(determineEffectiveDeliveryMode({
        configuredMode: "auto",
        provider: "generic",
        userAgent: "Mozilla/5.0 Chrome/126.0",
      })).toBe("redirect");
    });
  });

  describe("buildStrmLinkCacheKey", () => {
    it("proxy 模式下统一生成 shared 缓存键，供所有播放器复用", () => {
      const key1 = buildStrmLinkCacheKey({
        storageId: "cs_115",
        fileId: "file_99",
        deliveryMode: "proxy",
        userAgent: "PotPlayer64",
      });
      const key2 = buildStrmLinkCacheKey({
        storageId: "cs_115",
        fileId: "file_99",
        deliveryMode: "proxy",
        userAgent: "Mozilla/5.0 Chrome/126",
      });
      expect(key1).toBe("cs_115:file_99:proxy:shared");
      expect(key2).toBe("cs_115:file_99:proxy:shared");
      expect(key1).toBe(key2);
    });

    it("redirect 模式下按 UA 分组隔离，彻底防止 Chrome UA 污染 PotPlayer", () => {
      const chromeKey = buildStrmLinkCacheKey({
        storageId: "cs_115",
        fileId: "file_99",
        deliveryMode: "redirect",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36",
      });
      const potKey = buildStrmLinkCacheKey({
        storageId: "cs_115",
        fileId: "file_99",
        deliveryMode: "redirect",
        userAgent: "PotPlayer64/23.09.05",
      });
      expect(chromeKey).toBe("cs_115:file_99:redirect:chrome");
      expect(potKey).toBe("cs_115:file_99:redirect:potplayer");
      expect(chromeKey).not.toBe(potKey);
    });
  });
});

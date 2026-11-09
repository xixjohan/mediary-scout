import { describe, expect, it } from "vitest";
import {
  extractUrlAndPasscode,
  detectProtocol,
  evaluateIngestItem,
  parseBatchIngestInput,
  getDriveCapability,
} from "./ingest-protocol-router";

describe("ingest-protocol-router", () => {
  describe("extractUrlAndPasscode", () => {
    it("extracts clean URL and natural language passcode", () => {
      const line = "链接：https://pan.quark.cn/s/60e73719ddb8 提取码：nN4v";
      const result = extractUrlAndPasscode(line);
      expect(result.url).toBe("https://pan.quark.cn/s/60e73719ddb8");
      expect(result.passcode).toBe("nN4v");
    });

    it("extracts passcode from URL query", () => {
      const line = "https://115.com/s/sw3abcd?password=6666";
      const result = extractUrlAndPasscode(line);
      expect(result.url).toBe("https://115.com/s/sw3abcd?password=6666");
      expect(result.passcode).toBe("6666");
    });

    it("extracts 123pan pwd query and handles hash fragment", () => {
      const line = "https://www.123pan.com/s/abc-1?pwd=x8fd#download";
      const result = extractUrlAndPasscode(line);
      expect(result.url).toBe("https://www.123pan.com/s/abc-1?pwd=x8fd#download");
      expect(result.passcode).toBe("x8fd");
    });

    it("extracts pure magnet link", () => {
      const line = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Test";
      const result = extractUrlAndPasscode(line);
      expect(result.url).toBe("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Test");
      expect(result.passcode).toBeUndefined();
    });

    it("ignores comment lines", () => {
      const line = "# this is a comment";
      const result = extractUrlAndPasscode(line);
      expect(result.url).toBe("");
    });
  });

  describe("detectProtocol", () => {
    it("detects quark share links", () => {
      expect(detectProtocol("https://pan.quark.cn/s/60e73719ddb8")).toEqual({
        protocol: "quark_share",
        shareCode: "60e73719ddb8",
        matchedBrand: "quark",
      });
      expect(detectProtocol("https://drive.uc.cn/s/abcdef123")).toEqual({
        protocol: "quark_share",
        shareCode: "abcdef123",
        matchedBrand: "quark",
      });
    });

    it("detects 115 share links", () => {
      expect(detectProtocol("https://115.com/s/sw3abcd?password=1234")).toEqual({
        protocol: "pan115_share",
        shareCode: "sw3abcd",
        matchedBrand: "pan115",
      });
    });

    it("detects 123pan share links", () => {
      expect(detectProtocol("https://www.123pan.com/s/Kd9-TvBq")).toEqual({
        protocol: "pan123_share",
        shareCode: "Kd9-TvBq",
        matchedBrand: "pan123",
      });
    });

    it("detects tianyi share links", () => {
      expect(detectProtocol("https://cloud.189.cn/t/QzUnmqBvYr2q")).toEqual({
        protocol: "tianyi_share",
        shareCode: "QzUnmqBvYr2q",
        matchedBrand: "tianyi",
      });
    });

    it("detects offline schemes", () => {
      expect(detectProtocol("magnet:?xt=urn:btih:xxx").protocol).toBe("offline");
      expect(detectProtocol("ed2k://|file|test|123|abc|/").protocol).toBe("offline");
      expect(detectProtocol("https://example.com/movie.mp4").protocol).toBe("offline");
    });
  });

  describe("evaluateIngestItem and parseBatchIngestInput", () => {
    it("matches quark share when current provider is quark", () => {
      const line = "链接: https://pan.quark.cn/s/60e73719ddb8 密码: 1234";
      const item = evaluateIngestItem(line, "quark", 0);
      expect(item.isValid).toBe(true);
      expect(item.action).toBe("share_transfer");
      expect(item.matchedBrand).toBe("quark");
      expect(item.passcode).toBe("1234");
    });

    it("rejects 115 share when current provider is quark with friendly hint", () => {
      const line = "https://115.com/s/sw3abcd";
      const item = evaluateIngestItem(line, "quark", 0);
      expect(item.isValid).toBe(false);
      expect(item.action).toBe("unsupported_brand");
      expect(item.reason).toContain("当前选择的网盘是【夸克网盘】");
    });

    it("rejects magnet when current provider is quark with friendly hint", () => {
      const line = "magnet:?xt=urn:btih:0123456789abcdef";
      const item = evaluateIngestItem(line, "quark", 0);
      expect(item.isValid).toBe(false);
      expect(item.action).toBe("unsupported_scheme");
      expect(item.reason).toContain("不支持离线下载功能");
    });

    it("accepts both 115 share and magnet when current provider is pan115", () => {
      const batch = parseBatchIngestInput(
        `https://115.com/s/sw3abcd?password=6666\nmagnet:?xt=urn:btih:0123456789abcdef`,
        "pan115"
      );
      expect(batch.validCount).toBe(2);
      expect(batch.shareCount).toBe(1);
      expect(batch.offlineCount).toBe(1);
      expect(batch.errorCount).toBe(0);
      expect(batch.hasUnsupported).toBe(false);
    });
  });

  describe("getDriveCapability", () => {
    it("returns correct capabilities for quark and pan115", () => {
      const quark = getDriveCapability("quark");
      expect(quark.supportsOffline).toBe(false);
      expect(quark.supportsShareTransfer).toBe(true);

      const pan115 = getDriveCapability("pan115");
      expect(pan115.supportsOffline).toBe(true);
      expect(pan115.supportsShareTransfer).toBe(true);
      expect(pan115.supportsTorrent).toBe(true);
    });
  });
});

import { describe, expect, it } from "vitest";
import { buildPlayStreamUrls } from "./play-stream-url";

describe("buildPlayStreamUrls", () => {
  it("透传 pickCode，proxy 地址在 pickCode 之后追加 delivery", () => {
    const { streamUrl, proxyUrl } = buildPlayStreamUrls({
      storageId: "cs_1",
      fileId: "3558",
      fileName: "Movie.mp4",
      pickCode: "abc123",
    });
    expect(streamUrl).toBe("/api/strm/play/cs_1/3558?name=Movie.mp4&pickCode=abc123");
    expect(proxyUrl).toBe("/api/strm/play/cs_1/3558?name=Movie.mp4&pickCode=abc123&delivery=proxy");
  });

  it("缺少 pickCode 时不产生空参数（保持旧行为）", () => {
    for (const pickCode of [undefined, null, "", "   "]) {
      const { streamUrl, proxyUrl } = buildPlayStreamUrls({
        storageId: "cs_1",
        fileId: "3558",
        fileName: "Movie.mp4",
        pickCode,
      });
      expect(streamUrl).toBe("/api/strm/play/cs_1/3558?name=Movie.mp4");
      expect(proxyUrl).toBe("/api/strm/play/cs_1/3558?name=Movie.mp4&delivery=proxy");
    }
  });

  it("文件名与 pickCode 都做 URL 编码", () => {
    const { streamUrl } = buildPlayStreamUrls({
      storageId: "cs_1",
      fileId: "f1",
      fileName: "新汉普夏饭店 (1984) & 特别版.mp4",
      pickCode: "a+b/c=",
    });
    expect(streamUrl).toContain("name=%E6%96%B0%E6%B1%89%E6%99%AE%E5%A4%8F");
    expect(streamUrl).toContain("pickCode=a%2Bb%2Fc%3D");
    expect(streamUrl).not.toContain(" ");
  });

  it("pickCode 前后空白被裁剪", () => {
    const { streamUrl } = buildPlayStreamUrls({
      storageId: "cs_1",
      fileId: "f1",
      fileName: "m.mp4",
      pickCode: "  abc  ",
    });
    expect(streamUrl.endsWith("&pickCode=abc")).toBe(true);
  });
});

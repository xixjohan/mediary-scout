import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, parseOfflineRequestBody, POST } from "./route";

const getAccountStorageCredentialsMock = vi.fn();

vi.mock("../../../../../lib/auth-chain", () => ({
  requireApiAccount: vi.fn(async () => "account_1"),
}));

vi.mock("../../../../../lib/demo-mode", () => ({
  isDemoMode: vi.fn(() => false),
}));

vi.mock("../../../../features/storage-drives/application/drive-service", () => ({
  getAccountStorageCredentials: (acct: string, storageId?: string) =>
    getAccountStorageCredentialsMock(acct, storageId),
}));

describe("parseOfflineRequestBody", () => {
  it("解析单 URL 请求", () => {
    const res = parseOfflineRequestBody({ url: "magnet:?xt=urn:btih:abc" });
    expect(res).toEqual({
      ok: true,
      storageId: undefined,
      urls: ["magnet:?xt=urn:btih:abc"],
      directoryId: undefined,
      torrentName: undefined,
      torrentBase64: undefined,
    });
  });

  it("解析多 URL 数组并自动过滤空行", () => {
    const res = parseOfflineRequestBody({
      urls: ["magnet:?xt=urn:btih:1", "  ", "https://example.com/video.mp4"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.urls).toEqual(["magnet:?xt=urn:btih:1", "https://example.com/video.mp4"]);
  });

  it("无 URL 也无种子时拒绝", () => {
    const res = parseOfflineRequestBody({});
    expect(res.ok).toBe(false);
  });
});

describe("GET /api/storage/offline — 能力查询", () => {
  it("115网盘返回支持的协议与离线任务能力", async () => {
    getAccountStorageCredentialsMock.mockResolvedValueOnce({
      id: "drive_115",
      provider: "pan115",
      cookie: "fake_cookie",
      rootCid: "0",
    });

    const req = new NextRequest("http://localhost:3000/api/storage/offline?storageId=drive_115");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.supported).toBe(true);
    expect(data.provider).toBe("pan115");
    expect(data.schemes).toContain("magnet");
    expect(data.schemes).toContain("http");
    expect(data.supportsTorrent).toBe(true);
  });

  it("不支持离线下载的网盘返回 supported: false 与提示信息", async () => {
    getAccountStorageCredentialsMock.mockResolvedValueOnce({
      id: "drive_quark",
      provider: "quark",
      rootCid: "0",
    });

    const req = new NextRequest("http://localhost:3000/api/storage/offline?storageId=drive_quark");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.supported).toBe(false);
    expect(data.message).toContain("推荐切换至 115网盘 或 123云盘");
  });
});

describe("POST /api/storage/offline — 提交离线任务", () => {
  it("网盘不支持时返回 400 与说明", async () => {
    getAccountStorageCredentialsMock.mockResolvedValueOnce({
      id: "drive_quark",
      provider: "quark",
      rootCid: "0",
    });

    const req = new NextRequest("http://localhost:3000/api/storage/offline", {
      method: "POST",
      body: JSON.stringify({ url: "magnet:?xt=urn:btih:test" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("暂不支持离线下载功能");
  });
});

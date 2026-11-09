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
      shareTasks: [],
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
    expect(res.shareTasks).toEqual([]);
  });

  it("解析分享转存任务 shareTasks", () => {
    const res = parseOfflineRequestBody({
      shareTasks: [
        {
          url: "https://pan.quark.cn/s/60e73719ddb8",
          shareCode: "60e73719ddb8",
          passcode: "nN4v",
          brand: "quark",
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.shareTasks.length).toBe(1);
    expect(res.shareTasks[0]?.shareCode).toBe("60e73719ddb8");
  });

  it("无 URL、无 shareTasks 也无种子时拒绝", () => {
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
    expect(data.supportsOffline).toBe(true);
    expect(data.supportsShareTransfer).toBe(true);
    expect(data.schemes).toContain("magnet");
    expect(data.schemes).toContain("http");
    expect(data.supportsTorrent).toBe(true);
  });

  it("夸克网盘返回支持分享转存、不支持磁力离线的能力描述", async () => {
    getAccountStorageCredentialsMock.mockResolvedValueOnce({
      id: "drive_quark",
      provider: "quark",
      rootCid: "0",
    });

    const req = new NextRequest("http://localhost:3000/api/storage/offline?storageId=drive_quark");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.supported).toBe(true);
    expect(data.supportsOffline).toBe(false);
    expect(data.supportsShareTransfer).toBe(true);
    expect(data.supportedShareBrands).toContain("quark");
    expect(data.message).toContain("夸克网盘支持分享链接转存");
  });
});

describe("POST /api/storage/offline — 提交离线与转存任务", () => {
  it("网盘不支持离线下载时提交磁力链接返回 400 与说明", async () => {
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

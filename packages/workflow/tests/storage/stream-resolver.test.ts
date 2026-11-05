import { describe, expect, it, vi } from "vitest";
import {
  SingleFlightStreamResolver,
  ProductionStorageStreamResolver,
  MockStorageStreamResolver,
  type StorageStreamResolver,
  type ResolveStreamInput,
  type ResolvedStream,
} from "../../src/storage/stream-resolver.js";
import { Pan115CookieClient } from "../../src/storage/pan115-cookie-client.js";

describe("SingleFlightStreamResolver", () => {
  it("folds concurrent resolveStream calls with identical key into single execution", async () => {
    let callCount = 0;
    const mockInner: StorageStreamResolver = {
      resolveStream: vi.fn().mockImplementation(async (input: ResolveStreamInput): Promise<ResolvedStream> => {
        callCount++;
        // 模拟 50ms 异步网络延迟
        await new Promise((r) => setTimeout(r, 50));
        return {
          url: `https://cdn.example.com/${input.storageId}/${input.fileId}`,
          deliveryMode: "redirect",
          expirationSeconds: 3600,
        };
      }),
    };

    const resolver = new SingleFlightStreamResolver(mockInner);

    const input = { storageId: "drive_115", fileId: "file_999" };

    // 模拟客户端 Range 嗅探同时发起 5 个并发请求
    const promises = [
      resolver.resolveStream(input),
      resolver.resolveStream(input),
      resolver.resolveStream(input),
      resolver.resolveStream(input),
      resolver.resolveStream(input),
    ];

    const results = await Promise.all(promises);

    expect(results).toHaveLength(5);
    expect(results[0]?.url).toBe("https://cdn.example.com/drive_115/file_999");
    expect(results[1]?.url).toBe("https://cdn.example.com/drive_115/file_999");
    expect(results[4]?.url).toBe("https://cdn.example.com/drive_115/file_999");

    // 关键断言：底层仅执行了 1 次解析！
    expect(callCount).toBe(1);
    expect(mockInner.resolveStream).toHaveBeenCalledTimes(1);
  });
});

describe("ProductionStorageStreamResolver", () => {
  it("throws STORAGE_NOT_FOUND when storage does not exist and no fallback", async () => {
    const resolver = new ProductionStorageStreamResolver(async () => null);
    await expect(resolver.resolveStream({ storageId: "cs_none", fileId: "f1" })).rejects.toThrow(
      "STORAGE_NOT_FOUND",
    );
  });

  it("delegates to fallback when storage does not exist and fallback is provided", async () => {
    const fallback = new MockStorageStreamResolver();
    const resolver = new ProductionStorageStreamResolver(async () => null, fallback);
    const res = await resolver.resolveStream({ storageId: "cs_none", fileId: "f1" });
    expect(res.url).toBe("https://mock-cdn.cloudpan.com/download/cs_none/f1");
  });

  it("throws STORAGE_FROZEN when storage is frozen", async () => {
    const resolver = new ProductionStorageStreamResolver(async () => ({
      provider: "pan115",
      status: "frozen",
    }));
    await expect(resolver.resolveStream({ storageId: "cs_f", fileId: "f1" })).rejects.toThrow(
      "STORAGE_FROZEN",
    );
  });

  it("throws PAN115_CREDENTIAL_MISSING when 115 cookie is empty", async () => {
    const resolver = new ProductionStorageStreamResolver(async () => ({
      provider: "pan115",
      status: "active",
      cookie: "   ",
    }));
    await expect(resolver.resolveStream({ storageId: "cs_empty", fileId: "f1" })).rejects.toThrow(
      "PAN115_CREDENTIAL_MISSING",
    );
  });

  it("resolves 115 stream URL via Pan115CookieClient and caches client instance", async () => {
    const spy = vi.spyOn(Pan115CookieClient.prototype, "getDownloadUrl").mockResolvedValue({
      url: "https://cdn.115cdn.net/down/test.mkv?token=abc",
      fileName: "test.mkv",
      fileSize: 1024,
    });

    try {
      const resolver = new ProductionStorageStreamResolver(async (id) => ({
        provider: "pan115",
        status: "active",
        cookie: "UID=foo; CID=bar; SEID=baz",
      }));

      const res = await resolver.resolveStream({
        storageId: "cs_115_real",
        fileId: "file_real",
        pickCode: "pick_123",
        userAgent: "Infuse/7.5",
      });

      expect(res.deliveryMode).toBe("redirect");
      expect(res.url).toBe("https://cdn.115cdn.net/down/test.mkv?token=abc");
      expect(res.headers?.["User-Agent"]).toBe("Infuse/7.5");
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: "file_real",
          pickCode: "pick_123",
          userAgent: "Infuse/7.5",
        }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("persists Open OAuth rotation when a direct-link request refreshes its token", async () => {
    const persistOpenOAuthCredentials = vi.fn();
    const coordinateOpenTokenRefresh = vi.fn(async (refresh: (credentials: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    }) => Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>) =>
      refresh({
        accessToken: "stream-old-access",
        refreshToken: "stream-old-refresh",
        expiresAt: 0,
      }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/open/refreshToken")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: true,
            code: 0,
            data: {
              access_token: "stream-next-access",
              refresh_token: "stream-next-refresh",
              expires_in: 7200,
            },
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: true,
          code: 0,
          data: { url: "https://cdn.example.com/video.mkv" },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const resolver = new ProductionStorageStreamResolver(async () => ({
        provider: "pan115",
        status: "active",
        credential: {
          openOAuth: {
            accessToken: "stream-old-access",
            refreshToken: "stream-old-refresh",
            expiresAt: 0,
          },
        },
        persistOpenOAuthCredentials,
        coordinateOpenTokenRefresh,
      }));

      const result = await resolver.resolveStream({
        storageId: "cs_115_oauth",
        fileId: "file-1",
        pickCode: "pick-1",
      });

      expect(result.url).toBe("https://cdn.example.com/video.mkv");
      expect(persistOpenOAuthCredentials).toHaveBeenCalledWith(expect.objectContaining({
        accessToken: "stream-next-access",
        refreshToken: "stream-next-refresh",
      }));
      expect(coordinateOpenTokenRefresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries a failed Open OAuth persistence using the cached rotated credentials", async () => {
    const persistOpenOAuthCredentials = vi.fn()
      .mockRejectedValueOnce(new Error("database temporarily unavailable"))
      .mockResolvedValueOnce(undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/open/refreshToken")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: true,
            code: 0,
            data: {
              access_token: "retry-access",
              refresh_token: "retry-refresh",
              expires_in: 7200,
            },
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ state: true, code: 0, data: { url: "https://cdn.example.com/open.mkv" } }),
      } as unknown as Response;
    });
    const cookieUrl = vi.spyOn(Pan115CookieClient.prototype, "getDownloadUrl").mockResolvedValue({
      url: "https://cdn.example.com/cookie.mkv",
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const resolver = new ProductionStorageStreamResolver(async () => ({
        provider: "pan115",
        status: "active",
        cookie: "UID=mock; CID=mock",
        credential: {
          openOAuth: {
            accessToken: "retry-old-access",
            refreshToken: "retry-old-refresh",
            expiresAt: 0,
          },
        },
        persistOpenOAuthCredentials,
      }));
      const input = { storageId: "cs_115_retry", fileId: "file-2", pickCode: "pick-2" };

      await expect(resolver.resolveStream(input)).resolves.toMatchObject({
        url: "https://cdn.example.com/cookie.mkv",
      });
      await expect(resolver.resolveStream(input)).resolves.toMatchObject({
        url: "https://cdn.example.com/open.mkv",
      });

      expect(persistOpenOAuthCredentials).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/open/refreshToken"))).toHaveLength(1);
    } finally {
      cookieUrl.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

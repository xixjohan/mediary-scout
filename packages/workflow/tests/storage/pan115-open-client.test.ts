import { describe, it, expect, vi } from "vitest";
import {
  Pan115OpenClient,
  Pan115OpenAuthError,
  classify115OpenError,
} from "../../src/storage/pan115-open-client.js";

describe("Pan115OpenClient", () => {
  it("classify115OpenError correctly segments fatal vs transient codes", () => {
    // 致命错误
    expect(classify115OpenError(40140115).isFatal).toBe(true);
    expect(classify115OpenError(40140116).isFatal).toBe(true);
    expect(classify115OpenError(40140119).isFatal).toBe(true);
    expect(classify115OpenError(40140120).isFatal).toBe(true);
    expect(classify115OpenError(401).isFatal).toBe(true);

    // 瞬态错误
    expect(classify115OpenError(40140117).retryable).toBe(true);
    expect(classify115OpenError(40140121).retryable).toBe(true);
    expect(classify115OpenError(429).retryable).toBe(true);
    expect(classify115OpenError(503).retryable).toBe(true);
  });

  it("merges 100 concurrent token refresh requests into exactly 1 network call (SingleFlight protection)", async () => {
    let networkCalls = 0;
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes("/open/refreshToken")) {
        networkCalls++;
        // 模拟网络延迟 20ms
        await new Promise((r) => setTimeout(r, 20));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: true,
            code: 0,
            data: {
              access_token: "new_valid_access_token",
              refresh_token: "new_refresh_token",
              expires_in: 7200,
            },
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });

    const client = new Pan115OpenClient({
      credentials: {
        accessToken: "expired_token",
        refreshToken: "initial_refresh_token",
        expiresAt: Date.now() - 1000, // 已经过期
      },
      fetchImpl: mockFetch as any,
    });

    // 并发发起 100 个获取 Token 的请求
    const results = await Promise.all(
      Array.from({ length: 100 }, () => client.ensureValidToken()),
    );

    expect(results).toHaveLength(100);
    for (const token of results) {
      expect(token).toBe("new_valid_access_token");
    }

    // 关键断言: 100 个并发请求仅产生 1 次真正的网络刷新调用！
    expect(networkCalls).toBe(1);
    expect(client.getCredentials().accessToken).toBe("new_valid_access_token");
  });

  it("throws fatal Pan115OpenAuthError when refresh_token is revoked or invalid", async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: false,
          code: 40140116,
          message: "refresh_token has expired or is invalid",
        }),
      } as unknown as Response;
    });

    const client = new Pan115OpenClient({
      credentials: {
        accessToken: "",
        refreshToken: "invalid_refresh_token",
        expiresAt: 0,
      },
      fetchImpl: mockFetch as any,
    });

    await expect(client.ensureValidToken()).rejects.toThrowError(Pan115OpenAuthError);
  });

  it("fetches file list with high limit and formats items correctly", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes("/open/ufile/files")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: true,
            code: 0,
            data: [
              {
                file_id: "fid_101",
                file_name: "Movie.2026.2160p.mkv",
                file_size: 15000000000,
                file_category: 1, // file
              },
              {
                category_id: "cid_202",
                file_name: "Season 1",
                file_size: 0,
                file_category: 0, // folder
              },
            ],
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });

    const client = new Pan115OpenClient({
      credentials: {
        accessToken: "active_token",
        refreshToken: "valid_rt",
        expiresAt: Date.now() + 3600000,
      },
      fetchImpl: mockFetch as any,
    });

    const items = await client.listItems({ directoryId: "cid_root", limit: 1000 });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      fid: "fid_101",
      name: "Movie.2026.2160p.mkv",
      size: 15000000000,
      isDirectory: false,
    });
    expect(items[1]).toMatchObject({
      cid: "cid_202",
      name: "Season 1",
      isDirectory: true,
    });
  });

  it("resolves direct download URL with User-Agent binding", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes("/open/ufile/downurl")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: true,
            code: 0,
            data: {
              url: "https://115-direct-cdn.com/download/test.mkv?sign=abc",
              file_name: "test.mkv",
              file_size: 1048576,
            },
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });

    const client = new Pan115OpenClient({
      credentials: {
        accessToken: "active_token",
        refreshToken: "valid_rt",
        expiresAt: Date.now() + 3600000,
      },
      fetchImpl: mockFetch as any,
    });

    const res = await client.getDownloadUrl({
      pickCode: "pick_123456",
      userAgent: "Infuse/7.7",
    });

    expect(res.url).toBe("https://115-direct-cdn.com/download/test.mkv?sign=abc");
    expect(res.userAgent).toBe("Infuse/7.7");
  });
});

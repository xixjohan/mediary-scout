import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowRepository } from "../persistence/repository.js";
import { EmbyAdapter } from "./emby-adapter.js";
import { PlexAdapter } from "./plex-adapter.js";
import {
  MediaServerCoordinator,
  mapLocalToRemote,
  normalizePathSeparators,
} from "./coordinator.js";

describe("mapLocalToRemote", () => {
  it("正确完成最长前缀匹配与路径转换", () => {
    const mappings = [
      { id: "1", localPath: "/data/strm", remotePath: "/media" },
      { id: "2", localPath: "/data/strm/anime", remotePath: "/media/anime_mount" },
    ];

    expect(mapLocalToRemote("/data/strm/movies/Avatar.strm", mappings)).toBe(
      "/media/movies/Avatar.strm",
    );
    // 最长前缀胜出
    expect(mapLocalToRemote("/data/strm/anime/Frieren/ep1.strm", mappings)).toBe(
      "/media/anime_mount/Frieren/ep1.strm",
    );
    // 未匹配则原样归一化
    expect(mapLocalToRemote("D:\\other\\video.mp4", mappings)).toBe("D:/other/video.mp4");
  });

  it("支持 Windows 反斜杠", () => {
    const mappings = [
      { id: "1", localPath: "D:\\strm\\movies", remotePath: "/media/movies" },
    ];
    expect(mapLocalToRemote("D:\\strm\\movies\\Inception\\Inception.strm", mappings)).toBe(
      "/media/movies/Inception/Inception.strm",
    );
  });
});

describe("PlexAdapter", () => {
  it("testConnection 成功解析版本与主机名", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        MediaContainer: {
          version: "1.32.5.7340",
          machineIdentifier: "plex_host_unique",
        },
      }),
    });

    const adapter = new PlexAdapter({
      hostUrl: "http://localhost:32400",
      token: "secret_token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
    expect(result.version).toBe("1.32.5.7340");
    expect(result.serverName).toBe("plex_host_unique");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:32400/identity",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });

  it("refreshLibrary 自动匹配路径对应的 Section 并触发局部刷新", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/library/sections/1/refresh")) {
        return { ok: true };
      }
      if (url.includes("/library/sections")) {
        return {
          ok: true,
          json: async () => ({
            MediaContainer: {
              Directory: [
                {
                  key: "1",
                  title: "电影",
                  type: "movie",
                  Location: [{ path: "/media/movies" }],
                },
                {
                  key: "2",
                  title: "剧集",
                  type: "show",
                  Location: [{ path: "/media/shows" }],
                },
              ],
            },
          }),
        };
      }
      return { ok: true };
    });

    const adapter = new PlexAdapter({
      hostUrl: "http://localhost:32400",
      token: "secret_token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const refreshResult = await adapter.refreshLibrary({
      path: "/media/movies/Avatar",
    });

    expect(refreshResult.ok).toBe(true);
    expect(refreshResult.refreshedCount).toBe(1);
    expect(refreshResult.sectionsRefreshed).toEqual(["电影"]);
  });
});

describe("EmbyAdapter", () => {
  it("testConnection 成功解析 Emby 系统信息", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        Version: "4.8.0.80",
        ServerName: "MyEmbyServer",
      }),
    });

    const adapter = new EmbyAdapter({
      hostUrl: "http://localhost:8096",
      token: "emby_token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
    expect(result.version).toBe("4.8.0.80");
    expect(result.serverName).toBe("MyEmbyServer");
  });

  it("refreshLibrary 调用 /Library/Media/Updated 局部刷新", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
    });

    const adapter = new EmbyAdapter({
      hostUrl: "http://localhost:8096",
      token: "emby_token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await adapter.refreshLibrary({ path: "/media/movies/Dune.strm" });
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8096/Library/Media/Updated",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          Updates: [{ Path: "/media/movies/Dune.strm", UpdateType: "Created" }],
        }),
      }),
    );
  });
});

describe("MediaServerCoordinator", () => {
  it("手动刷新调用并更新 lastSyncAt", async () => {
    const repo = new InMemoryWorkflowRepository();
    const config = await repo.createMediaServerConfig({
      accountId: "acct_test",
      name: "Plex Main",
      serverType: "plex",
      hostUrl: "http://127.0.0.1:32400",
      apiToken: "plain_token",
      pathMappings: [{ id: "m1", localPath: "/local/movies", remotePath: "/media/movies" }],
      isActive: true,
    });

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/refresh")) {
        return { ok: true };
      }
      return {
        ok: true,
        json: async () => ({
          MediaContainer: {
            Directory: [
              {
                key: "1",
                title: "Movies",
                type: "movie",
                Location: [{ path: "/media/movies" }],
              },
            ],
          },
        }),
      };
    });

    const coordinator = new MediaServerCoordinator({
      store: repo,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const refreshResult = await coordinator.manualRefresh(
      config.id,
      "acct_test",
      "/local/movies/Avatar",
    );

    expect(refreshResult.ok).toBe(true);
    const updated = await repo.getMediaServerConfig(config.id, "acct_test");
    expect(updated?.lastSyncAt).toBeDefined();
    coordinator.dispose();
  });

  it("防抖批量通知聚合相同目录", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.createMediaServerConfig({
      accountId: "acct_test",
      name: "Emby",
      serverType: "emby",
      hostUrl: "http://127.0.0.1:8096",
      apiToken: "plain_token",
      pathMappings: [{ id: "m1", localPath: "/strm", remotePath: "/mnt/strm" }],
      isActive: true,
    });

    const refreshedPaths: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/Library/Media/Updated")) {
        const body = JSON.parse(init?.body as string);
        refreshedPaths.push(body.Updates[0].Path);
        return { ok: true };
      }
      return { ok: true };
    });

    const coordinator = new MediaServerCoordinator({
      store: repo,
      debounceMs: 50,
      maxWaitMs: 150,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    // 连续触发同一目录下的 3 个文件变更
    coordinator.notifyFilesChanged("acct_test", [
      "/strm/movies/Inception/Inception.strm",
      "/strm/movies/Inception/Inception-poster.jpg",
    ]);
    coordinator.notifyFilesChanged("acct_test", [
      "/strm/movies/Inception/Inception.nfo",
    ]);

    // 等待防抖触发
    await new Promise((r) => setTimeout(r, 120));

    // 合并为同一个父级目录刷新
    expect(refreshedPaths).toHaveLength(1);
    expect(refreshedPaths[0]).toBe("/mnt/strm/movies/Inception");

    coordinator.dispose();
  });
});

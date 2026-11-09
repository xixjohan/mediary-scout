import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowRepository } from "../persistence/repository.js";
import { EmbyAdapter } from "./emby-adapter.js";
import { PlexAdapter } from "./plex-adapter.js";
import {
  MediaServerCoordinator,
  mapLocalToRemote,
  normalizePathSeparators,
  assertValidMediaServerUrl,
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

  it("refreshLibrary 在局部路径失败时自动降级刷新整个 Section (Tiered Fallback)", async () => {
    const urlsCalled: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      urlsCalled.push(url);
      if (url.includes("?path=")) {
        // 模拟路径不存在或 Plex 返回 404
        return { ok: false, status: 404 };
      }
      // 降级为整个 Section 扫描时成功
      return { ok: true, status: 200 };
    });

    const adapter = new PlexAdapter({
      hostUrl: "http://localhost:32400",
      token: "secret_token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await adapter.refreshLibrary({
      libraryId: "sec_movie",
      path: "/non/existent/path",
    });

    expect(result.ok).toBe(true);
    expect(result.sectionsRefreshed).toEqual(["sec_movie"]);
    expect(urlsCalled.length).toBe(2);
    expect(urlsCalled[0]).toContain("/library/sections/sec_movie/refresh?path=");
    expect(urlsCalled[1]).toBe("http://localhost:32400/library/sections/sec_movie/refresh");
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

  it("autoResolveMediaServerTarget 与 notifyTaskFilesChanged 支持基于 detectedLibraries 自适应推导并定向刷新 Section", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.createMediaServerConfig({
      id: "cfg_plex",
      accountId: "acct_plex",
      name: "Home Plex",
      serverType: "plex",
      hostUrl: "http://127.0.0.1:32400",
      apiToken: "plex_token",
      detectedLibraries: [
        { id: "sec_1", name: "电影", type: "movie", locations: ["/media/movies"] },
        { id: "sec_2", name: "剧集", type: "show", locations: ["/media/tv"] },
      ],
      isActive: true,
    });

    const refreshedSections: string[] = [];
    const refreshedPlexUrls: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/library/sections/")) {
        refreshedPlexUrls.push(url);
        const match = url.match(/\/library\/sections\/([^/?]+)\/refresh/);
        if (match?.[1]) refreshedSections.push(match[1]);
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

    // 触发电视剧变更
    coordinator.notifyTaskFilesChanged({
      accountId: "acct_plex",
      taskId: "task_tv",
      taskName: "115 电视剧 STRM",
      storageId: "cs_1",
      localOutputDir: "D:\\strm\\tv",
      mediaType: "show",
      generatedPaths: ["D:\\strm\\tv\\三体 (2023) {tmdb-200}\\Season 1\\S01E01.strm"],
      relativeSubPaths: ["三体 (2023) {tmdb-200}/Season 1/S01E01.strm"],
    });

    await new Promise((r) => setTimeout(r, 120));

    // 断言 Plex 仅定向刷新剧集 Section 2，且携带了 POSIX 规范容器内部路径
    expect(refreshedSections).toContain("sec_2");
    expect(refreshedPlexUrls.length).toBe(1);
    expect(decodeURIComponent(refreshedPlexUrls[0]!)).toContain("/media/tv/三体 (2023) {tmdb-200}/Season 1");

    coordinator.dispose();
  });

  it("支持显式 mediaServerId 与 mediaLibraryId 强绑定定向刷新，且不骚扰其它活动服务器", async () => {
    const repo = new InMemoryWorkflowRepository();
    // 服务器 1: 客厅 Plex
    await repo.createMediaServerConfig({
      id: "srv_plex_living",
      accountId: "acct_multi",
      name: "客厅 Plex",
      serverType: "plex",
      hostUrl: "http://127.0.0.1:32400",
      apiToken: "plex_token",
      detectedLibraries: [
        { id: "plex_sec_10", name: "电影", type: "movie", locations: ["/media/plex_movies"] },
      ],
      isActive: true,
    });
    // 服务器 2: 卧室 Emby
    await repo.createMediaServerConfig({
      id: "srv_emby_bedroom",
      accountId: "acct_multi",
      name: "卧室 Emby",
      serverType: "emby",
      hostUrl: "http://127.0.0.1:8096",
      apiToken: "emby_token",
      detectedLibraries: [
        { id: "emby_lib_20", name: "电影", type: "movie", locations: ["/media/emby_movies"] },
      ],
      isActive: true,
    });

    const plexCalls: string[] = [];
    const embyCalls: string[] = [];

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes(":32400")) {
        plexCalls.push(url);
      } else if (url.includes(":8096")) {
        embyCalls.push(url);
      }
      return { ok: true, status: 200 };
    });

    const coordinator = new MediaServerCoordinator({
      store: repo,
      debounceMs: 50,
      maxWaitMs: 150,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    // 触发只绑定了「客厅 Plex」任务的文件变更
    coordinator.notifyTaskFilesChanged({
      accountId: "acct_multi",
      taskId: "task_115_movie",
      taskName: "115 华语电影",
      storageId: "cs_1",
      localOutputDir: "D:\\strm\\movies",
      mediaType: "movie",
      mediaServerId: "srv_plex_living",
      mediaLibraryId: "plex_sec_10",
      mediaLibraryName: "电影",
      generatedPaths: ["D:\\strm\\movies\\流浪地球2 (2023)\\The.Wandering.Earth.II.strm"],
      relativeSubPaths: ["流浪地球2 (2023)/The.Wandering.Earth.II.strm"],
    });

    await new Promise((r) => setTimeout(r, 120));

    // 客厅 Plex 收到刷新请求，且精准定向到 plex_sec_10
    expect(plexCalls.length).toBeGreaterThanOrEqual(1);
    expect(plexCalls[0]).toContain("/library/sections/plex_sec_10/refresh?path=");
    expect(decodeURIComponent(plexCalls[0]!)).toContain("/media/plex_movies/流浪地球2 (2023)");

    // 卧室 Emby 绝不被骚扰（0 次请求）
    expect(embyCalls).toHaveLength(0);

    coordinator.dispose();
  });
});

describe("assertValidMediaServerUrl SSRF 防护", () => {
  it("拦截云元数据服务、链路本地地址与非法协议", () => {
    // 拦截 169.254.169.254 IMDS
    expect(() => assertValidMediaServerUrl("http://169.254.169.254/latest/meta-data/")).toThrow(/MEDIA_SERVER_SSRF_BLOCKED/);
    expect(() => assertValidMediaServerUrl("http://169.254.10.20:8096")).toThrow(/MEDIA_SERVER_SSRF_BLOCKED/);
    // 拦截 GCP 元数据
    expect(() => assertValidMediaServerUrl("http://metadata.google.internal/computeMetadata/v1/")).toThrow(/MEDIA_SERVER_SSRF_BLOCKED/);
    // 拦截阿里元数据与 IPv6 链路本地
    expect(() => assertValidMediaServerUrl("http://100.100.100.200/latest/meta-data/")).toThrow(/MEDIA_SERVER_SSRF_BLOCKED/);
    expect(() => assertValidMediaServerUrl("http://[fd00:ec2::254]/latest/meta-data/")).toThrow(/MEDIA_SERVER_SSRF_BLOCKED/);
    // 拦截非 http/https
    expect(() => assertValidMediaServerUrl("ftp://192.168.1.100:8096")).toThrow(/MEDIA_SERVER_SSRF_BLOCKED/);
    expect(() => assertValidMediaServerUrl("file:///etc/passwd")).toThrow(/MEDIA_SERVER_SSRF_BLOCKED/);
    // 拦截非法端口
    expect(() => assertValidMediaServerUrl("http://192.168.1.100:70000")).toThrow(/MEDIA_SERVER_URL_INVALID/);
    // 允许合法内网与公网地址
    expect(() => assertValidMediaServerUrl("http://192.168.1.100:32400")).not.toThrow();
    expect(() => assertValidMediaServerUrl("http://127.0.0.1:8096")).not.toThrow();
    expect(() => assertValidMediaServerUrl("https://plex.example.com:443")).not.toThrow();
  });
});

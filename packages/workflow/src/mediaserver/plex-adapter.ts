import type {
  MediaLibrary,
  MediaServerConnectionStatus,
  MediaServerRefreshResult,
} from "./mediaserver-types.js";

export interface PlexAdapterOptions {
  hostUrl: string;
  token: string;
  fetchFn?: typeof fetch | undefined;
}

export class PlexAdapter {
  private readonly hostUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: PlexAdapterOptions) {
    this.hostUrl = options.hostUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = new URL(endpoint, this.hostUrl);
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    headers.set("X-Plex-Token", this.token);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      return await this.fetchFn(url.toString(), {
        ...options,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async testConnection(): Promise<MediaServerConnectionStatus> {
    try {
      const res = await this.request("/identity");
      if (!res.ok) {
        return {
          ok: false,
          errorMessage: `Plex returned HTTP ${res.status}: ${res.statusText}`,
        };
      }
      const data = (await res.json().catch(() => ({}))) as {
        MediaContainer?: { version?: string; machineIdentifier?: string };
      };
      return {
        ok: true,
        version: data.MediaContainer?.version || "unknown",
        serverName: data.MediaContainer?.machineIdentifier || "Plex Media Server",
      };
    } catch (err) {
      return {
        ok: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listLibraries(): Promise<MediaLibrary[]> {
    const res = await this.request("/library/sections");
    if (!res.ok) {
      throw new Error(`Failed to list Plex sections: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      MediaContainer?: {
        Directory?: Array<{
          key: string;
          title: string;
          type: string;
          Location?: Array<{ path: string }>;
        }>;
      };
    };
    const dirs = data.MediaContainer?.Directory || [];
    return dirs.map((d) => ({
      id: d.key,
      name: d.title,
      type: d.type === "movie" ? "movie" : d.type === "show" ? "show" : "other",
      locations: (d.Location || []).map((loc) => loc.path),
    }));
  }

  async refreshLibrary(options: {
    libraryId?: string | undefined;
    path?: string | undefined;
  }): Promise<MediaServerRefreshResult> {
    try {
      // 1. 指定了 libraryId
      if (options.libraryId) {
        // Tier 1: 优先尝试局部路径精准刷新
        if (options.path) {
          const pathEp = `/library/sections/${options.libraryId}/refresh?path=${encodeURIComponent(options.path)}`;
          const pathRes = await this.request(pathEp);
          if (pathRes.ok) {
            return {
              ok: true,
              refreshedCount: 1,
              sectionsRefreshed: [options.libraryId],
            };
          }
          // 局部路径匹配失败或返回非 200 (如 400/404)，自动无缝降级为 Tier 2 具体库整库扫描
        }

        // Tier 2: 降级刷新整个具体库 (Section)
        const sectionRes = await this.request(`/library/sections/${options.libraryId}/refresh`);
        return {
          ok: sectionRes.ok,
          refreshedCount: sectionRes.ok ? 1 : 0,
          sectionsRefreshed: [options.libraryId],
          errorMessage: sectionRes.ok ? undefined : `Plex refresh error: HTTP ${sectionRes.status}`,
        };
      }

      // 2. 指定了 path 但没有 libraryId：按媒体库挂载目录匹配
      if (options.path) {
        const sections = await this.listLibraries();
        const normTarget = options.path.replace(/\\/g, "/").toLowerCase();
        const matched = sections.filter((s) =>
          s.locations.some((loc) => {
            const normLoc = loc.replace(/\\/g, "/").toLowerCase();
            return normTarget.startsWith(normLoc) || normLoc.startsWith(normTarget);
          }),
        );

        if (matched.length === 0) {
          return {
            ok: false,
            refreshedCount: 0,
            sectionsRefreshed: [],
            errorMessage: `No Plex section matched path: ${options.path}`,
          };
        }

        const refreshed: string[] = [];
        for (const s of matched) {
          const ep = `/library/sections/${s.id}/refresh?path=${encodeURIComponent(options.path)}`;
          const res = await this.request(ep);
          if (res.ok) refreshed.push(s.name);
        }
        return {
          ok: refreshed.length > 0,
          refreshedCount: refreshed.length,
          sectionsRefreshed: refreshed,
        };
      }

      // 3. 兜底：刷新所有媒体库
      const sections = await this.listLibraries();
      const refreshed: string[] = [];
      for (const s of sections) {
        const res = await this.request(`/library/sections/${s.id}/refresh`);
        if (res.ok) refreshed.push(s.name);
      }
      return {
        ok: refreshed.length > 0,
        refreshedCount: refreshed.length,
        sectionsRefreshed: refreshed,
      };
    } catch (err) {
      return {
        ok: false,
        refreshedCount: 0,
        sectionsRefreshed: [],
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

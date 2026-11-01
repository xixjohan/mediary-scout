import type {
  MediaLibrary,
  MediaServerConnectionStatus,
  MediaServerRefreshResult,
} from "./mediaserver-types.js";

export interface EmbyAdapterOptions {
  hostUrl: string;
  token: string;
  serverType?: "emby" | "jellyfin" | undefined;
  fetchFn?: typeof fetch | undefined;
}

export class EmbyAdapter {
  private readonly hostUrl: string;
  private readonly token: string;
  private readonly serverType: "emby" | "jellyfin";
  private readonly fetchFn: typeof fetch;

  constructor(options: EmbyAdapterOptions) {
    this.hostUrl = options.hostUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.serverType = options.serverType ?? "emby";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = new URL(endpoint, this.hostUrl);
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    headers.set("X-Emby-Token", this.token);
    headers.set("X-MediaBrowser-Token", this.token);

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
      const res = await this.request("/System/Info");
      if (!res.ok) {
        return {
          ok: false,
          errorMessage: `${this.serverType} returned HTTP ${res.status}: ${res.statusText}`,
        };
      }
      const data = (await res.json().catch(() => ({}))) as {
        Version?: string;
        ServerName?: string;
      };
      return {
        ok: true,
        version: data.Version || "unknown",
        serverName: data.ServerName || `${this.serverType} Server`,
      };
    } catch (err) {
      return {
        ok: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listLibraries(): Promise<MediaLibrary[]> {
    const res = await this.request("/Library/VirtualFolders");
    if (!res.ok) {
      throw new Error(`Failed to list virtual folders: HTTP ${res.status}`);
    }
    const data = (await res.json()) as Array<{
      Name: string;
      ItemId: string;
      Locations?: string[];
      CollectionType?: string;
    }>;
    return data.map((folder) => ({
      id: folder.ItemId || folder.Name,
      name: folder.Name,
      type:
        folder.CollectionType === "movies"
          ? "movie"
          : folder.CollectionType === "tvshows"
            ? "show"
            : "other",
      locations: folder.Locations || [],
    }));
  }

  async refreshLibrary(options: {
    libraryId?: string | undefined;
    path?: string | undefined;
  }): Promise<MediaServerRefreshResult> {
    try {
      // 1. 如果指定了 path，使用 /Library/Media/Updated 局部刷新（Emby 与 Jellyfin 推荐机制）
      if (options.path) {
        const updateRes = await this.request("/Library/Media/Updated", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            Updates: [{ Path: options.path, UpdateType: "Created" }],
          }),
        });
        if (updateRes.ok) {
          return {
            ok: true,
            refreshedCount: 1,
            sectionsRefreshed: [options.path],
          };
        }
      }

      // 2. 如果指定了 libraryId，刷新特定 Item
      if (options.libraryId) {
        const res = await this.request(`/Items/${options.libraryId}/Refresh?Recursive=true`, {
          method: "POST",
        });
        return {
          ok: res.ok,
          refreshedCount: res.ok ? 1 : 0,
          sectionsRefreshed: [options.libraryId],
          errorMessage: res.ok ? undefined : `${this.serverType} refresh error: HTTP ${res.status}`,
        };
      }

      // 3. 兜底：全库刷新
      const res = await this.request("/Library/Refresh", { method: "POST" });
      return {
        ok: res.ok,
        refreshedCount: res.ok ? 1 : 0,
        sectionsRefreshed: ["all"],
        errorMessage: res.ok ? undefined : `${this.serverType} refresh error: HTTP ${res.status}`,
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

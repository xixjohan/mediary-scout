/**
 * 媒体直链与转码流传输协调器
 *
 * 核心机制：
 *   1. 播放流识别：精确区分 Emby/Plex/Jellyfin 真正的播放动作与客户端元数据/缩略图探测；
 *   2. 短 Range 探测过滤：对 bytes=-524288 等 MP4 moov 索引探测，不计入长连接流；
 *   3. 会话作用域聚合：按 ClientIdentifier / PlaySessionId / Token / IP 聚合并发流。
 */

export interface ActiveStreamSession {
  scopeId: string;
  streamId: string;
  targetUrl: string;
  startedAt: number;
  lastActiveAt: number;
  transferredBytes: number;
}

function findFirstHeader(headers: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const val = headers[k];
    if (val) return val.trim();
  }
  return undefined;
}

function findIpHeader(headers: Record<string, string>): string | undefined {
  const cfIp = headers["cf-connecting-ip"];
  if (cfIp) return cfIp.trim();
  const xff = headers["x-forwarded-for"];
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers["x-real-ip"];
  if (realIp) return realIp.trim();
  return undefined;
}

const EXCLUDED_STREAM_PATHS = [
  "/sessions",
  "/users",
  "/items?",
  "/items/root",
  "/system/",
  "/library/",
  "/ws",
  "/socket",
];

const EMBY_STREAM_KEYWORDS = [
  "/stream",
  "/main.m3u8",
  "/master.m3u8",
  "/original.",
];

const PLEX_STREAM_KEYWORDS = [
  "/video/:/transcode/universal/start.mpd",
  "/video/:/transcode/universal/start.m3u8",
  "/library/parts/",
];

function isMetadataOrControlPath(lowerPath: string): boolean {
  return EXCLUDED_STREAM_PATHS.some((p) => lowerPath.includes(p));
}

function isEmbyOrJellyfinStream(lowerPath: string): boolean {
  if (!lowerPath.includes("/videos/")) return false;
  return EMBY_STREAM_KEYWORDS.some((kw) => lowerPath.includes(kw));
}

function isPlexStream(lowerPath: string): boolean {
  return PLEX_STREAM_KEYWORDS.some((kw) => lowerPath.includes(kw));
}

export class MediaStreamCoordinator {
  private readonly _activeStreams = new Map<string, ActiveStreamSession>();
  private readonly _scopeResources = new Map<string, { requestId: string; cts: AbortController }>();

  /**
   * 提取会话作用域标识
   */
  public extractSessionScope(headers: Record<string, string>): string {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      lower[k.toLowerCase()] = v;
    }

    const deviceId = findFirstHeader(lower, [
      "x-plex-client-identifier",
      "x-emby-device-id",
      "x-jellyfin-device-id",
      "deviceid",
    ]);
    if (deviceId) return `device:${deviceId}`;

    const token = findFirstHeader(lower, [
      "x-plex-token",
      "x-emby-token",
      "api_key",
      "authorization",
    ]);
    if (token) return `token:${token.slice(-16)}`;

    const sessionId = findFirstHeader(lower, [
      "x-plex-session-id",
      "playsessionid",
      "sessionid",
    ]);
    if (sessionId) return `session:${sessionId}`;

    const ip = findIpHeader(lower);
    if (ip) return `ip:${ip}`;

    return "default";
  }

  /**
   * 判断是否为 RFC 9110 后缀 Range 短探测或元数据小区间探测
   * 示例：bytes=-524288 (探测尾部 512KB MP4 moov 索引)
   */
  public isBoundedRangeProbe(rangeHeader?: string | null): boolean {
    if (!rangeHeader) return false;
    const trimmed = rangeHeader.trim().toLowerCase();
    if (!trimmed.startsWith("bytes=")) return false;

    const spec = trimmed.slice("bytes=".length);
    // 后缀 Range: bytes=-524288
    if (spec.startsWith("-")) {
      const suffixBytes = Number.parseInt(spec.slice(1), 10);
      return !Number.isNaN(suffixBytes) && suffixBytes <= 4 * 1024 * 1024; // <= 4MB
    }

    // 显式区间 Range: bytes=0-1048576
    const parts = spec.split("-");
    if (parts.length === 2 && parts[0] && parts[1]) {
      const start = Number.parseInt(parts[0], 10);
      const end = Number.parseInt(parts[1], 10);
      if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
        return end - start + 1 <= 4 * 1024 * 1024; // <= 4MB
      }
    }

    return false;
  }

  public registerOrPreempt(
    requestId: string,
    scope: string,
    resource: string,
    cts: AbortController,
  ): string | null {
    const key = `${scope}::${resource}`;
    const prev = this._scopeResources.get(key);
    let preempted: string | null = null;
    if (prev && prev.requestId !== requestId) {
      preempted = prev.requestId;
      prev.cts.abort(new Error("用户寻轨跳转，抢占终止旧流"));
    }
    this._scopeResources.set(key, { requestId, cts });
    this.recordStreamStart(scope, requestId, resource);
    return preempted;
  }

  public removeStream(requestId: string): void {
    this.recordStreamEnd(requestId);
    for (const [key, val] of this._scopeResources.entries()) {
      if (val.requestId === requestId) {
        this._scopeResources.delete(key);
      }
    }
  }

  public abortStream(requestId: string, reason?: string): void {
    for (const [key, val] of this._scopeResources.entries()) {
      if (val.requestId === requestId) {
        val.cts.abort(new Error(reason ?? "外部中止流"));
        this._scopeResources.delete(key);
      }
    }
    this.recordStreamEnd(requestId);
  }

  public clear(): void {
    for (const val of this._scopeResources.values()) {
      val.cts.abort(new Error("隧道关闭，清除所有活跃流"));
    }
    this._scopeResources.clear();
    this._activeStreams.clear();
  }

  /**
   * 判断当前 HTTP 请求是否为真正的媒体视频播放流请求
   */
  public isMediaStreamRequest(urlPath: string, headers: Record<string, string>): boolean {
    const lowerPath = urlPath.toLowerCase();

    if (isMetadataOrControlPath(lowerPath)) {
      return false;
    }

    if (isEmbyOrJellyfinStream(lowerPath) || isPlexStream(lowerPath)) {
      return true;
    }

    if (/\.(mp4|mkv|mov|ts|m3u8|webm|flv|iso|avi|wmv)(\?.*)?$/i.test(lowerPath)) {
      const range = headers["range"] || headers["Range"];
      return !range || !this.isBoundedRangeProbe(range);
    }

    return false;
  }

  /**
   * 注册并记录活跃流
   */
  public recordStreamStart(scopeId: string, streamId: string, targetUrl: string): void {
    this._activeStreams.set(streamId, {
      scopeId,
      streamId,
      targetUrl,
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      transferredBytes: 0,
    });
  }

  /**
   * 更新活跃心跳与传输量
   */
  public recordStreamProgress(streamId: string, chunkBytes: number): void {
    const session = this._activeStreams.get(streamId);
    if (session) {
      session.lastActiveAt = Date.now();
      session.transferredBytes += chunkBytes;
    }
  }

  /**
   * 结束并注销流
   */
  public recordStreamEnd(streamId: string): void {
    this._activeStreams.delete(streamId);
  }

  /**
   * 获取某作用域下当前并发活跃播放流数量（自动淘汰超时未活跃流）
   */
  public getActiveStreamCount(scopeId: string, timeoutMs = 45000): number {
    const now = Date.now();
    let count = 0;
    for (const [id, session] of this._activeStreams.entries()) {
      if (now - session.lastActiveAt > timeoutMs) {
        this._activeStreams.delete(id);
      } else if (session.scopeId === scopeId) {
        count++;
      }
    }
    return count;
  }
}

/**
 * ProxyByCF FRP 协议帧序列化、ByteString 安全防御与 302 虚拟子路由编解码
 * 
 * 对标参考：
 * - ProxyByCF (apps/worker/src/features/tunnel/durable-object.ts)
 * - LinuxWebTool (TunnelFrameSerializer.cs, NetworkAddressClassifier.cs)
 */

import type {
  AnyTunnelFrame,
  TunnelAbortFrame,
  TunnelAckFrame,
  TunnelRequestFrame,
  TunnelResponseFrame,
  TunnelStreamChunkFrame,
  TunnelStreamEndFrame,
  TunnelStreamStartFrame,
} from "./tunnel-protocol.js";

/**
 * WHATWG Fetch 规范要求标头值必须为 ByteString (字符码 0x00 ~ 0xFF)
 * 防止老旧设备或本地服务返回中文字符标头 (如 Location / Content-Disposition) 导致 DO 崩溃
 */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") continue;
    // 检查是否存在 > 0xFF 的非 ASCII/Latin1 字符
    if (/[^\x00-\xFF]/.test(v)) {
      try {
        result[k] = encodeURI(v);
      } catch {
        result[k] = v;
      }
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * 判断是否应走单包极速直发白名单 (RFC 9110 3xx Redirect, 204/304, HEAD 或 <= 1MB 小体积)
 */
export function isSinglePacketDispatch(
  statusCode: number,
  method: string,
  contentLength?: number | null,
): boolean {
  if (method.toUpperCase() === "HEAD") return true;
  if (statusCode === 204 || statusCode === 304) return true;
  if (statusCode >= 300 && statusCode <= 308) return true; // 3xx 强制单包直发
  if (contentLength !== undefined && contentLength !== null && contentLength <= 1024 * 1024) {
    return true;
  }
  return false;
}

/**
 * 校验私网 IP 是否在安全范围（防 SSRF 攻击：禁止外网探测路由器 80 或 SSH 22 等危险端口）
 */
const FORBIDDEN_PORTS = new Set([21, 22, 23, 25, 53, 80, 137, 138, 139, 443, 445, 3306, 5432, 6379, 27017]);

export function isAllowedLanTarget(host: string, port: number): boolean {
  if (FORBIDDEN_PORTS.has(port)) return false;

  // 必须是私网 IPv4 或 localhost
  if (host === "127.0.0.1" || host === "localhost") return true;

  // 192.168.0.0/16
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // 10.0.0.0/8
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // 172.16.0.0/12
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;

  return false;
}

/**
 * 拦截 302 重定向并改写为公网虚拟子路由 (Zero Home Uplink STRM/AList 加速)
 * 例如将 http://192.168.1.60:5211/api/strm/play 改写为 /tunnel/{slug}/__lan/192.168.1.60_5211/api/strm/play
 */
export function rewriteLanLocationToVirtualRoute(
  rawLocation: string,
  tunnelSlug: string,
): { rewritten: boolean; location: string } {
  try {
    const url = new URL(rawLocation);
    const host = url.hostname.toLowerCase();
    const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);

    // 如果重定向目标是局域网内部媒体服务 (如 AList 5244/5211)，执行虚拟子路由改写
    if (isAllowedLanTarget(host, port)) {
      const virtualPrefix = `/tunnel/${tunnelSlug}/__lan/${host}_${port}`;
      const search = url.search ? url.search : "";
      const rewrittenLocation = `${virtualPrefix}${url.pathname}${search}`;
      return { rewritten: true, location: rewrittenLocation };
    }
  } catch {}

  return { rewritten: false, location: rawLocation };
}

/**
 * 解析外网访客发来的虚拟子路由请求
 * 例如路径为 /tunnel/{slug}/__lan/192.168.1.60_5211/api/strm/play
 * 解码还原为 http://192.168.1.60:5211/api/strm/play
 */
export function parseVirtualLanRoute(path: string): { isVirtualLan: boolean; internalUrl?: string } {
  const match = /\/__lan\/([0-9a-zA-Z.-]+)_(\d+)(\/.*)?$/.exec(path);
  if (!match) return { isVirtualLan: false };

  const host = match[1];
  const port = Number(match[2]);
  const subPath = match[3] || "/";

  if (!host || !isAllowedLanTarget(host, port)) {
    return { isVirtualLan: false };
  }

  return {
    isVirtualLan: true,
    internalUrl: `http://${host}:${port}${subPath}`,
  };
}

export class TunnelFrameSerializer {
  public static serialize(frame: AnyTunnelFrame): string {
    return JSON.stringify(frame);
  }

  public static deserialize(rawJson: string): AnyTunnelFrame | null {
    try {
      const obj = JSON.parse(rawJson);
      if (typeof obj === "object" && obj !== null && typeof obj.type === "string") {
        return obj as AnyTunnelFrame;
      }
      return null;
    } catch {
      return null;
    }
  }

  public static serializeHttpResponse(
    requestId: string,
    statusCode: number,
    headers: Record<string, string>,
    bodyBase64?: string | null,
  ): string {
    const frame: TunnelResponseFrame = {
      type: "HTTP_RESPONSE",
      requestId,
      statusCode,
      headers: sanitizeHeaders(headers),
      bodyBase64: bodyBase64 ?? null,
    };
    return JSON.stringify(frame);
  }

  public static serializeStreamStart(
    requestId: string,
    statusCode: number,
    headers: Record<string, string>,
  ): string {
    const frame: TunnelStreamStartFrame = {
      type: "HTTP_STREAM_START",
      requestId,
      statusCode,
      headers: sanitizeHeaders(headers),
    };
    return JSON.stringify(frame);
  }

  public static serializeStreamChunk(requestId: string, chunk: Buffer | Uint8Array): string {
    const frame: TunnelStreamChunkFrame = {
      type: "HTTP_STREAM_CHUNK",
      requestId,
      chunkBase64: Buffer.from(chunk).toString("base64"),
    };
    return JSON.stringify(frame);
  }

  public static serializeStreamEnd(requestId: string): string {
    const frame: TunnelStreamEndFrame = {
      type: "HTTP_STREAM_END",
      requestId,
    };
    return JSON.stringify(frame);
  }

  public static serializeAbort(requestId: string): string {
    const frame: TunnelAbortFrame = {
      type: "HTTP_ABORT",
      requestId,
    };
    return JSON.stringify(frame);
  }

  public static serializeAck(requestId: string, bytes: number): string {
    const frame: TunnelAckFrame = {
      type: "HTTP_ACK",
      requestId,
      bytes,
    };
    return JSON.stringify(frame);
  }
}

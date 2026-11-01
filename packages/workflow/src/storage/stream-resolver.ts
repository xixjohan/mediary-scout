import { SingleFlight } from "../strm/single-flight.js";

/**
 * StorageStreamResolver (网盘流媒体直链与反代解析器)
 *
 * 统一各网盘直链提取协议，为 STRM 播放中继提供结构化的解析结果。
 * 1. 302 重定向模式 (redirect)：客户端直连网盘 CDN，服务器 0 带宽与 0 CPU；
 * 2. 串流代理模式 (proxy)：服务器中继，支持 HTTP 206 Partial Content 分片。
 */

export interface ResolveStreamInput {
  storageId: string;
  fileId: string;
  pickCode?: string;
  fileName?: string;
  userAgent?: string;
}

export interface ResolvedStream {
  url: string;
  deliveryMode: "redirect" | "proxy";
  headers?: Record<string, string>;
  expirationSeconds: number; // TTL（秒）
}

export interface StorageStreamResolver {
  resolveStream(input: ResolveStreamInput): Promise<ResolvedStream>;
}

/**
 * SingleFlightStreamResolver (单飞并发请求合并装饰器)
 *
 * 包装底层 StorageStreamResolver，将针对同一视频/文件的并发直链解析请求
 * 合并为单个调用，防止播放器多线程探测引发网盘 429 风暴。
 */
export class SingleFlightStreamResolver implements StorageStreamResolver {
  private readonly _flight = new SingleFlight<ResolvedStream>();

  constructor(private readonly _inner: StorageStreamResolver) {}

  public getInnerResolver(): StorageStreamResolver {
    return this._inner;
  }

  async resolveStream(input: ResolveStreamInput): Promise<ResolvedStream> {
    const key = `${input.storageId}:${input.fileId}`;
    return this._flight.do(key, () => this._inner.resolveStream(input));
  }
}

/**
 * 模拟 / 默认解析器，用于通用直链与单元测试。
 */
export class MockStorageStreamResolver implements StorageStreamResolver {
  constructor(
    private readonly handler?: (input: ResolveStreamInput) => Promise<ResolvedStream>,
  ) {}

  async resolveStream(input: ResolveStreamInput): Promise<ResolvedStream> {
    if (this.handler) {
      return this.handler(input);
    }
    return {
      url: `https://mock-cdn.cloudpan.com/download/${input.storageId}/${input.fileId}`,
      deliveryMode: "redirect",
      headers: { "User-Agent": input.userAgent || "MediaryScout" },
      expirationSeconds: 7200,
    };
  }
}

let activeStreamResolver: StorageStreamResolver = new SingleFlightStreamResolver(
  new MockStorageStreamResolver(),
);

export function setStorageStreamResolver(resolver: StorageStreamResolver): void {
  activeStreamResolver =
    resolver instanceof SingleFlightStreamResolver
      ? resolver
      : new SingleFlightStreamResolver(resolver);
}

export function getStorageStreamResolver(): StorageStreamResolver {
  return activeStreamResolver;
}

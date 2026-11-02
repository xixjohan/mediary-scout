import { SingleFlight } from "../strm/single-flight.js";
import { Pan115CookieClient } from "./pan115-cookie-client.js";
import { Pan115OpenClient } from "./pan115-open-client.js";
import { isPan115OpenOAuthValid, type Pan115OpenOAuthCredentials } from "./account-credentials.js";

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
  pickCode?: string | undefined;
  fileName?: string | undefined;
  userAgent?: string | undefined;
}

export interface ResolvedStream {
  url: string;
  deliveryMode: "redirect" | "proxy";
  headers?: Record<string, string> | undefined;
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

export interface StorageCredentialsInfo {
  provider: string;
  cookie?: string | undefined;
  credential?: Record<string, unknown> | null | undefined;
  status?: string | undefined;
}

export type StorageCredentialLookup = (storageId: string) => Promise<StorageCredentialsInfo | null>;

/**
 * 生产环境真实网盘流媒体解析器：
 * 具备各网盘驱动能力，将媒体请求映射为真实 CDN 302 重定向直链。
 * 针对 115 网盘支持双轨直链解析 (优先走官方开放平台 Open API，异常降级走 Cookie)。
 */
export class ProductionStorageStreamResolver implements StorageStreamResolver {
  private readonly _pan115CookieClients = new Map<string, Pan115CookieClient>();
  private readonly _pan115OpenClients = new Map<string, Pan115OpenClient>();

  constructor(
    private readonly _lookup: StorageCredentialLookup,
    private readonly _fallback?: StorageStreamResolver | undefined,
  ) {}

  private async resolvePan115Stream(
    creds: StorageCredentialsInfo,
    input: ResolveStreamInput,
  ): Promise<ResolvedStream> {
    const openOAuth = (creds.credential as Record<string, unknown> | undefined)?.openOAuth as
      | Pan115OpenOAuthCredentials
      | undefined;

    // 1. 优先尝试 115 开放平台 (Open API) 原生直链
    if (isPan115OpenOAuthValid(openOAuth) && input.pickCode) {
      try {
        let openClient = this._pan115OpenClients.get(input.storageId);
        if (!openClient) {
          openClient = new Pan115OpenClient({ credentials: openOAuth! });
          this._pan115OpenClients.set(input.storageId, openClient);
        }
        const downloadInput: { pickCode: string; userAgent?: string } = {
          pickCode: input.pickCode,
        };
        if (input.userAgent !== undefined) {
          downloadInput.userAgent = input.userAgent;
        }
        const res = await openClient.getDownloadUrl(downloadInput);

        return {
          url: res.url,
          deliveryMode: "redirect",
          headers: {
            "User-Agent":
              res.userAgent ||
              input.userAgent ||
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          },
          expirationSeconds: 7200,
        };
      } catch (err) {
        console.warn(`[ProductionStorageStreamResolver] 115 Open API直链解析失败，尝试降级回Cookie:`, err);
      }
    }

    // 2. 降级或默认: 走 Cookie Client 直链解析
    const cookie = creds.cookie?.trim();
    if (!cookie) {
      throw new Error(`PAN115_CREDENTIAL_MISSING: 存储驱动 ${input.storageId} 缺少有效 Cookie 凭据`);
    }

    let client = this._pan115CookieClients.get(input.storageId);
    if (!client) {
      client = new Pan115CookieClient({ cookie });
      this._pan115CookieClients.set(input.storageId, client);
    }

    const res = await client.getDownloadUrl({
      fileId: input.fileId,
      ...(input.pickCode !== undefined ? { pickCode: input.pickCode } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });

    return {
      url: res.url,
      deliveryMode: "redirect",
      headers: {
        "User-Agent":
          input.userAgent ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      expirationSeconds: 7200,
    };
  }

  async resolveStream(input: ResolveStreamInput): Promise<ResolvedStream> {
    const creds = await this._lookup(input.storageId);
    if (!creds) {
      if (this._fallback) {
        return this._fallback.resolveStream(input);
      }
      throw new Error(`STORAGE_NOT_FOUND: 存储驱动 ${input.storageId} 未绑定或不存在`);
    }

    if (creds.status === "frozen") {
      throw new Error(`STORAGE_FROZEN: 存储驱动 ${input.storageId} 凭据已失效或处于冻结状态`);
    }

    if (creds.provider === "pan115") {
      return this.resolvePan115Stream(creds, input);
    }

    if (this._fallback) {
      return this._fallback.resolveStream(input);
    }
    throw new Error(`PROVIDER_NOT_SUPPORTED: 暂不支持网盘提供商 ${creds.provider} 的流媒体直链解析`);
  }
}

/**
 * 模拟 / 默认解析器，用于通用直链与单元测试。
 */
export class MockStorageStreamResolver implements StorageStreamResolver {
  constructor(
    private readonly handler?: ((input: ResolveStreamInput) => Promise<ResolvedStream>) | undefined,
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

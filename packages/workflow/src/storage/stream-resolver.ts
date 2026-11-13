import { SingleFlight } from "../strm/single-flight.js";
import { Pan115CookieClient } from "./pan115-cookie-client.js";
import {
  Pan115OpenAuthError,
  Pan115OpenClient,
  type Pan115TokenRefreshCoordinator,
} from "./pan115-open-client.js";
import { QuarkCookieClient, QUARK_PROFILE, UC_PROFILE } from "./quark-cookie-client.js";
import { isPan115OpenOAuthValid, type Pan115OpenOAuthCredentials } from "./account-credentials.js";
import { withBrandPacing } from "./brand-pacing.js";

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

import { ensureNoProxyHost } from "./egress-no-proxy.js";
import { markOpenApiFatal, shouldSkipOpenApi } from "./open-api-circuit.js";

export interface StorageCredentialsInfo {
  provider: string;
  cookie?: string | undefined;
  credential?: Record<string, unknown> | null | undefined;
  status?: string | undefined;
  persistCookie?: ((cookie: string) => Promise<void> | void) | undefined;
  persistOpenOAuthCredentials?:
    | ((credentials: Pan115OpenOAuthCredentials) => Promise<void> | void)
    | undefined;
  coordinateOpenTokenRefresh?: Pan115TokenRefreshCoordinator | undefined;
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

  private getPan115OpenClient(
    storageId: string,
    credentials: Pan115OpenOAuthCredentials,
    persistCredentials: StorageCredentialsInfo["persistOpenOAuthCredentials"],
    coordinateTokenRefresh: StorageCredentialsInfo["coordinateOpenTokenRefresh"],
  ): Pan115OpenClient {
    let client = this._pan115OpenClients.get(storageId);
    const cached = client?.getCredentials();
    const matchesPersisted =
      cached?.accessToken === credentials.accessToken &&
      cached?.refreshToken === credentials.refreshToken &&
      cached?.expiresAt === credentials.expiresAt;
    const hasUnpersistedRotation =
      client?.hasPendingCredentialPersistence === true &&
      cached !== undefined &&
      cached.expiresAt > credentials.expiresAt;
    if (!client || (!matchesPersisted && !hasUnpersistedRotation)) {
      client = new Pan115OpenClient({
        credentials,
        onCredentialsPersist: persistCredentials,
        coordinateTokenRefresh,
      });
      this._pan115OpenClients.set(storageId, client);
    }
    return client;
  }

  private async resolvePan115OpenStream(
    creds: StorageCredentialsInfo,
    input: ResolveStreamInput,
  ): Promise<ResolvedStream | null> {
    const openOAuth = (creds.credential as Record<string, unknown> | undefined)?.openOAuth as
      | Pan115OpenOAuthCredentials
      | undefined;
    if (!isPan115OpenOAuthValid(openOAuth) || !input.pickCode) return null;

    try {
      const client = this.getPan115OpenClient(
        input.storageId,
        openOAuth!,
        creds.persistOpenOAuthCredentials,
        creds.coordinateOpenTokenRefresh,
      );
      const downloadInput: { pickCode: string; userAgent?: string } = { pickCode: input.pickCode };
      if (input.userAgent !== undefined) downloadInput.userAgent = input.userAgent;
      const result = await client.getDownloadUrl(downloadInput);
      return {
        url: result.url,
        deliveryMode: "redirect",
        headers: {
          "User-Agent":
            result.userAgent ||
            input.userAgent ||
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        },
        expirationSeconds: 7200,
      };
    } catch (err) {
      if (err instanceof Pan115OpenAuthError && err.isFatal) {
        markOpenApiFatal(input.storageId);
      }
      console.warn(`[ProductionStorageStreamResolver] 115 Open API直链解析失败，尝试降级回Cookie:`, err);
      return null;
    }
  }

  private async resolvePan115CookieStream(
    creds: StorageCredentialsInfo,
    input: ResolveStreamInput,
  ): Promise<ResolvedStream> {
    const cookie = creds.cookie?.trim();
    if (!cookie) {
      throw new Error(`PAN115_CREDENTIAL_MISSING: 存储驱动 ${input.storageId} 缺少有效 Cookie 凭据`);
    }

    let client = this._pan115CookieClients.get(input.storageId);
    if (!client) {
      const rawClient = new Pan115CookieClient({ cookie });
      client = withBrandPacing(rawClient, "pan115", {
        clock: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      this._pan115CookieClients.set(input.storageId, client);
    }

    const result = await client.getDownloadUrl({
      fileId: input.fileId,
      ...(input.pickCode !== undefined ? { pickCode: input.pickCode } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });
    return {
      url: result.url,
      deliveryMode: "redirect",
      headers: {
        "User-Agent":
          input.userAgent ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      expirationSeconds: 7200,
    };
  }

  private readonly _quarkCookieClients = new Map<string, QuarkCookieClient>();

  private async resolveQuarkFamilyStream(
    creds: StorageCredentialsInfo,
    input: ResolveStreamInput,
  ): Promise<ResolvedStream> {
    const cookie = creds.cookie?.trim();
    if (!cookie) {
      throw new Error(`QUARK_CREDENTIAL_MISSING: 存储驱动 ${input.storageId} 缺少有效 Cookie 凭据`);
    }

    let client = this._quarkCookieClients.get(input.storageId);
    if (!client || client.getCookie() !== cookie) {
      client = new QuarkCookieClient({
        cookie,
        profile: creds.provider === "uc" ? UC_PROFILE : QUARK_PROFILE,
        ...(creds.persistCookie ? { onCookiePersist: creds.persistCookie } : {}),
      });
      this._quarkCookieClients.set(input.storageId, client);
    }

    const res = await client.getDownloadUrl({
      fid: input.fileId,
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });

    return {
      url: res.url,
      deliveryMode: "proxy",
      headers: res.headers,
      expirationSeconds: 3600,
    };
  }

  private async resolvePan115Stream(
    creds: StorageCredentialsInfo,
    input: ResolveStreamInput,
  ): Promise<ResolvedStream> {
    // 已判定 Open API 致命失效（refresh_token 无效）时直接走 Cookie：
    // 省掉一次必然失败的刷新往返，首字节可少 0.3–1s。
    if (shouldSkipOpenApi(input.storageId)) {
      return this.resolvePan115CookieStream(creds, input);
    }
    const openStream = await this.resolvePan115OpenStream(creds, input);
    return openStream ?? this.resolvePan115CookieStream(creds, input);
  }

  async resolveStream(input: ResolveStreamInput): Promise<ResolvedStream> {
    const resolved = await this.resolveStreamInternal(input);
    // CDN 域名由网盘动态下发，解析后即时补进 NO_PROXY，避免视频流被外网代理中转。
    try {
      ensureNoProxyHost(new URL(resolved.url).hostname);
    } catch {
      // url 形态异常不影响播放，忽略
    }
    return resolved;
  }

  private async resolveStreamInternal(input: ResolveStreamInput): Promise<ResolvedStream> {
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

    if (creds.provider === "quark" || creds.provider === "uc") {
      return this.resolveQuarkFamilyStream(creds, input);
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

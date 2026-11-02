import {
  isPan115OpenOAuthValid,
  resolvePan115EngineMode,
  type Pan115OpenOAuthCredentials,
  type Pan115EngineMode,
} from "./account-credentials.js";

/**
 * 字符串部分掩码工具：保护中间字符，只保留首尾。
 */
export function maskSecret(value?: string | null, head = 4, tail = 4): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= head + tail) {
    return "****";
  }
  const prefix = trimmed.slice(0, head);
  const suffix = trimmed.slice(-tail);
  return `${prefix}****${suffix}`;
}

/**
 * 115 专用 Cookie 脱敏器：精准识别 UID、CID、SEID 等关键鉴权键值并进行部分掩码。
 */
export function maskPan115Cookie(cookie?: string | null): string {
  if (!cookie) return "";
  const parts = cookie.split(";").map((p) => p.trim());
  const maskedParts = parts.map((part) => {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) return part;
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1).trim();
    if (["UID", "CID", "SEID", "CID_HASH"].includes(k.toUpperCase())) {
      return `${k}=${maskSecret(v, 2, 2)}`;
    }
    return `${k}=${maskSecret(v, 1, 1)}`;
  });
  return maskedParts.join("; ");
}

export interface StorageMaskedSummary {
  provider: string;
  engineMode?: Pan115EngineMode | undefined;
  hasCookie: boolean;
  maskedCookie?: string | undefined;
  hasOpenOAuth: boolean;
  maskedAccessToken?: string | undefined;
  maskedRefreshToken?: string | undefined;
  tokenExpiresInSec?: number | undefined;
  tokenExpired?: boolean | undefined;
}

export interface RevealedCredentials {
  provider: string;
  cookie?: string | undefined;
  openOAuth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    clientId?: string | undefined;
  } | undefined;
  token?: string | undefined;
}

export interface StorageCredentialStrategy {
  getMaskedSummary(payload: unknown): StorageMaskedSummary;
  reveal(payload: unknown): RevealedCredentials;
}

export class Pan115CredentialStrategy implements StorageCredentialStrategy {
  getMaskedSummary(payload: unknown): StorageMaskedSummary {
    const data = (payload as Record<string, unknown> | null) ?? {};
    const cookie = typeof data.cookie === "string" ? data.cookie.trim() : "";
    const openOAuth = data.openOAuth as Pan115OpenOAuthCredentials | undefined;
    const hasOpenOAuth = isPan115OpenOAuthValid(openOAuth);
    const engineMode = resolvePan115EngineMode(data);

    let maskedAccessToken: string | undefined;
    let maskedRefreshToken: string | undefined;
    let tokenExpiresInSec: number | undefined;
    let tokenExpired: boolean | undefined;

    if (openOAuth && openOAuth.accessToken) {
      maskedAccessToken = maskSecret(openOAuth.accessToken, 4, 4);
      maskedRefreshToken = maskSecret(openOAuth.refreshToken, 4, 4);
      const now = Date.now();
      const diffMs = openOAuth.expiresAt - now;
      tokenExpiresInSec = Math.max(0, Math.floor(diffMs / 1000));
      tokenExpired = diffMs <= 0;
    }

    return {
      provider: "pan115",
      engineMode,
      hasCookie: Boolean(cookie),
      maskedCookie: cookie ? maskPan115Cookie(cookie) : undefined,
      hasOpenOAuth,
      maskedAccessToken,
      maskedRefreshToken,
      tokenExpiresInSec,
      tokenExpired,
    };
  }

  reveal(payload: unknown): RevealedCredentials {
    const data = (payload as Record<string, unknown> | null) ?? {};
    const cookie = typeof data.cookie === "string" ? data.cookie.trim() : undefined;
    const openOAuth = data.openOAuth as Pan115OpenOAuthCredentials | undefined;

    return {
      provider: "pan115",
      ...(cookie ? { cookie } : {}),
      ...(openOAuth
        ? {
            openOAuth: {
              accessToken: openOAuth.accessToken,
              refreshToken: openOAuth.refreshToken,
              expiresAt: openOAuth.expiresAt,
              ...(openOAuth.clientId ? { clientId: openOAuth.clientId } : {}),
            },
          }
        : {}),
    };
  }
}

export class GenericTokenCredentialStrategy implements StorageCredentialStrategy {
  constructor(private readonly provider: string) {}

  getMaskedSummary(payload: unknown): StorageMaskedSummary {
    const data = (payload as Record<string, unknown> | null) ?? {};
    const cookie = typeof data.cookie === "string" ? data.cookie.trim() : "";
    const token = typeof data.token === "string" ? data.token.trim() : "";

    return {
      provider: this.provider,
      hasCookie: Boolean(cookie),
      maskedCookie: cookie ? maskSecret(cookie, 3, 3) : undefined,
      hasOpenOAuth: Boolean(token),
      maskedAccessToken: token ? maskSecret(token, 4, 4) : undefined,
    };
  }

  reveal(payload: unknown): RevealedCredentials {
    const data = (payload as Record<string, unknown> | null) ?? {};
    const cookie = typeof data.cookie === "string" ? data.cookie.trim() : undefined;
    const token = typeof data.token === "string" ? data.token.trim() : undefined;

    return {
      provider: this.provider,
      ...(cookie ? { cookie } : {}),
      ...(token ? { token } : {}),
    };
  }
}

const STRATEGIES: Record<string, StorageCredentialStrategy> = {
  pan115: new Pan115CredentialStrategy(),
};

export function getCredentialStrategy(provider: string): StorageCredentialStrategy {
  return STRATEGIES[provider] ?? new GenericTokenCredentialStrategy(provider);
}

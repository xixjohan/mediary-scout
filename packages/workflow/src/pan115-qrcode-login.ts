/**
 * 115 QR-code login: the 3-step unauthenticated flow used by the open-source
 * ecosystem (AList/115driver, p115client). No app keys — the `sign` comes
 * from step 1. The chosen `app` (client type) decides which existing 115
 * session gets kicked; mini-program types are effectively long-lived and
 * never collide with the user's browser session, so `alipaymini` is the
 * default.
 */

export type Pan115QrFetchJson = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
) => Promise<unknown>;

export interface Pan115QrSession {
  uid: string;
  time: number;
  sign: string;
  /** String content to render as a QR code client-side. */
  qrcodeContent: string;
}

export type Pan115QrStatus = "waiting" | "scanned" | "confirmed" | "expired" | "canceled";

export interface Pan115QrCookie {
  cookie: string;
  userId: number;
  userName: string;
  app: string;
}

export class Pan115QrExchangeError extends Error {
  readonly code?: number | undefined;
  constructor(message: string, code?: number | undefined) {
    super(`PAN115_QR_EXCHANGE_FAILED: ${message}`);
    this.name = "Pan115QrExchangeError";
    this.code = code;
  }
}

export function isPan115QrExchangeError(error: unknown): error is Pan115QrExchangeError {
  return error instanceof Pan115QrExchangeError;
}

export const PAN115_QR_LOGIN_APPS = [
  "tv",
  "qandroid",
  "android",
  "ios",
  "web",
  "alipaymini",
  "wechatmini",
] as const;

export type Pan115QrLoginApp = (typeof PAN115_QR_LOGIN_APPS)[number];

const QRCODE_API = "https://qrcodeapi.115.com";
const PASSPORT_API = "https://passportapi.115.com";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class Pan115QrLoginClient {
  private readonly fetchJson: Pan115QrFetchJson;
  private readonly userAgent: string;

  constructor(options: { fetchJson?: Pan115QrFetchJson; userAgent?: string } = {}) {
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async getToken(): Promise<Pan115QrSession> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = asRecord(
          await this.fetchJson(`${QRCODE_API}/api/1.0/web/1.0/token/`, {
            method: "GET",
            headers: this.headers(),
          }),
        );
        const data = asRecord(response["data"]);
        const uid = stringValue(data["uid"]);
        if (!uid) {
          throw new Error("PAN115_QR_TOKEN_FAILED: no uid in token response");
        }
        return {
          uid,
          time: numberValue(data["time"]),
          sign: stringValue(data["sign"]),
          qrcodeContent: stringValue(data["qrcode"]) || `https://115.com/scan/dg-${uid}`,
        };
      } catch (err) {
        lastError = err;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }
    throw lastError;
  }

  /**
   * One long-poll round (the endpoint holds the connection ~30s). A timeout
   * response can omit `data.status` entirely — that means "still waiting",
   * not an error.
   */
  async pollStatus(session: Pan115QrSession): Promise<Pan115QrStatus> {
    const query = new URLSearchParams({
      uid: session.uid,
      time: String(session.time),
      sign: session.sign,
      _: String(Date.now()),
    });
    const response = asRecord(
      await this.fetchJson(`${QRCODE_API}/get/status/?${query.toString()}`, {
        method: "GET",
        headers: this.headers(),
      }),
    );
    const data = isRecord(response["data"]) ? response["data"] : {};
    const status = data["status"];
    switch (status) {
      case 1:
        return "scanned";
      case 2:
        return "confirmed";
      case -1:
        return "expired";
      case -2:
        return "canceled";
      default:
        return "waiting";
    }
  }

  /**
   * Only call after pollStatus returned "confirmed".
   * Tries the preferred client app type first; if 115 rejects that specific app
   * (e.g. user scanned with WeChat or 115 App while dropdown was set to Alipay),
   * automatically probes the alternative candidate apps so authorization succeeds
   * regardless of which app scanned the code.
   */
  async exchangeCookie(
    session: Pan115QrSession,
    preferredApp: Pan115QrLoginApp = "tv",
  ): Promise<Pan115QrCookie> {
    // 115 provides identical passport endpoints on both qrcodeapi.115.com (domestic Aliyun IP 47.113.23.100)
    // and passportapi.115.com (Anycast 8.25.82.x). Probing qrcodeapi first avoids the 8.0.0.0/8 GeoIP
    // US misclassification trap that causes transparent proxies to route requests overseas and get RSTed.
    const apiHosts = [QRCODE_API, PASSPORT_API];
    const candidates = [
      preferredApp,
      ...PAN115_QR_LOGIN_APPS.filter((a) => a !== preferredApp),
    ];
    let firstErrorMessage = "";
    let firstErrorCode: number | undefined;

    for (const host of apiHosts) {
      let receivedAuthoritativeResponse = false;
      for (const app of candidates) {
        const body = new URLSearchParams({ account: session.uid, app });
        let response: Record<string, unknown>;
        try {
          response = asRecord(
            await this.fetchJson(`${host}/app/1.0/${app}/1.0/login/qrcode/`, {
              method: "POST",
              headers: {
                ...this.headers(),
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
              },
              body: body.toString(),
              timeoutMs: 8_000,
            }),
          );
          if (response["state"] !== undefined || response["errno"] !== undefined || response["code"] !== undefined) {
            receivedAuthoritativeResponse = true;
          }
        } catch (err) {
          if (!firstErrorMessage) {
            firstErrorMessage = err instanceof Error ? err.message : String(err);
          }
          continue;
        }

        const data = asRecord(response["data"]);
        const cookieRecord = asRecord(data["cookie"]);
        const pairs = (["UID", "CID", "SEID", "KID"] as const)
          .map((key) => [key, stringValue(cookieRecord[key])] as const)
          .filter(([, value]) => value !== "");

        if (pairs.some(([key]) => key === "UID")) {
          return {
            cookie: pairs.map(([key, value]) => `${key}=${value}`).join("; "),
            userId: numberValue(data["user_id"]),
            userName: stringValue(data["user_name"]),
            app,
          };
        }

        if (!firstErrorMessage) {
          firstErrorMessage = stringValue(response["message"]) || stringValue(response["error"]);
          firstErrorCode = numberValue(response["code"]) || numberValue(response["errno"]) || undefined;
        }
      }
      if (receivedAuthoritativeResponse) {
        break;
      }
    }

    throw new Pan115QrExchangeError(firstErrorMessage || "no cookie in response", firstErrorCode);
  }

  private headers(): Record<string, string> {
    return {
      "User-Agent": this.userAgent,
      Referer: "https://115.com/",
      Accept: "application/json, text/plain, */*",
      // Explicitly close the connection after each request so undici does not pool
      // idle sockets that 115's WAF terminates abruptly with TCP RST (causing read ECONNRESET).
      Connection: "close",
    };
  }
}

export function isTransientPan115NetworkError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown })?.cause;
  const causeMsg = cause instanceof Error ? cause.message : String(cause ?? "");
  const causeCode = (cause as { code?: string })?.code ?? "";
  const combined = `${msg} ${causeMsg} ${causeCode}`.toLowerCase();
  return (
    combined.includes("econnreset") ||
    combined.includes("socket hang up") ||
    combined.includes("etimedout") ||
    combined.includes("econnrefused") ||
    combined.includes("network socket disconnected") ||
    combined.includes("und_err_socket") ||
    combined.includes("fetch failed")
  );
}

async function defaultFetchJson(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<unknown> {
  const timeoutMs = init.timeoutMs ?? (url.includes("/get/status/") ? 35_000 : 8_000);
  const maxAttempts = url.includes("/get/status/") ? 1 : 2;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`115 QR endpoint failed with HTTP ${response.status}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1 && isTransientPan115NetworkError(err)) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 500));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

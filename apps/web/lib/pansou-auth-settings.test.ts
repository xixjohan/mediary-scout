import { beforeEach, describe, expect, it } from "vitest";
import { initCredentialCrypto, encryptSecret } from "@media-track/shared";
import {
  buildPanSouProviderChain,
  getPanSouAuth,
  PANSOU_PASSWORD_SETTING_KEY,
  PANSOU_TOKEN_SETTING_KEY,
  PANSOU_USERNAME_SETTING_KEY,
} from "./pansou-chain";
import { probePanSou } from "./pansou-probe";

/** 只有 getSetting 的最小仓库面：凭据只从库里读，不走 env（规格 non-goal：
 *  不把凭据下沉到 compose/env 层）。 */
function settingsOf(entries: Record<string, string>): {
  getSetting: (key: string) => Promise<string | null>;
} {
  return { getSetting: async (key) => entries[key] ?? null };
}

function healthResponse(authEnabled = false): Response {
  return new Response(JSON.stringify({ status: "ok", auth_enabled: authEnabled }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  // 每次测试一把新密钥：密文跨测试不可复用，且不能碰生产密钥文件。
  initCredentialCrypto({ ephemeral: true });
});

describe("getPanSouAuth", () => {
  it("只配了 token → bearer，且解密出的是原文", async () => {
    const auth = await getPanSouAuth(
      settingsOf({ [PANSOU_TOKEN_SETTING_KEY]: encryptSecret("pasted-jwt") }),
    );
    expect(auth).toEqual({ kind: "bearer", token: "pasted-jwt" });
  });

  it("配了用户名 + 密码 → login", async () => {
    const auth = await getPanSouAuth(
      settingsOf({
        [PANSOU_USERNAME_SETTING_KEY]: "admin",
        [PANSOU_PASSWORD_SETTING_KEY]: encryptSecret("s3cret"),
      }),
    );
    expect(auth).toEqual({ kind: "login", username: "admin", password: "s3cret" });
  });

  it("token 与用户名密码同时配了 → token 优先（规格明确的互斥规则）", async () => {
    const auth = await getPanSouAuth(
      settingsOf({
        [PANSOU_TOKEN_SETTING_KEY]: encryptSecret("pasted-jwt"),
        [PANSOU_USERNAME_SETTING_KEY]: "admin",
        [PANSOU_PASSWORD_SETTING_KEY]: encryptSecret("s3cret"),
      }),
    );
    expect(auth).toEqual({ kind: "bearer", token: "pasted-jwt" });
  });

  it("什么都没配 → none（不带头，回归保护）", async () => {
    expect(await getPanSouAuth(settingsOf({}))).toEqual({ kind: "none" });
  });

  it("只配了用户名没配密码 → none，绝不拿一半配置去登录", async () => {
    const auth = await getPanSouAuth(settingsOf({ [PANSOU_USERNAME_SETTING_KEY]: "admin" }));
    expect(auth).toEqual({ kind: "none" });
  });

  it("只配了密码没配用户名 → none", async () => {
    const auth = await getPanSouAuth(
      settingsOf({ [PANSOU_PASSWORD_SETTING_KEY]: encryptSecret("s3cret") }),
    );
    expect(auth).toEqual({ kind: "none" });
  });
});

describe("probePanSou 带认证", () => {
  it("先检查健康状态，再登录验证密码，不执行搜索", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const result = await probePanSou("http://192.168.1.10:8899", {
      auth: { kind: "login", username: "admin", password: "secret" },
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, method: init.method ?? "GET" });
        return url.endsWith("/api/health")
          ? healthResponse(true)
          : new Response(JSON.stringify({ token: "short-lived-probe-token" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([
      { url: "http://192.168.1.10:8899/api/health", method: "GET" },
      { url: "http://192.168.1.10:8899/api/auth/login", method: "POST" },
    ]);
  });

  it("验证 bearer 凭据时调用公开 verify 接口并带上 Authorization", async () => {
    const seen: Array<{ url: string; method: string; authorization: string | undefined }> = [];
    const result = await probePanSou("http://192.168.1.10:8899", {
      auth: { kind: "bearer", token: "pasted-jwt" },
      fetchImpl: (async (url: string, init: RequestInit) => {
        const authorization = (init.headers as Record<string, string> | undefined)?.Authorization;
        seen.push({ url, method: init.method ?? "GET", authorization });
        return url.endsWith("/api/health")
          ? healthResponse(true)
          : new Response(JSON.stringify({ valid: true }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([
      { url: "http://192.168.1.10:8899/api/health", method: "GET", authorization: undefined },
      {
        url: "http://192.168.1.10:8899/api/auth/verify",
        method: "POST",
        authorization: "Bearer pasted-jwt",
      },
    ]);
  });

  it("401 报成可判定的认证失败，而不是含糊的「连不上」", async () => {
    const result = await probePanSou("http://192.168.1.10:8899", {
      auth: { kind: "login", username: "admin", password: "wrong" },
      fetchImpl: (async (url: string) => url.endsWith("/api/health")
        ? healthResponse(true)
        : new Response(JSON.stringify({ error: "用户名或密码错误" }), { status: 401 })) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("auth_failed");
    expect(result.message).toContain("认证");
  });

  it("没配认证时不带 Authorization 头（回归保护）", async () => {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const result = await probePanSou("http://192.168.1.10:8899", {
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({
          url,
          authorization: (init.headers as Record<string, string> | undefined)?.Authorization,
        });
        return healthResponse(false);
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      { url: "http://192.168.1.10:8899/api/health", authorization: undefined },
    ]);
  });

  it("login network failures are unreachable and retain only the stable transport code", async () => {
    const result = await probePanSou("http://192.168.1.10:8899", {
      auth: { kind: "login", username: "admin", password: "secret" },
      fetchImpl: (async (url: string) => {
        if (url.endsWith("/api/health")) return healthResponse(true);
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
        });
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    if (!result.ok) {
      expect(result.message).toContain("UND_ERR_SOCKET");
      expect(result.message).not.toContain("secret");
    }
  });
});

describe("buildPanSouProviderChain 透传认证", () => {
  it("auth 一路带到最终 provider：搜索请求带着 Authorization 出门", async () => {
    const seen: Array<Record<string, string>> = [];
    const provider = buildPanSouProviderChain({
      userBaseURL: "https://mine.example",
      allowedTypes: [],
      auth: { kind: "bearer", token: "pasted-jwt" },
      fetchJson: async (_url, init) => {
        seen.push(init.headers);
        return { code: 0, data: { results: [] } };
      },
    });

    await provider.search({ keyword: "k" });

    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers.Authorization).toBe("Bearer pasted-jwt");
    }
  });

  it("不配 auth 时链上没有任何 Authorization 头", async () => {
    const seen: Array<Record<string, string>> = [];
    const provider = buildPanSouProviderChain({
      userBaseURL: "https://mine.example",
      allowedTypes: [],
      fetchJson: async (_url, init) => {
        seen.push(init.headers);
        return { code: 0, data: { results: [] } };
      },
    });

    await provider.search({ keyword: "k" });

    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers.Authorization).toBeUndefined();
    }
  });
});

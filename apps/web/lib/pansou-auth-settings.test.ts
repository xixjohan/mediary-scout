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

function pansouResponse(body: unknown = { data: { results: [] } }, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
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
  it("给了 bearer 认证就把 Authorization 头带上", async () => {
    let seenAuth: string | undefined;
    const result = await probePanSou("http://192.168.1.10:8899", {
      auth: { kind: "bearer", token: "pasted-jwt" },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seenAuth = (init.headers as Record<string, string> | undefined)?.Authorization;
        return new Response(JSON.stringify({ data: { results: [] } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true });
    expect(seenAuth).toBe("Bearer pasted-jwt");
  });

  it("401 报成可判定的认证失败，而不是含糊的「连不上」", async () => {
    const result = await probePanSou("http://192.168.1.10:8899", {
      auth: { kind: "login", username: "admin", password: "wrong" },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ code: "AUTH_TOKEN_MISSING", error: "未授权：缺少认证令牌" }), {
          status: 401,
        })) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("auth_failed");
    expect(result.message).toContain("认证");
  });

  it("没配认证时不带 Authorization 头（回归保护）", async () => {
    let seenAuth: string | undefined;
    await probePanSou("http://192.168.1.10:8899", {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seenAuth = (init.headers as Record<string, string> | undefined)?.Authorization;
        return new Response(JSON.stringify({ data: { results: [] } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(seenAuth).toBeUndefined();
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

void pansouResponse;

import { describe, expect, it } from "vitest";
import { FallbackResourceProvider } from "../src/fallback-provider.js";
import { PanSouAuthError } from "../src/resource-source-health.js";
import { PanSouResourceProvider } from "../src/pansou-provider.js";

/** 记录到的每一次出站请求。登录与搜索都走可注入的 fetchJson/loginJson，
 *  所以一个数组就能同时断言「登录发了什么」与「搜索带了什么头」。 */
interface Seen {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

/** 每次测试一个空缓存：默认缓存是模块级 Map，跨用例共享会把
 *  「缓存命中不重复登录」和「需要重新登录」互相污染。 */
function freshCache(): {
  get: (key: string) => { token: string; expiresAt: number } | undefined;
  set: (key: string, value: { token: string; expiresAt: number }) => void;
} {
  const map = new Map<string, { token: string; expiresAt: number }>();
  return { get: (key) => map.get(key), set: (key, value) => void map.set(key, value) };
}

function searchBody(keyword: string): unknown {
  return {
    code: 0,
    data: { results: [{ title: keyword, links: [{ type: "magnet", url: "magnet:?xt=urn:btih:a" }] }] },
  };
}

/** expires_at 是 epoch **秒**（PanSou 用 time.Now().Add(expiry).Unix()）。 */
function expiresIn(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

describe("PanSouResourceProvider 认证", () => {
  it("kind=login：先 POST /api/auth/login，再让每个 /api/search 带上 Authorization: Bearer", async () => {
    const seen: Seen[] = [];
    const provider = new PanSouResourceProvider({
      baseURL: "https://pansou.example",
      maxSearchAttempts: 1,
      auth: { kind: "login", username: "admin", password: "s3cret" },
      tokenCache: freshCache(),
      loginJson: async (url, init) => {
        seen.push({ url, init });
        return { token: "jwt-abc", expires_at: expiresIn(3600), username: "admin" };
      },
      fetchJson: async (url, init) => {
        seen.push({ url, init });
        return searchBody("孤独摇滚");
      },
    });

    await provider.search({ keyword: "孤独摇滚" });

    const login = seen.find((call) => call.url.endsWith("/api/auth/login"));
    expect(login, "必须真的发一次登录请求").toBeDefined();
    expect(login!.init.method).toBe("POST");
    expect(JSON.parse(login!.init.body)).toEqual({ username: "admin", password: "s3cret" });

    const searches = seen.filter((call) => call.url.endsWith("/api/search"));
    expect(searches.length).toBeGreaterThan(0);
    for (const call of searches) {
      expect(call.init.headers.Authorization).toBe("Bearer jwt-abc");
    }
    // 登录必须排在第一次搜索之前，否则第一次搜索是裸的。
    expect(seen[0]!.url).toContain("/api/auth/login");
  });

  it("token 未临过期时缓存命中：两次搜索只登录一次", async () => {
    const seen: Seen[] = [];
    const make = () =>
      new PanSouResourceProvider({
        baseURL: "https://cache.example",
        maxSearchAttempts: 1,
        auth: { kind: "login", username: "admin", password: "s3cret" },
        tokenCache: freshCache(),
        loginJson: async (url, init) => {
          seen.push({ url, init });
          return { token: "jwt-abc", expires_at: expiresIn(3600) };
        },
        fetchJson: async (url, init) => {
          seen.push({ url, init });
          return searchBody("k");
        },
      });
    // 同一个缓存跨两个 provider 实例：getWorkerResourceProvider 每次调用都新建
    // provider，缓存必须在实例之外才生效。
    const cache = freshCache();
    const opts = {
      baseURL: "https://cache.example",
      maxSearchAttempts: 1,
      auth: { kind: "login" as const, username: "admin", password: "s3cret" },
      tokenCache: cache,
      loginJson: async (url: string, init: Seen["init"]) => {
        seen.push({ url, init });
        return { token: "jwt-abc", expires_at: expiresIn(3600) };
      },
      fetchJson: async (url: string, init: Seen["init"]) => {
        seen.push({ url, init });
        return searchBody("k");
      },
    };

    await new PanSouResourceProvider(opts).search({ keyword: "a" });
    await new PanSouResourceProvider(opts).search({ keyword: "b" });
    void make;

    const logins = seen.filter((call) => call.url.endsWith("/api/auth/login"));
    expect(logins).toHaveLength(1);
    const searches = seen.filter((call) => call.url.endsWith("/api/search"));
    expect(searches).toHaveLength(2);
    for (const call of searches) {
      expect(call.init.headers.Authorization).toBe("Bearer jwt-abc");
    }
  });

  it("token 距过期不足 5 分钟时重新登录", async () => {
    const seen: Seen[] = [];
    const opts = {
      baseURL: "https://refresh.example",
      maxSearchAttempts: 1,
      auth: { kind: "login" as const, username: "admin", password: "s3cret" },
      tokenCache: freshCache(),
      loginJson: async (url: string, init: Seen["init"]) => {
        seen.push({ url, init });
        // 120 秒后过期，落在 5 分钟刷新余量内。
        return { token: `jwt-${seen.length}`, expires_at: expiresIn(120) };
      },
      fetchJson: async (url: string, init: Seen["init"]) => {
        seen.push({ url, init });
        return searchBody("k");
      },
    };

    await new PanSouResourceProvider(opts).search({ keyword: "a" });
    await new PanSouResourceProvider(opts).search({ keyword: "b" });

    const logins = seen.filter((call) => call.url.endsWith("/api/auth/login"));
    expect(logins).toHaveLength(2);
  });

  it("kind=bearer：直接用给定 token，不发登录请求", async () => {
    const seen: Seen[] = [];
    const provider = new PanSouResourceProvider({
      baseURL: "https://bearer.example",
      maxSearchAttempts: 1,
      auth: { kind: "bearer", token: "pasted-jwt" },
      tokenCache: freshCache(),
      loginJson: async (url, init) => {
        seen.push({ url, init });
        throw new Error("bearer 形态绝不应触发登录");
      },
      fetchJson: async (url, init) => {
        seen.push({ url, init });
        return searchBody("k");
      },
    });

    await provider.search({ keyword: "k" });

    expect(seen.filter((call) => call.url.endsWith("/api/auth/login"))).toHaveLength(0);
    const searches = seen.filter((call) => call.url.endsWith("/api/search"));
    expect(searches).toHaveLength(1);
    expect(searches[0]!.init.headers.Authorization).toBe("Bearer pasted-jwt");
  });

  it("未配置 auth（或 kind=none）时绝不发送 Authorization 头", async () => {
    const seen: Seen[] = [];
    const provider = new PanSouResourceProvider({
      baseURL: "https://plain.example",
      maxSearchAttempts: 1,
      tokenCache: freshCache(),
      fetchJson: async (url, init) => {
        seen.push({ url, init });
        return searchBody("k");
      },
    });

    await provider.search({ keyword: "k" });

    expect(seen.filter((call) => call.url.endsWith("/api/auth/login"))).toHaveLength(0);
    const searches = seen.filter((call) => call.url.endsWith("/api/search"));
    expect(searches).toHaveLength(1);
    expect(searches[0]!.init.headers.Authorization).toBeUndefined();
  });
});

describe("PanSou 认证失败必须穿透两层，不能被折成 unreachable 后悄悄降级", () => {
  it("登录失败时 search() 抛出 PanSouAuthError，而不是吞成 sourceHealth 快照", async () => {
    const provider = new PanSouResourceProvider({
      baseURL: "https://authfail.example",
      maxSearchAttempts: 1,
      auth: { kind: "login", username: "admin", password: "wrong" },
      tokenCache: freshCache(),
      loginJson: async () => {
        throw new PanSouAuthError("PanSou 登录返回 HTTP 401：用户名或密码错误");
      },
      fetchJson: async () => searchBody("k"),
    });

    // 吞成 sourceHealth 的表现是：search() 正常 resolve，但候选为空、
    // sourceHealth.status === "unreachable"。那正是 FallbackResourceProvider
    // 据此降级到官方源的信号 —— 一次配置错误靠公共源静默续命。
    await expect(provider.search({ keyword: "k" })).rejects.toThrow(PanSouAuthError);
  });

  it("FallbackResourceProvider 不为认证失败降级到官方源，而是把错误抛出去", async () => {
    let secondaryCalled = false;
    const primary = new PanSouResourceProvider({
      baseURL: "https://authfail.example",
      maxSearchAttempts: 1,
      auth: { kind: "login", username: "admin", password: "wrong" },
      tokenCache: freshCache(),
      loginJson: async () => {
        throw new PanSouAuthError("PanSou 登录返回 HTTP 401：用户名或密码错误");
      },
      fetchJson: async () => searchBody("k"),
    });
    const secondary = new PanSouResourceProvider({
      baseURL: "https://official.example",
      maxSearchAttempts: 1,
      tokenCache: freshCache(),
      fetchJson: async () => {
        secondaryCalled = true;
        return searchBody("k");
      },
    });
    const fallback = new FallbackResourceProvider({
      primary: { name: "自建搜索源", provider: primary },
      secondary: { name: "官方搜索源", provider: secondary },
    });

    await expect(fallback.search({ keyword: "k" })).rejects.toThrow(PanSouAuthError);
    expect(secondaryCalled, "认证失败绝不能退到官方源").toBe(false);
  });
});

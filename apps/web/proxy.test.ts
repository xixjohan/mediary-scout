import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proxy } from "./proxy";
import type { NextRequest } from "next/server";

/**
 * proxy 门禁判定的全组合覆盖。
 *
 * 这是「远程要登录、局域网免登录」的 Edge 侧实现，也是 Emby/Jellyfin 出事故的
 * 同一类判定。它只做 UX 层的重定向（权威判定在服务端 getCurrentAccountId()），
 * 但判错方向仍有代价：
 *  - 远程 + 无 session 却放行 → 用户看到空数据页而不是登录页（体验坏）
 *  - 局域网被误判成需登录 → 本地用户凭空多一道门（回归）
 *
 * 现行规则只有两个输入：是否 (多用户 || 远程)，以及有没有 session。
 * proxy 不再读 `mt_auth_required`，「有没有设过密码」不参与任何门禁判定。
 */

// 本套件断言的是单用户行为。必须显式关掉多用户开关：若被 runner 设置或从
// 别的测试文件泄漏进来，proxy 会走「处处门禁」分支，断言就在悄悄测另一件事。
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;
beforeAll(() => {
  delete process.env.MEDIA_TRACK_MULTI_USER;
});
afterAll(() => {
  if (prevMultiUser !== undefined) {
    process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  } else {
    delete process.env.MEDIA_TRACK_MULTI_USER;
  }
});

const makeRequest = (opts: {
  path?: string;
  cf?: boolean;
  staleAuthCookie?: boolean;
  session?: boolean;
  authorization?: string;
}): NextRequest => {
  const headers = new Headers();
  if (opts.cf) headers.set("cf-ray", "8f3abc-LAX");
  if (opts.authorization) headers.set("authorization", opts.authorization);
  const cookies = new Map<string, { name: string; value: string }>();
  // `mt_auth_required` is no longer written by anything and no longer read by
  // proxy — the gate is (multi-user || remote) + session, full stop. It is kept
  // here ONLY as a representative stale cookie, to pin that a leftover cookie on
  // a long-lived browser cannot change a gate decision in either direction.
  // Setting it does NOT mean "a password is set"; proxy has no notion of that.
  if (opts.staleAuthCookie)
    cookies.set("mt_auth_required", { name: "mt_auth_required", value: "1" });
  if (opts.session) cookies.set("mt_session", { name: "mt_session", value: "sess.sig" });
  const url = new URL(`http://localhost:3000${opts.path ?? "/"}`);
  return {
    headers,
    cookies: { get: (name: string) => cookies.get(name) },
    nextUrl: {
      pathname: url.pathname,
      clone: () => new URL(url.toString()),
      search: "",
    },
  } as unknown as NextRequest;
};

/** 判定结果：是否被重定向到 /login。 */
const redirectsToLogin = (req: NextRequest): boolean => {
  const res = proxy(req);
  return res.status >= 300 && res.status < 400 && (res.headers.get("location") ?? "").includes("/login");
};

describe("proxy gate — single-user mode (multi-user off)", () => {
  it("局域网（无 CF 头）→ 直通，零摩擦（任何 cookie 状态下都一样）", () => {
    expect(redirectsToLogin(makeRequest({}))).toBe(false);
    // 局域网直通与 cookie 无关：带一个残留 cookie 也不得凭空多出一道门。
    expect(redirectsToLogin(makeRequest({ staleAuthCookie: true }))).toBe(false);
  });

  it("未设密码 + 远程 → 仍要重定向到 /login（那里给的是设置密码表单）", () => {
    // 旧规则是 passwordSet && isRemote，未设密码的实例对公网匿名访客直接放行。
    // 服务端修复后会返回 acct_unauthenticated，若 proxy 还放行，远程站主只会
    // 看到一个没有出口的空页面。两侧同规则：远程一律要 session。
    expect(redirectsToLogin(makeRequest({ cf: true }))).toBe(true);
  });

  it("远程 + 无 session → 重定向到登录（残留 cookie 不得放行）", () => {
    expect(redirectsToLogin(makeRequest({ staleAuthCookie: true, cf: true }))).toBe(true);
  });

  it("远程 + 有 session → 直通（残留 cookie 不影响）", () => {
    expect(redirectsToLogin(makeRequest({ staleAuthCookie: true, cf: true, session: true }))).toBe(
      false,
    );
  });

  it("远程 + 有 session → 直通（session 才是唯一判据）", () => {
    expect(redirectsToLogin(makeRequest({ cf: true, session: true }))).toBe(false);
  });

  it("三个 CF 头任一存在都算远程", () => {
    for (const header of ["cf-ray", "cdn-loop", "cf-connecting-ip"]) {
      const req = makeRequest({});
      req.headers.set(header, "x");
      expect(redirectsToLogin(req)).toBe(true);
    }
  });

  it("handler 自守的 API 前缀不被重定向（否则会把 JSON 端点变成 HTML 跳转）", () => {
    for (const path of ["/api/health", "/api/workflows/run", "/api/agent/step"]) {
      expect(redirectsToLogin(makeRequest({ cf: true, path }))).toBe(false);
    }
  });
});

describe("proxy gate — multi-user mode", () => {
  it("多用户：无 session 一律重定向，与来源和任何残留 cookie 无关", () => {
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    try {
      expect(redirectsToLogin(makeRequest({}))).toBe(true); // LAN 也要登录
      expect(redirectsToLogin(makeRequest({ cf: true }))).toBe(true);
      expect(redirectsToLogin(makeRequest({ staleAuthCookie: true }))).toBe(true);
      expect(redirectsToLogin(makeRequest({ session: true }))).toBe(false);
    } finally {
      delete process.env.MEDIA_TRACK_MULTI_USER;
    }
  });

  it("多用户、无 session：/api/update/busy 与 /api/update/hold 放行，/api/update/status 仍重定向", () => {
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    try {
      expect(redirectsToLogin(makeRequest({ path: "/api/update/busy" }))).toBe(false);
      expect(redirectsToLogin(makeRequest({ path: "/api/update/hold" }))).toBe(false);
      expect(redirectsToLogin(makeRequest({ path: "/api/update/status" }))).toBe(true);
    } finally {
      delete process.env.MEDIA_TRACK_MULTI_USER;
    }
  });
});

/**
 * S5.4 对抗性自审补的用例（真缺口，非假设）。
 *
 * 起真实服务实测：单用户远程（cf-ray）+ `Authorization: Bearer <有效 JWT>` 打
 * /api/activity → **307 跳 /login**，JWT 通道整个失效。根因：proxy 的豁免名单
 * 只认 session cookie（写于 S5.4 之前），而「权威判定在服务端」正是本文件自己
 * 的注释——S5.4 之后 /api/* 的守卫 requireApiAccount() 同时认 cookie 与 JWT，
 * proxy 却只放行前者。外网程序化访问（API key → JWT 的全部意义）被一道 UX 层
 * 重定向挡死。
 *
 * 修法同 updater/worker 的豁免：presence 粗筛放行，签名与过期交由路由判。
 */
describe("proxy gate — Bearer JWT（S5.4 自审）", () => {
  const JWT = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2N0X2p3dCJ9.sig";

  it("单用户远程 + /api 路径：有 Bearer 放行、无凭据仍重定向（同一边界两句话）", () => {
    expect(redirectsToLogin(makeRequest({ cf: true, path: "/api/activity", authorization: JWT }))).toBe(
      false,
    );
    expect(redirectsToLogin(makeRequest({ cf: true, path: "/api/activity" }))).toBe(true);
  });

  it("单用户远程 + Bearer JWT + API 路径 → 不得重定向（JSON 端点不能被变成 HTML 跳转）", () => {
    for (const path of ["/api/activity", "/api/settings/api-key", "/api/115/qrcode/status"]) {
      expect(redirectsToLogin(makeRequest({ cf: true, path, authorization: JWT }))).toBe(false);
    }
  });

  it("单用户远程 + 无 Authorization → 仍重定向（不放宽）", () => {
    expect(redirectsToLogin(makeRequest({ cf: true }))).toBe(true);
  });

  it("多用户 + Bearer JWT（无 session）+ /api 路径 → 不得重定向", () => {
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    try {
      expect(redirectsToLogin(makeRequest({ path: "/api/activity", authorization: JWT }))).toBe(false);
      expect(
        redirectsToLogin(makeRequest({ cf: true, path: "/api/activity", authorization: JWT })),
      ).toBe(false);
      // 对照：同一场景去掉 Authorization，照样重定向（没有悄悄放宽）
      expect(redirectsToLogin(makeRequest({ path: "/api/activity" }))).toBe(true);
    } finally {
      delete process.env.MEDIA_TRACK_MULTI_USER;
    }
  });

  // L4：粗筛与路由层（/^bearer (.+)$/i）的空白容忍度必须一致——tab 或多个
  // 空格 proxy 放行、路由也认；反过来 proxy 收紧一个字符就会把外网 JWT 拦死。
  it.each([
    ["单个空格", "Bearer "],
    ["tab", "Bearer\t"],
    ["多个空格", "Bearer   "],
    ["大小写混写", "BeArEr "],
  ])("Bearer 头形态「%s」proxy 与路由层判定一致（放行）", (_label, prefix) => {
    expect(redirectsToLogin(makeRequest({ cf: true, path: "/api/activity", authorization: `${prefix}eyJhbGciOiJIUzI1NiJ9.sig` }))).toBe(false);
  });

  it("页面路径（非 /api/）+ Bearer JWT → 仍重定向（浏览器导航不该被凭据头放行）", () => {
    expect(
      redirectsToLogin(makeRequest({ cf: true, path: "/settings", authorization: JWT })),
    ).toBe(true);
  });
});

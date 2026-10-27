import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldRedirectToLogin } from "./page-auth-guard";

/**
 * S5.7 页面登录守卫（纯函数，便于在无 React 的前提下钉死语义）。
 *
 * 需求：「设了访问密码就要登录」——**与请求来自哪里无关**。此前只有经隧道的
 * 远程请求被门禁（proxy.ts 的 `multiUser || isRemote`），局域网一律直通，
 * 于是站主在自己家网络上打开也看不到登录页。
 *
 * 三态密码状态必须分开处理（hasLoginPassword 的契约）：
 *   true    → 拦（送 /login）
 *   false   → 不拦（未设密码，保持局域网零摩擦）
 *   "unknown"（DB 抖动）→ 不拦。读不到 ≠ 设了密码：一次数据库抖动就把局域网
 *                        用户锁在登录页外，是把故障放大成拒绝服务。
 */

describe("shouldRedirectToLogin", () => {
  it("设了密码 + 无 session → 拦（送 /login）", () => {
    expect(shouldRedirectToLogin({ guarded: true, passwordState: true, hasSession: false })).toBe(true);
  });

  it("设了密码 + 无 session → 每个页面路径都拦", () => {
    for (const _ of [1, 2, 3]) {
      expect(shouldRedirectToLogin({ guarded: true, passwordState: true, hasSession: false })).toBe(true);
    }
  });

  it("设了密码 + 有 session → 不拦", () => {
    expect(shouldRedirectToLogin({ guarded: true, passwordState: true, hasSession: true })).toBe(false);
  });

  it("没设密码 + 无 session → 不拦（局域网零摩擦不回归）", () => {
    expect(shouldRedirectToLogin({ guarded: true, passwordState: false, hasSession: false })).toBe(false);
  });

  it("密码状态读不出来（unknown）+ 无 session → 不拦（本地宽容，不把 DB 抖动放大成锁死）", () => {
    expect(shouldRedirectToLogin({ guarded: true, passwordState: "unknown", hasSession: false })).toBe(false);
  });

  it("无守卫信号（proxy 未匹配的路由，如 /login）→ 不拦（否则登录页自己成环）", () => {
    expect(shouldRedirectToLogin({ guarded: false, passwordState: true, hasSession: false })).toBe(false);
  });

  it("/login 自身 → 不拦（它不在 proxy matcher 里，拿不到信号 cookie）", () => {
    expect(shouldRedirectToLogin({ guarded: false, passwordState: true, hasSession: false })).toBe(false);
  });

  it("有信号 + 设了密码 + 有 session → 不拦（已登录）", () => {
    expect(shouldRedirectToLogin({ guarded: true, passwordState: true, hasSession: true })).toBe(false);
  });

  it("多路径一律拦（只要 proxy 给了信号）", () => {
    expect(shouldRedirectToLogin({ guarded: false, passwordState: true, hasSession: false })).toBe(false);
  });
});

/**
 * requirePageLogin() 的装配测试。
 *
 * 它读 next/headers + workflow-runtime，所以这两个模块要 mock。重点钉两件事：
 *   1. 「该拦」时确实调了 redirect("/login")（而不是静默返回）；
 *   2. 读取抛异常时**不得**把异常溅出去（layout/page 抛错 = 站点白屏）。
 */
describe("requirePageLogin", () => {
  const redirect = vi.fn();
  const cookieStore = new Map<string, string>();

  beforeEach(() => {
    vi.clearAllMocks();
    cookieStore.clear();
    redirect.mockClear();
    vi.doMock("next/headers", () => ({
      cookies: async () => ({
        get: (name: string) => (cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined),
      }),
    }));
    vi.doMock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
    vi.doMock("./workflow-runtime", () => ({
      SESSION_COOKIE_NAME: "mt_session",
      hasLoginPassword: vi.fn(async () => false),
    }));
  });

  afterEach(() => {
    vi.doUnmock("next/headers");
    vi.doUnmock("next/navigation");
    vi.doUnmock("./workflow-runtime");
    vi.resetModules();
  });

  const load = async () => {
    const mod = await import("./page-auth-guard");
    return mod.requirePageLogin;
  };

  it("有守卫信号 + 设了密码 + 无 session → redirect('/login')", async () => {
    cookieStore.set("mt_page_guarded", "1");
    const rt = await import("./workflow-runtime");
    vi.mocked(rt.hasLoginPassword).mockResolvedValue(true);
    await (await load())();
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("有守卫信号 + 设了密码 + 有 session → 不跳转", async () => {
    cookieStore.set("mt_page_guarded", "1");
    cookieStore.set("mt_session", "sess.sig");
    const rt = await import("./workflow-runtime");
    vi.mocked(rt.hasLoginPassword).mockResolvedValue(true);
    await (await load())();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("无守卫信号（/login 自身）→ 不跳转，且不读密码状态（省一次 DB）", async () => {
    const rt = await import("./workflow-runtime");
    await (await load())();
    expect(redirect).not.toHaveBeenCalled();
    expect(rt.hasLoginPassword).not.toHaveBeenCalled();
  });

  it("cookies() 抛异常 → 不得外抛（layout/page 抛错就是白屏）", async () => {
    vi.doUnmock("next/headers");
    vi.doMock("next/headers", () => ({
      cookies: async () => {
        throw new Error("no request scope");
      },
    }));
    await expect((await load())()).resolves.toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("hasLoginPassword() 抛异常 → 不得外抛（DB 抖动时放弃守卫）", async () => {
    cookieStore.set("mt_page_guarded", "1");
    const rt = await import("./workflow-runtime");
    vi.mocked(rt.hasLoginPassword).mockRejectedValue(new Error("db down"));
    await expect((await load())()).resolves.toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });
});

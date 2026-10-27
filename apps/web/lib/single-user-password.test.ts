import { afterEach, describe, expect, it, vi } from "vitest";

const prevSqlitePath = process.env.MEDIA_TRACK_SQLITE_PATH;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;

const boot = async () => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_MULTI_USER; // 单用户
  vi.resetModules();
  return import("./workflow-runtime");
};

afterEach(() => {
  delete process.env.MEDIA_TRACK_SQLITE_PATH;
  if (prevSqlitePath !== undefined) process.env.MEDIA_TRACK_SQLITE_PATH = prevSqlitePath;
  // 原值为 undefined 时必须删除而非跳过，否则会把值泄漏给后续测试文件
  if (prevMultiUser !== undefined) {
    process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  } else {
    delete process.env.MEDIA_TRACK_MULTI_USER;
  }
  vi.resetModules();
});

/**
 * ⚠️ 超时：这些用例会调用 setSingleUserPassword / loginAccount，二者都跑
 * memory-hard 的 scrypt（单次 ~50-80ms）。全量并行下与其它测试争抢 CPU 会远超
 * vitest 默认的 5s。显式放宽到 30s——这不是「慢测试」，是密码学原语的固有成本。
 */
const CRYPTO_TIMEOUT_MS = 30_000;

describe("single-user password gate", () => {
  it(
    "未设密码时 hasLoginPassword=false",
    async () => {
      const rt = await boot();
      expect(await rt.hasLoginPassword()).toBe(false);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "resolveSingleUserAccountId：LAN 认密码、远程一律需 session",
    async () => {
      const rt = await boot();
      // 纯函数，覆盖全部内外/密码/session 组合（这是本 plan 的安全核心判定）。
      // 注意 resolveSingleUserAccount 已在 S5.7 改名为 resolveSingleUserAccountId
      // 并收紧：LAN 也认密码了。下面每条都直接钉新语义。
      expect(rt.resolveSingleUserAccountId({ hasPassword: false, isRemote: false, sessionAccountId: null })).toBe("acct_default"); // 未设密码 + LAN → 开放
      // 未设密码 + 远程：曾经返回 acct_default —— 匿名公网访客直接拿到站主身份。
      // Cloudflare Access 移除后这是活的公网洞，已收紧为哨兵。
      expect(rt.resolveSingleUserAccountId({ hasPassword: false, isRemote: true, sessionAccountId: null })).toBe("acct_unauthenticated");
      // S5.7：设了密码 + LAN 无 session → 哨兵（此前 LAN 一律开放，站主在自家
      // 网络上也看不到登录页）。
      expect(rt.resolveSingleUserAccountId({ hasPassword: true, isRemote: false, sessionAccountId: null })).toBe("acct_unauthenticated");
      expect(rt.resolveSingleUserAccountId({ hasPassword: true, isRemote: false, sessionAccountId: "acct_default" })).toBe("acct_default"); // LAN 已登录 → 放行
      expect(rt.resolveSingleUserAccountId({ hasPassword: true, isRemote: false, sessionAccountId: "acct_other" })).toBe("acct_unauthenticated"); // LAN 别账号 → 哨兵
      expect(rt.resolveSingleUserAccountId({ hasPassword: true, isRemote: true, sessionAccountId: null })).toBe("acct_unauthenticated"); // 远程无 session → 哨兵
      expect(rt.resolveSingleUserAccountId({ hasPassword: true, isRemote: true, sessionAccountId: "acct_default" })).toBe("acct_default"); // 远程已登录 → 放行
      expect(rt.resolveSingleUserAccountId({ hasPassword: "unknown", isRemote: false, sessionAccountId: null })).toBe("acct_default"); // DB 抖动 + LAN → 宽容
      expect(rt.resolveSingleUserAccountId({ hasPassword: "unknown", isRemote: true, sessionAccountId: null })).toBe("acct_unauthenticated"); // DB 抖动 + 远程 → 收紧
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "isRemoteRequest：任一 CF 头即远程（不只靠 cf-connecting-ip——它可被 zone 配置删除）",
    async () => {
      const rt = await boot();
      expect(rt.isRemoteRequest(new Headers({ "cf-ray": "8f3-abc" }))).toBe(true);
      expect(rt.isRemoteRequest(new Headers({ "cdn-loop": "cloudflare" }))).toBe(true);
      expect(rt.isRemoteRequest(new Headers({ "cf-connecting-ip": "1.2.3.4" }))).toBe(true);
      expect(rt.isRemoteRequest(new Headers({ "user-agent": "curl" }))).toBe(false); // LAN 无 CF 头
      expect(rt.isRemoteRequest(new Headers())).toBe(false);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "单用户设密码后可用密码登录 acct_default（用户名任意/空均视为 default）",
    async () => {
      const rt = await boot();
      await rt.setSingleUserPassword("secret-123");
      const bad = await rt.loginAccount("", "nope-nope");
      expect(bad.ok).toBe(false);
      const ok = await rt.loginAccount("", "secret-123");
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.accountId).toBe("acct_default");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "单用户未设密码时不能登录（没有密码可验证，不该发出 session）",
    async () => {
      const rt = await boot();
      const r = await rt.loginAccount("", "anything");
      expect(r.ok).toBe(false);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "单用户登录同样受限流保护（连续失败后锁定）",
    async () => {
      const rt = await boot();
      const { _resetLoginThrottleForTest } = await import("./login-throttle");
      _resetLoginThrottleForTest();
      await rt.setSingleUserPassword("secret-123");
      for (let i = 0; i < 5; i++) {
        const r = await rt.loginAccount("", "wrong-password");
        expect(r.ok).toBe(false);
      }
      const locked = await rt.loginAccount("", "secret-123"); // 正确密码也应被挡
      expect(locked.ok).toBe(false);
      if (!locked.ok) expect(locked.error).toContain("尝试过于频繁");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "单用户下换用户名不能绕过限流（用户名本就被忽略）",
    async () => {
      // 曾经的漏洞：限流键含用户名，而单用户登录忽略用户名 ⇒ 每次换个名字
      // 就换一个桶，限流形同虚设，且每次仍要付一次 memory-hard scrypt。
      const rt = await boot();
      const { _resetLoginThrottleForTest, buildThrottleKey } = await import("./login-throttle");
      _resetLoginThrottleForTest();
      await rt.setSingleUserPassword("secret-123");
      const headers = new Headers({ "cf-connecting-ip": "9.9.9.9" });

      let refusedByThrottle = 0;
      for (let i = 0; i < 8; i++) {
        // 模拟 route 的行为：单用户模式下身份为空串
        const r = await rt.loginAccount(`bogus${i}`, "wrong", buildThrottleKey(headers, ""));
        if (!r.ok && r.error.includes("尝试过于频繁")) refusedByThrottle++;
      }
      // 5 次失败即锁 ⇒ 后续几次必须被拦
      expect(refusedByThrottle).toBeGreaterThan(0);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "库级调用（无显式 throttleKey）在单用户下也共用同一个桶",
    async () => {
      const rt = await boot();
      const { _resetLoginThrottleForTest } = await import("./login-throttle");
      _resetLoginThrottleForTest();
      await rt.setSingleUserPassword("secret-123");
      let refused = 0;
      for (let i = 0; i < 8; i++) {
        const r = await rt.loginAccount(`name${i}`, "wrong"); // 不传 throttleKey
        if (!r.ok && r.error.includes("尝试过于频繁")) refused++;
      }
      expect(refused).toBeGreaterThan(0);
    },
    CRYPTO_TIMEOUT_MS,
  );
});

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  hasStrmSigningSecret,
  primeStrmSigningSecret,
  resolveStrmSigningSecret,
  _resetStrmSigningSecretForTests,
} from "./signing-secret.js";
import { buildPlayUrl, verifyStrmPlayToken } from "./strm-writer.js";

/**
 * 签名密钥的「不可伪造」契约（2026-11-17 事故的回归门禁）。
 *
 * 缺陷原型：`resolveStrmSigningSecret()` 在没有任何 env 时回退到硬编码常量
 * `"mediary-scout-strm-signing-secret"`。任何读过本仓库源码的人都能用它离线算出
 * 合法 token——实测在 dev 实例上返回 200 并开始推流；而 `.strm` 默认有效期
 * 365 天，一次泄露等于长期授权。
 *
 * 因此这里断言的不是「有一个默认值」，而是**没有可预测的默认值**：
 *  1. 无 env、未预热 → 抛错（签名失败是安全的；回退到公开常量是危险的）；
 *  2. 显式 env → 用它；
 *  3. 启动预热 → 用它；
 *  4. **任意两条路径得到的 secret 互不相同**（换个实例就换密钥）；
 *  5. 旧常量算出的 token 必须验签失败（钉住「已不能再伪造」）。
 */
describe("STRM 签名密钥不可伪造", () => {
  const ENV_KEYS = ["STRM_SECRET", "APP_SECRET"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    _resetStrmSigningSecretForTests();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    _resetStrmSigningSecretForTests();
  });

  it("无 env 且未预热 → 抛错（绝不回退到可预测常量）", () => {
    expect(hasStrmSigningSecret()).toBe(false);
    expect(() => resolveStrmSigningSecret()).toThrowError(/STRM_SIGNING_SECRET_UNAVAILABLE/);
  });

  it("显式 env 可用（外部编排覆盖优先）", () => {
    process.env.STRM_SECRET = "env-secret-32-characters-long!!!";
    expect(hasStrmSigningSecret()).toBe(true);
    expect(resolveStrmSigningSecret()).toBe("env-secret-32-characters-long!!!");
  });

  it("APP_SECRET 同样可用（历史部署兼容）", () => {
    process.env.APP_SECRET = "app-secret-32-characters-long!!!";
    expect(resolveStrmSigningSecret()).toBe("app-secret-32-characters-long!!!");
  });

  it("启动预热可用；过短的 secret 被拒绝", () => {
    primeStrmSigningSecret("primed-secret-32-characters-long!");
    expect(resolveStrmSigningSecret()).toBe("primed-secret-32-characters-long!");
    expect(() => primeStrmSigningSecret("short")).toThrowError(/过短/);
  });

  it("旧硬编码常量签出的 token 必须验签失败（已不能再伪造）", () => {
    const taskId = "strm_task_1";
    const fileId = "f1";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    // 复刻旧回退值的算法：HMAC(sha256, "mediary-scout-strm-signing-secret")
    const legacy = buildPlayUrl("http://x", taskId, fileId, "a.mkv", {
      sign: true,
      ttlSeconds: 3600,
      secret: "mediary-scout-strm-signing-secret",
    });
    const legacyToken = new URL(legacy).searchParams.get("token")!;

    primeStrmSigningSecret("instance-secret-32-characters-ok!");
    const verdict = verifyStrmPlayToken({
      taskId,
      fileId,
      token: legacyToken,
      expiresAtEpochSeconds: exp,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("invalid_signature");
  });

  /**
   * Turbopack 会把 @media-track/workflow 复制进多个 server chunk，模块级变量
   * 因此变成各 chunk 独立的状态——真机上表现为「预热打印成功，但生成 .strm 时
   * 仍抛 STRM_SIGNING_SECRET_UNAVAILABLE，播放全部 500」。缓存必须挂在
   * globalThis 上才能跨 chunk 共享；这条断言钉住它是进程级而不是模块级。
   */
  it("预热值存在 globalThis 上（跨 chunk 共享，模块级变量会丢）", () => {
    primeStrmSigningSecret("global-scoped-secret-32-chars-ok!");
    const host = globalThis as Record<string, unknown>;
    expect(host["__mediary_strm_signing_secret__"]).toBe("global-scoped-secret-32-chars-ok!");
    _resetStrmSigningSecretForTests();
    expect(host["__mediary_strm_signing_secret__"]).toBeNull();
  });

  it("两个不同实例的 secret 互不通用（换实例 = 旧 .strm 失效）", () => {
    const taskId = "strm_task_1";
    const fileId = "f1";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const urlA = buildPlayUrl("http://x", taskId, fileId, "a.mkv", {
      sign: true,
      ttlSeconds: 3600,
      secret: "instance-A-secret-32-characters!!",
    });
    const tokenA = new URL(urlA).searchParams.get("token")!;

    primeStrmSigningSecret("instance-B-secret-32-characters!!");
    expect(verifyStrmPlayToken({ taskId, fileId, token: tokenA, expiresAtEpochSeconds: exp }).valid).toBe(
      false,
    );
  });
});

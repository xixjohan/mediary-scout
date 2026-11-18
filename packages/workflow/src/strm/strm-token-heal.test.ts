import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { judgeStrmContent, parsePlayUrlTarget } from "./strm-token-heal.js";
import { buildPlayUrl, verifyStrmPlayToken } from "./strm-writer.js";
import { _resetStrmSigningSecretForTests, primeStrmSigningSecret } from "./signing-secret.js";

/**
 * `.strm` 内容自愈判定（2026-11-17 验收实测缺陷的回归门禁）。
 *
 * 缺陷链：签名 secret 从硬编码常量改为实例 JWT secret → 磁盘上已有 `.strm`
 * 全带旧 token → `incremental_missing`（默认模式）只「生成缺失、不碰已存在」
 * → 那些文件永久 401，重新扫描也不会修。
 *
 * 这里锁住三件事：
 *  1. 内容完好时判「unchanged」（稳态零动作，不做无谓 IO/写盘）；
 *  2. secret 轮换后判「invalid_token」并重写（自愈主路径）；
 *  3. 过期 token 判「expired_token」；指向别的 task/file 判「different_target」。
 */
describe("parsePlayUrlTarget", () => {
  it("解析 /api/strm/play/<task>/<file>，忽略 query", () => {
    expect(
      parsePlayUrlTarget("http://10.0.0.1:3000/api/strm/play/strm_task_1/f1?name=x.mkv&token=t&exp=1"),
    ).toEqual({ taskId: "strm_task_1", fileId: "f1" });
  });

  it("容忍没有 /api 前缀的相对/绝对形式", () => {
    expect(parsePlayUrlTarget("/strm/play/t/f")).toEqual({ taskId: "t", fileId: "f" });
  });

  it("不是播放 URL → null", () => {
    expect(parsePlayUrlTarget("not a url")).toBeNull();
    expect(parsePlayUrlTarget("http://host/other/path")).toBeNull();
  });
});

describe("judgeStrmContent", () => {
  const TASK = "strm_task_1";
  const FILE = "f1";
  // 用**真实当前时间**：`build()` 的 exp 由 `Date.now()` 推出，若测试断言用固定的
  // 过去时刻，「已过期」用例会被验签成「未过期」（实测踩过）。判定函数本身接受注入时钟，
  // 生产调用不注入 —— 测试也照生产口径来。
  const NOW = () => Math.floor(Date.now() / 1000);

  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ["STRM_SECRET", "APP_SECRET"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    _resetStrmSigningSecretForTests();
    primeStrmSigningSecret("instance-secret-A-32-characters!!");
  });
  afterEach(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    _resetStrmSigningSecretForTests();
  });

  const build = (opts: { ttlSeconds?: number; taskId?: string; fileId?: string; secret?: string } = {}) =>
    buildPlayUrl("http://host:3000", opts.taskId ?? TASK, opts.fileId ?? FILE, "x.mkv", {
      sign: true,
      ttlSeconds: opts.ttlSeconds ?? 3600,
      ...(opts.secret === undefined ? {} : { secret: opts.secret }),
    });

  it("内容与期望完全一致 → unchanged（稳态零动作）", () => {
    const url = build();
    expect(
      judgeStrmContent({ content: url, taskId: TASK, fileId: FILE, expectedPlayUrl: url, nowEpochSeconds: NOW() }),
    ).toEqual({ kind: "unchanged" });
  });

  it("secret 轮换后（旧 token 验签失败）→ rewrite invalid_token（自愈主路径）", () => {
    // 用旧 secret 签一张，再换实例 secret，模拟「历史文件 + 新部署」。
    const stale = build({ secret: "old-instance-secret-32-characters!" });
    primeStrmSigningSecret("new-instance-secret-32-characters!");
    const expected = build();
    expect(stale).not.toBe(expected);
    expect(
      judgeStrmContent({ content: stale, taskId: TASK, fileId: FILE, expectedPlayUrl: expected, nowEpochSeconds: NOW() }),
    ).toEqual({ kind: "rewrite", reason: "invalid_token" });
    // 旧 token 确实不能被新 secret 验证 —— 钉住「不是我们判定写错，而是它真的失效」。
    const token = new URL(stale).searchParams.get("token")!;
    const exp = Number(new URL(stale).searchParams.get("exp"));
    expect(verifyStrmPlayToken({ taskId: TASK, fileId: FILE, token, expiresAtEpochSeconds: exp, nowEpochSeconds: NOW() }).valid).toBe(false);
  });

  it("token 过期 → rewrite expired_token", () => {
    const expired = build({ ttlSeconds: -60 });
    const expected = build();
    expect(
      judgeStrmContent({ content: expired, taskId: TASK, fileId: FILE, expectedPlayUrl: expected, nowEpochSeconds: NOW() }),
    ).toEqual({ kind: "rewrite", reason: "expired_token" });
  });

  it("指向别的文件 → rewrite different_target", () => {
    const other = build({ fileId: "f2" });
    const expected = build();
    expect(
      judgeStrmContent({ content: other, taskId: TASK, fileId: FILE, expectedPlayUrl: expected, nowEpochSeconds: NOW() }),
    ).toEqual({ kind: "rewrite", reason: "different_target" });
  });

  it("被手改/写成非播放 URL → rewrite not_a_play_url", () => {
    expect(
      judgeStrmContent({ content: "https://example.com/x.mkv", taskId: TASK, fileId: FILE, expectedPlayUrl: build(), nowEpochSeconds: NOW() }),
    ).toEqual({ kind: "rewrite", reason: "not_a_play_url" });
  });

  it("签名有效但 URL 变形（name 变了）→ rewrite different_content", () => {
    const signedSameTarget = buildPlayUrl("http://host:3000", TASK, FILE, "old-name.mkv", { sign: true, ttlSeconds: 3600 });
    const expected = buildPlayUrl("http://host:3000", TASK, FILE, "new-name.mkv", { sign: true, ttlSeconds: 3600 });
    expect(
      judgeStrmContent({ content: signedSameTarget, taskId: TASK, fileId: FILE, expectedPlayUrl: expected, nowEpochSeconds: NOW() }),
    ).toEqual({ kind: "rewrite", reason: "different_content" });
  });

  it("缺 token/exp（旧版无签名文件）→ invalid_token", () => {
    const unsigned = buildPlayUrl("http://host:3000", TASK, FILE, "x.mkv");
    expect(
      judgeStrmContent({ content: unsigned, taskId: TASK, fileId: FILE, expectedPlayUrl: build(), nowEpochSeconds: NOW() }),
    ).toEqual({ kind: "rewrite", reason: "invalid_token" });
  });
});

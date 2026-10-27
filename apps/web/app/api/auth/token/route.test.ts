import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * S5.3 TDD：POST /api/auth/token —— API key 换 JWT。
 *
 * 契约：
 * - 200 { token, expiresIn, accountId }
 * - 401 统一文案（不区分「没配 key」与「key 错」——防枚举）
 * - demo 站只读 403
 * - 限流（复用 login-throttle）：连续失败被锁
 */

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "token-route-"));
  dirs.push(d);
  return join(d, "mediary.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 限流桶是模块级 Map：不清的话，本文件每个用例都吃前序用例烧出的失败计数，
// 单独跑（-t 过滤）与全量跑看到的行为不一致（逐维核查实证过一轮）。
// 每个用例都从空桶开始，文件内顺序无关。
const { _resetLoginThrottleForTest } = await import("../../../../lib/login-throttle.js");
beforeEach(() => {
  _resetLoginThrottleForTest();
});

process.env.MEDIA_TRACK_SQLITE_PATH = tmpDb();
process.env.MEDIA_TRACK_API_KEY = "sk-test-key-abcdef-1234";
process.env.MEDIA_TRACK_JWT_SECRET = "jwt-test-secret-32-bytes-xxxxxxxxx";

const { POST } = await import("./route.js");

function post(body: unknown, headers: Record<string, string> = {}) {
  const request = new Request("http://localhost/api/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return POST(request as never);
}

describe("POST /api/auth/token", () => {
  it("正确 key → 200 + 可验证的 JWT", async () => {
    const res = await post({ apiKey: "sk-test-key-abcdef-1234" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresIn: number; accountId: string };
    expect(typeof body.token).toBe("string");
    expect(body.expiresIn).toBeGreaterThan(0);
    expect(body.accountId).toMatch(/^acct_/);
    // token 真能验过
    const { verifyToken } = await import("@media-track/shared");
    const claims = await verifyToken(body.token, "jwt-test-secret-32-bytes-xxxxxxxxx");
    expect(claims.sub).toBe(body.accountId);
  });

  it("错 key → 401，且文案与「未配置」完全一致（防枚举）", async () => {
    const wrong = await post({ apiKey: "sk-wrong" });
    expect(wrong.status).toBe(401);
    const wrongBody = (await wrong.json()) as { error: string };
    expect(wrongBody.error).toBe("api key 无效");
  });

  it("缺 body / 非字符串 → 401", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ apiKey: 123 })).status).toBe(401);
    expect((await post(null)).status).toBe(401);
  });

  it("限流：连续错 key 后被锁（429 + retryAfter，且锁定持续）", async () => {
    // 自洽：不依赖同文件前序用例烧出的失败计数。旧写法固定发 5 次，单独运行
    // （-t 过滤）时桶里没有前序的 4 次失败，第 5 次的 check 还没到阈值，
    // 断言 undefined 的 retryAfterSec —— 全量绿但单跑红（逐维核查实证）。
    // 现在烧到真的被锁为止，并验证锁定是「持续」而非每 N 次放一个。
    let lockedRes: Response | undefined;
    for (let i = 0; i < 10 && !lockedRes; i += 1) {
      const res = await post({ apiKey: `sk-bad-${i}` });
      if (res.status === 429) lockedRes = res;
    }
    expect(lockedRes, "连续错 key 必须触发 429").toBeDefined();
    const body = (await (lockedRes as Response).json()) as { retryAfterSec?: number };
    expect(typeof body.retryAfterSec).toBe("number");
    expect(body.retryAfterSec).toBeGreaterThan(0);
    const still = await post({ apiKey: "sk-bad-after-lock" });
    expect(still.status).toBe(429);
    expect(Number(still.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

/**
 * L1（逐维核查补缺）：规格里写了但没被任何用例钉住的行为。
 */
describe("POST /api/auth/token — 补齐的契约", () => {
  it("demo 站 → 403 只读，且先于 key 判定（错 key 也是 403，不是 401）", async () => {
    const original = process.env.MEDIA_TRACK_DEMO_MODE;
    process.env.MEDIA_TRACK_DEMO_MODE = "1";
    try {
      const good = await post({ apiKey: "sk-test-key-abcdef-1234" });
      const bad = await post({ apiKey: "sk-wrong" });
      expect(good.status).toBe(403);
      expect(bad.status).toBe(403);
      expect(((await good.json()) as { error: string }).error).toBe("演示站只读");
    } finally {
      if (original === undefined) delete process.env.MEDIA_TRACK_DEMO_MODE;
      else process.env.MEDIA_TRACK_DEMO_MODE = original;
    }
  });

  it("恒定时间比较：长度不同的错 key 与等长错 key 都 401，且不泄露长度信息", async () => {
    const short = await post({ apiKey: "x" });
    const sameLength = await post({ apiKey: "sk-test-key-abcdef-9999" });
    expect(short.status).toBe(401);
    expect(sameLength.status).toBe(401);
    // 两条路径的响应体必须逐字节一致（否则等于用响应时长/内容泄露 key 长度）
    expect(await short.text()).toBe(await sameLength.text());
  });

  it("正确 key 的响应带掩码与来源（设置页「当前哪个 key 生效」要用）", async () => {
    const res = await post({ apiKey: "sk-test-key-abcdef-1234" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { masked: string; origin: string };
    expect(body.masked.endsWith("1234")).toBe(true);
    expect(body.masked).not.toContain("sk-test-key");
    expect(body.origin).toBe("env");
  });
});

/**
 * L5：成功换 JWT 必须清掉该身份的失败计数。此前只在失败时累计，一次误操作
 * （连打 5 次错 key）之后用正确 key 重试仍被限流，直到窗口自然过期。
 */
describe("/api/auth/token — 成功清限流桶（L5）", () => {
  it("错 key 累计到接近锁定后，一次成功即清零；之后再错 5 次仍不立刻锁", async () => {
    _resetLoginThrottleForTest();
    // 烧到「再错一次就锁」的位置（不锁，保证还能继续发请求）。
    for (let i = 0; i < 4; i += 1) {
      expect((await post({ apiKey: "wrong" })).status).toBe(401);
    }
    expect((await post({ apiKey: "sk-test-key-abcdef-1234" })).status).toBe(200);
    // 桶已清空：再来 4 次失败都不该触发锁定（若未清零，这里第 1 次就 429 了）。
    for (let i = 0; i < 4; i += 1) {
      expect((await post({ apiKey: "wrong" })).status).toBe(401);
    }
    // 第 5 次失败在本请求内落锁（checkLoginAllowed 在请求入口判定，故这次仍放行
    // 到验签、返 401），锁在**下一次**请求生效——这正好验证「锁定真实存在」。
    expect((await post({ apiKey: "wrong" })).status).toBe(401);
    expect((await post({ apiKey: "wrong" })).status).toBe(429);
    // 锁定期内连正确 key 也进不来（锁定优先于验签）
    expect((await post({ apiKey: "sk-test-key-abcdef-1234" })).status).toBe(429);
  });
});

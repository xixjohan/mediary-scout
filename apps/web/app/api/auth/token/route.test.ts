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

process.env.MEDIA_TRACK_SQLITE_PATH = tmpDb();
process.env.MEDIA_TRACK_API_KEY = "sk-test-key-abcdef-1234";
process.env.MEDIA_TRACK_JWT_SECRET = "jwt-test-secret-32-bytes-xxxxxxxxx";

const { POST } = await import("./route.js");
const { invalidateReleaseFeedCache: _noop } = await import("../../../lib/release-feed-server.js");
void _noop;

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

  it("限流：连续错 key 后被锁（429/401 且带 retryAfter）", async () => {
    // 前 4 次失败
    for (let i = 0; i < 4; i += 1) await post({ apiKey: `sk-bad-${i}` });
    const locked = await post({ apiKey: "sk-bad-final" });
    expect([401, 429]).toContain(locked.status);
    const body = (await locked.json()) as { retryAfterSec?: number };
    expect(typeof body.retryAfterSec).toBe("number");
  });
});

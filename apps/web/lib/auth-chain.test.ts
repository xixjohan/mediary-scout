import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { issueToken, verifyToken } from "@media-track/shared";

/**
 * S5.4 TDD（需求 #2）：/api 认证责任链。
 *
 * 通道顺序：session cookie → Bearer JWT → （单用户 + 局域网）默认账号。
 * 「局域网开放」是既有语义（resolveSingleUserAccount：LAN 免登录、远程一律
 * 需 session）——本链必须原样保留，否则桌面端/脚本/E2E 全断；JWT 是新增的
 * 第二条机器通道，与 session 并存（难点 B）。
 */

const JWT_SECRET = "chain-test-secret-32-bytes-xxxxxxxxx";

vi.mock("./workflow-runtime", () => ({
  SESSION_COOKIE_NAME: "mt_session",
  DEFAULT_ACCOUNT_ID: "acct_default",
  UNAUTHENTICATED_ACCOUNT_ID: "acct_unauthenticated",
  UnauthenticatedAccountError: class UnauthenticatedAccountError extends Error {},
  isMultiUserEnabled: vi.fn(() => false),
  isRemoteRequest: vi.fn(() => false),
  resolveSessionAccountId: vi.fn(async () => null),
  getJwtSecret: vi.fn(async () => JWT_SECRET),
  // S5.4 自审后 auth-chain 的 JWT 通道与 getCurrentAccountId 共用这一个函数
  // （真实实现见 workflow-runtime）；mock 里用同一个假 secret 复现同样语义：
  // 验签失败 → null（视同无凭据）。
  resolveBearerAccountId: async (headers?: Headers) => {
    const header = headers?.get("authorization");
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    if (token.length === 0) return null;
    try {
      const claims = await verifyToken(token, JWT_SECRET);
      return claims.sub;
    } catch {
      return null;
    }
  },
}));

import {
  isMultiUserEnabled,
  isRemoteRequest,
  resolveSessionAccountId,
} from "./workflow-runtime";
import { requireApiAccount, resolveApiAccount } from "./auth-chain";

function request(init: { cookie?: string; authorization?: string; remote?: boolean } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (init.authorization) headers.authorization = init.authorization;
  if (init.cookie) headers.cookie = `mt_session=${init.cookie}`;
  if (init.remote) headers["cf-ray"] = "test-ray";
  return new NextRequest("http://localhost/api/activity", {
    method: "GET",
    headers,
  }) as NextRequest;
}

async function bearer(claims: { sub: string }, ttlSeconds = 600): Promise<string> {
  return `Bearer ${await issueToken(claims, JWT_SECRET, ttlSeconds)}`;
}

describe("resolveApiAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isMultiUserEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (isRemoteRequest as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (resolveSessionAccountId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  it("有效 session cookie → 该账号", async () => {
    (resolveSessionAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_cookie");
    expect(await resolveApiAccount(request({ cookie: "sess_x.hmac" }))).toBe("acct_cookie");
  });

  it("无效 session + 有效 Bearer JWT → JWT 的 sub", async () => {
    const req = request({ cookie: "sess_bad.hmac", authorization: await bearer({ sub: "acct_jwt" }) });
    expect(await resolveApiAccount(req)).toBe("acct_jwt");
  });

  it("session 优先于 JWT：两者都有效时取 session", async () => {
    (resolveSessionAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_cookie");
    const req = request({ cookie: "sess_x.hmac", authorization: await bearer({ sub: "acct_jwt" }) });
    expect(await resolveApiAccount(req)).toBe("acct_cookie");
  });

  it("单用户 + 局域网 + 无凭据 → 默认账号（既有开放语义不回归）", async () => {
    expect(await resolveApiAccount(request())).toBe("acct_default");
  });

  it("单用户 + 远程（cf-ray）+ 无凭据 → null（fail-closed）", async () => {
    (isRemoteRequest as ReturnType<typeof vi.fn>).mockReturnValue(true);
    expect(await resolveApiAccount(request({ remote: true }))).toBeNull();
  });

  it("多用户 + 无凭据 → null", async () => {
    (isMultiUserEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    expect(await resolveApiAccount(request())).toBeNull();
  });

  it("多用户 + 有效 JWT → sub", async () => {
    (isMultiUserEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const req = request({ authorization: await bearer({ sub: "acct_multi" }) });
    expect(await resolveApiAccount(req)).toBe("acct_multi");
  });

  it("过期 JWT → 视同无凭据（远程 null / 局域网开放，不泄露过期信息）", async () => {
    (isRemoteRequest as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const expired = request({ authorization: await bearer({ sub: "acct_x" }, -1) });
    expect(await resolveApiAccount(expired)).toBeNull();
  });

  it("畸形 Bearer 头 → 视同无凭据", async () => {
    (isRemoteRequest as ReturnType<typeof vi.fn>).mockReturnValue(true);
    for (const authorization of ["Bearer", "Bearer ", "Basic abc", "Token xyz", "bearer"]) {
      expect(await resolveApiAccount(request({ authorization }))).toBeNull();
    }
  });

  it("错误 secret 签的 JWT → 拒绝", async () => {
    (isRemoteRequest as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const wrong = await issueToken({ sub: "acct_x" }, "another-secret-32-bytes-long-yyyy", 600);
    expect(await resolveApiAccount(request({ authorization: `Bearer ${wrong}` }))).toBeNull();
  });
});

describe("requireApiAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isMultiUserEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (isRemoteRequest as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (resolveSessionAccountId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  it("解析成功 → 返回账号 id（string）", async () => {
    expect(await requireApiAccount(request())).toBe("acct_default");
  });

  it("解析失败 → 返回 401 Response（路由 `instanceof Response` 守卫后直接 return）", async () => {
    (isMultiUserEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const gate = await requireApiAccount(request());
    expect(gate).toBeInstanceOf(Response);
    expect((gate as Response).status).toBe(401);
    expect((gate as Response).headers.get("content-type")).toContain("application/json");
    expect(await (gate as Response).json()).toEqual({ error: "未登录，请先登录后再操作。" });
  });
});

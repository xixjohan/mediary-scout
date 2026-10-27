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
    // 与真实实现同一语义：scheme 大小写无关（proxy 粗筛也是 /^bearer /i）
    const match = /^bearer (.+)$/i.exec(header ?? "");
    if (!match) return null;
    const token = match[1]!.trim();
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

  it("有效 session cookie → 该账号（多用户）", async () => {
    (isMultiUserEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (resolveSessionAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_cookie");
    expect(await resolveApiAccount(request({ cookie: "sess_x.hmac" }))).toBe("acct_cookie");
  });

  it("无效 session + 有效 Bearer JWT → JWT 的 sub", async () => {
    const req = request({ cookie: "sess_bad.hmac", authorization: await bearer({ sub: "acct_jwt" }) });
    expect(await resolveApiAccount(req)).toBe("acct_jwt");
  });

  it("session 优先于 JWT：两者都有效时取 session（多用户）", async () => {
    (isMultiUserEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
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


/**
 * M2（逐维核查发现）：契约说「永不抛异常——调用方决定 401 形态」，可 session
 * 通道裸调 resolveSessionAccountId：DB 抖动时它一抛，路由直接 500，既不是 401
 * 也不是继续走别的通道。单用户 + LAN 带 cookie 的请求会被这个异常打死
 * （本该落到局域网默认账号）。修法：读失败视同「这个通道没说话」。
 */
describe("resolveApiAccount — session 读取失败不得外抛（M2）", () => {
  it("session 库读抛错 + 单用户局域网 → 落到默认账号（不 500）", async () => {
    vi.mocked(isMultiUserEnabled).mockReturnValue(false);
    vi.mocked(isRemoteRequest).mockReturnValue(false);
    vi.mocked(resolveSessionAccountId).mockRejectedValueOnce(new Error("session store down"));
    await expect(resolveApiAccount(request({ cookie: "sess.hmac" }))).resolves.toBe("acct_default");
  });

  it("session 库读抛错 + 多用户 → null（401），不 500", async () => {
    vi.mocked(isMultiUserEnabled).mockReturnValue(true);
    vi.mocked(resolveSessionAccountId).mockRejectedValueOnce(new Error("session store down"));
    await expect(resolveApiAccount(request({ cookie: "sess.hmac" }))).resolves.toBeNull();
  });

  it("session 库读抛错 + 远程 + 无其它凭据 → null（fail-closed）", async () => {
    vi.mocked(isMultiUserEnabled).mockReturnValue(false);
    vi.mocked(isRemoteRequest).mockReturnValue(true);
    vi.mocked(resolveSessionAccountId).mockRejectedValueOnce(new Error("session store down"));
    await expect(resolveApiAccount(request({ cookie: "sess.hmac", remote: true }))).resolves.toBeNull();
  });

  it("session 读抛错但 Bearer JWT 有效 → 仍拿到 JWT 账号（通道互不拖累）", async () => {
    vi.mocked(isMultiUserEnabled).mockReturnValue(true);
    vi.mocked(resolveSessionAccountId).mockRejectedValueOnce(new Error("session store down"));
    const token = await bearer({ sub: "acct_jwt" });
    await expect(resolveApiAccount(request({ cookie: "sess.hmac", authorization: token }))).resolves.toBe(
      "acct_jwt",
    );
  });
});

/**
 * M6（逐维核查发现）：auth-chain 与 workflow-runtime.getCurrentAccountId 的既有
 * 不变量冲突——多用户时期残留的别账号 session 在**单用户模式**下会被通道 1 原样
 * 放行，而那条不变量明写单用户远程只认 acct_default（resolveSingleUserAccount
 * 会拒掉 acct_somebody_else）。闸机放行、数据作用域随后 fail-closed，等于
 * 「认证通过的陌生人」。修法：单用户模式下非默认账号的 session 直接判无效。
 */
describe("resolveApiAccount — 单用户模式的 session 裁决（M6：与 resolveSingleUserAccount 对齐）", () => {
  it("单用户 + 远程 + 别账号 session → null（401）：数据层本来就拒，闸机不能放行", async () => {
    vi.mocked(isMultiUserEnabled).mockReturnValue(false);
    vi.mocked(isRemoteRequest).mockReturnValue(true);
    vi.mocked(resolveSessionAccountId).mockResolvedValue("acct_somebody_else");
    await expect(resolveApiAccount(request({ cookie: "sess.hmac", remote: true }))).resolves.toBeNull();
  });

  it("单用户 + 远程 + 默认账号 session → 放行（与数据层一致）", async () => {
    vi.mocked(isMultiUserEnabled).mockReturnValue(false);
    vi.mocked(isRemoteRequest).mockReturnValue(true);
    vi.mocked(resolveSessionAccountId).mockResolvedValue("acct_default");
    await expect(resolveApiAccount(request({ cookie: "sess.hmac", remote: true }))).resolves.toBe("acct_default");
  });

  it("单用户 + 局域网 + 别账号 session → 默认账号（LAN 开放语义不回归）", async () => {
    vi.mocked(isMultiUserEnabled).mockReturnValue(false);
    vi.mocked(isRemoteRequest).mockReturnValue(false);
    vi.mocked(resolveSessionAccountId).mockResolvedValue("acct_somebody_else");
    await expect(resolveApiAccount(request({ cookie: "sess.hmac" }))).resolves.toBe("acct_default");
  });

  it("单用户 + 远程 + 别账号 session + 有效 JWT → JWT 通道仍然放行（不被 session 拖死）", async () => {
    vi.mocked(isMultiUserEnabled).mockReturnValue(false);
    vi.mocked(isRemoteRequest).mockReturnValue(true);
    vi.mocked(resolveSessionAccountId).mockResolvedValue("acct_somebody_else");
    const token = await bearer({ sub: "acct_jwt_owner" });
    await expect(resolveApiAccount(request({ cookie: "sess.hmac", authorization: token, remote: true }))).resolves.toBe(
      "acct_jwt_owner",
    );
  });
});

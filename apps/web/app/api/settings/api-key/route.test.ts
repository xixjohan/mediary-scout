import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { issueToken, verifyToken } from "@media-track/shared";

/**
 * S5.5 TDD：/api/settings/api-key 路由层。
 *
 *   GET    → 三态 { origin, masked, configured }
 *   POST   → 轮换，返回**一次性完整值** { apiKey, masked, origin }
 *   DELETE → 清 DB；env 态 409 且不清库
 * 全部先过 S5.4 登录链：无凭据（多用户）401、session/JWT 放行。
 */

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

const JWT_SECRET = "api-key-route-test-secret-32-bytes-xx";

const state = {
  multiUser: true,
  sessionAccount: null as string | null,
  demo: false,
  store: { value: null as string | null, calls: [] as string[] },
};

vi.mock("../../../../lib/demo-mode", () => ({ isDemoMode: () => state.demo }));

vi.mock("../../../../lib/workflow-runtime", () => ({
  SESSION_COOKIE_NAME: "mt_session",
  DEFAULT_ACCOUNT_ID: "acct_default",
  isMultiUserEnabled: () => state.multiUser,
  isRemoteRequest: (headers: Headers) => Boolean(headers.get("cf-ray")),
  resolveSessionAccountId: async () => state.sessionAccount,
  getJwtSecret: async () => JWT_SECRET,
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
  getJwtTtlSeconds: async () => 600,
  // 端口适配：SQLite app_settings（SECRET_SETTING_KEYS 透明加密）——测试里是内存。
  getWorkflowRepository: () => ({
    getSetting: async () => state.store.value,
    setSetting: async (_key: string, value: string) => {
      state.store.calls.push(`set:${value}`);
      state.store.value = value;
    },
  }),
}));

import { GET, POST, DELETE } from "./route";

function req(method: string, headers?: Record<string, string>, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/settings/api-key", {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(headers ?? {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function sessionHeaders(): Record<string, string> {
  state.sessionAccount = "acct_cookie";
  return { cookie: "mt_session=sess.hmac" };
}

async function jwtHeaders(): Promise<Record<string, string>> {
  state.sessionAccount = null;
  return { authorization: `Bearer ${await issueToken({ sub: "acct_jwt" }, JWT_SECRET, 600)}` };
}

describe("/api/settings/api-key", () => {
  beforeEach(() => {
    state.multiUser = true;
    state.sessionAccount = null;
    state.demo = false;
    state.store = { value: null, calls: [] };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("登录链（S5.4 门禁）", () => {
    it("无凭据（多用户模式）→ 401", async () => {
      for (const method of ["GET", "POST", "DELETE"]) {
        const res = await (
          method === "GET" ? GET : method === "POST" ? POST : DELETE
        )(req(method));
        expect(res.status, method).toBe(401);
        await expect(res.json()).resolves.toEqual({ error: "未登录，请先登录后再操作。" });
      }
    });

    it("有效 session cookie → 放行", async () => {
      const res = await GET(req("GET", sessionHeaders()));
      expect(res.status).toBe(200);
    });

    it("有效 Bearer JWT → 放行", async () => {
      const res = await GET(req("GET", await jwtHeaders()));
      expect(res.status).toBe(200);
    });
  });

  describe("GET 三态", () => {
    it("DB 有值 → db + 掩码", async () => {
      state.store.value = "sk-db-1234";
      const res = await GET(req("GET", sessionHeaders()));
      await expect(res.json()).resolves.toEqual({ origin: "db", masked: "••••1234", configured: true });
    });

    it("只有 env（DB 空）→ env + 掩码（UI 据此禁清除）", async () => {
      process.env.MEDIA_TRACK_API_KEY = "sk-env-secret-value-0001";
      const res = await GET(req("GET", sessionHeaders()));
      await expect(res.json()).resolves.toEqual({ origin: "env", masked: "••••0001", configured: true });
      delete process.env.MEDIA_TRACK_API_KEY;
    });

    it("DB 空 + env 也没有 → none", async () => {
      const res = await GET(req("GET", sessionHeaders()));
      await expect(res.json()).resolves.toEqual({ origin: "none", masked: null, configured: false });
    });

    it("演示站 → 403", async () => {
      state.demo = true;
      const res = await GET(req("GET", sessionHeaders()));
      expect(res.status).toBe(403);
    });
  });

  describe("POST 轮换", () => {
    it("生成新 key：返回一次性完整值 + 写入 DB", async () => {
      const res = await POST(req("POST", sessionHeaders()));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { apiKey: string; masked: string; origin: string };
      expect(body.apiKey).toMatch(/^[0-9a-f]{64}$/);
      expect(body.masked).toBe(`••••${body.apiKey.slice(-4)}`);
      expect(body.origin).toBe("db");
      expect(state.store.calls).toEqual([`set:${body.apiKey}`]);
    });

    it("接受显式值（粘贴自己的 key）", async () => {
      const res = await POST(req("POST", sessionHeaders(), { apiKey: "sk-my-own-key-7777" }));
      const body = (await res.json()) as { apiKey: string; masked: string };
      expect(body.apiKey).toBe("sk-my-own-key-7777");
      expect(body.masked).toBe("••••7777");
      expect(state.store.calls).toEqual(["set:sk-my-own-key-7777"]);
    });

    it("演示站 → 403 且不写库", async () => {
      state.demo = true;
      const res = await POST(req("POST", sessionHeaders()));
      expect(res.status).toBe(403);
      expect(state.store.calls).toEqual([]);
    });
  });

  describe("DELETE 清除", () => {
    it("DB 态 → 200 清库", async () => {
      state.store.value = "sk-db-1234";
      const res = await DELETE(req("DELETE", sessionHeaders()));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true, origin: "none", masked: null });
      expect(state.store.calls).toEqual(["set:"]);
    });

    it("未配置 → 幂等 200", async () => {
      const res = await DELETE(req("DELETE", sessionHeaders()));
      expect(res.status).toBe(200);
    });

    it("env 态 → 409 且不清库（页面改不了部署期注入的值）", async () => {
      process.env.MEDIA_TRACK_API_KEY = "sk-env-secret-value-0001";
      const res = await DELETE(req("DELETE", sessionHeaders()));
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: "当前生效的 key 来自环境变量（MEDIA_TRACK_API_KEY），页面无法撤销；请改部署配置。",
      });
      expect(state.store.calls).toEqual([]);
      delete process.env.MEDIA_TRACK_API_KEY;
    });

    it("演示站 → 403 且不清库", async () => {
      state.demo = true;
      state.store.value = "sk-db-1234";
      const res = await DELETE(req("DELETE", sessionHeaders()));
      expect(res.status).toBe(403);
      expect(state.store.value).toBe("sk-db-1234");
    });
  });
});

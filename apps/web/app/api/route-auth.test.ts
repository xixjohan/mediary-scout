import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { issueToken, verifyToken } from "@media-track/shared";

/**
 * S5.4 行为层：抽 6 个形态各异的路由，逐一验证三种凭据状态。
 *   无凭据（多用户模式）      → 401 JSON「未登录，请先登录后再操作。」
 *   有效 session cookie       → 放行（进入路由自身逻辑）
 *   有效 Bearer JWT           → 放行
 *   单用户 + 局域网 + 无凭据  → 保持既有开放语义（桌面端/脚本/E2E 不回归）
 *
 * 路由自身的重依赖（DB、上游 QR 客户端、fetch）在此全部 mock，
 * 断言只关注鉴权链的准入结果。
 */

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

const JWT_SECRET = "route-auth-test-secret-32-bytes-xxxxxx";

const state = {
  multiUser: true,
  sessionAccount: null as string | null,
  repository: {} as Record<string, unknown>,
  workspace: { accountId: "acct_default", connectedStorageId: null as string | null },
};

vi.mock("../../lib/workflow-runtime", () => ({
  SESSION_COOKIE_NAME: "mt_session",
  DEFAULT_ACCOUNT_ID: "acct_default",
  isMultiUserEnabled: () => state.multiUser,
  isRemoteRequest: (headers: Headers) => Boolean(headers.get("cf-ray")),
  resolveSessionAccountId: async () => state.sessionAccount,
  getJwtSecret: async () => JWT_SECRET,
  // S5.4 自审后 auth-chain 的 JWT 通道与 getCurrentAccountId 共用这一个函数；
  // mock 用同一个假 secret 复现真实语义（验签失败 → null = 视同无凭据）。
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
  getJwtTtlSeconds: async () => 600,
  getWorkflowRepository: () => state.repository,
  ensureDemoSeeded: async () => {},
  resolveGlobalWorkspace: async () => state.workspace,
  getCurrentAccountId: async () => state.sessionAccount ?? "acct_default",
  notificationWindowSince: () => 0,
}));

vi.mock("../../lib/demo-mode", () => ({ isDemoMode: () => false }));

vi.mock("../../lib/activity-view", () => ({ getActivityView: vi.fn(async () => ({ queue: [], running: [], completed: [] })) }));

vi.mock("../../lib/settings-attention-server", () => ({
  loadSettingsAttentionSummary: vi.fn(async () => ({ count: 0, severity: null, items: [] })),
}));

vi.mock("@media-track/workflow", async () => {
  const actual = await vi.importActual<typeof import("@media-track/workflow")>("@media-track/workflow");
  return {
    ...actual,
    Pan115QrLoginClient: class {
      pollStatus = vi.fn(async () => ({ status: "waiting" }));
    },
    Pan123QrLoginClient: class {
      getQrSession = vi.fn(async () => ({ uniID: "u1", qrcodeContent: "qr://x" }));
    },
  };
});

type Handler = (request: NextRequest) => Promise<Response>;

const CASES: Array<{
  name: string;
  load: () => Promise<never>;
  request: (headers?: Record<string, string>) => NextRequest;
  assertPassed: (res: Response) => Promise<void> | void;
}> = [
  {
    name: "GET /api/activity",
    load: () => import("./activity/route") as Promise<never>,
    request: (headers) => new NextRequest("http://localhost/api/activity", { headers: headers ?? {} }),
    assertPassed: async (res) => {
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ queue: [], running: [], completed: [] });
    },
  },
  {
    name: "GET /api/115/qrcode/status",
    load: () => import("./115/qrcode/status/route") as Promise<never>,
    request: (headers) =>
      new NextRequest("http://localhost/api/115/qrcode/status?uid=u&time=1&sign=s", { headers: headers ?? {} }),
    assertPassed: async (res) => {
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true, status: { status: "waiting" } });
    },
  },
  {
    name: "GET /api/115/qrcode/image",
    load: () => import("./115/qrcode/image/route") as Promise<never>,
    request: (headers) =>
      new NextRequest("http://localhost/api/115/qrcode/image?uid=u", { headers: headers ?? {} }),
    assertPassed: (res) => {
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
    },
  },
  {
    name: "POST /api/pan123/qrcode",
    load: () => import("./pan123/qrcode/route") as Promise<never>,
    request: (headers) =>
      new NextRequest("http://localhost/api/pan123/qrcode", { method: "POST", headers: headers ?? {} }),
    assertPassed: async (res) => {
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        ok: true,
        session: { uniID: "u1", qrcodeContent: "qr://x" },
      });
    },
  },
  {
    name: "POST /api/activity/cancel",
    load: () => import("./activity/cancel/route") as Promise<never>,
    request: (headers) =>
      new NextRequest("http://localhost/api/activity/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", ...(headers ?? {}) },
        body: JSON.stringify({ runId: "run_1" }),
      }),
    assertPassed: async (res) => {
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ status: "cancelled" });
    },
  },
  {
    name: "GET /api/settings/attention",
    load: () => import("./settings/attention/route") as Promise<never>,
    request: (headers) =>
      new NextRequest("http://localhost/api/settings/attention", { headers: headers ?? {} }),
    assertPassed: async (res) => {
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ count: 0, severity: null, items: [] });
    },
  },
];

async function call(caseItem: (typeof CASES)[number], request: NextRequest): Promise<Response> {
  vi.resetModules();
  const mod = (await caseItem.load()) as unknown as Record<string, Handler>;
  const handler = mod.GET ?? mod.POST;
  expect(typeof handler, `${caseItem.name} 导出 GET/POST`).toBe("function");
  if (!handler) throw new Error(`${caseItem.name} 未导出 GET/POST`);
  return handler(request);
}

function sessionHeaders(): Record<string, string> {
  state.sessionAccount = "acct_cookie";
  return { cookie: "mt_session=sess.hmac" };
}

async function jwtHeaders(): Promise<Record<string, string>> {
  state.sessionAccount = null;
  const token = await issueToken({ sub: "acct_jwt" }, JWT_SECRET, 600);
  return { authorization: `Bearer ${token}` };
}

describe("S5.4 路由登录认证（行为层）", () => {
  beforeEach(() => {
    state.multiUser = true;
    state.sessionAccount = null;
    state.repository = { cancelQueuedWorkflowRun: vi.fn(async () => ({ status: "cancelled" })) };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  for (const caseItem of CASES) {
    it(`${caseItem.name}：无凭据（多用户模式）→ 401 未登录`, async () => {
      const res = await call(caseItem, caseItem.request());
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/json");
      await expect(res.json()).resolves.toEqual({ error: "未登录，请先登录后再操作。" });
    });

    it(`${caseItem.name}：有效 session cookie → 放行`, async () => {
      const res = await call(caseItem, caseItem.request(sessionHeaders()));
      await caseItem.assertPassed(res);
    });

    it(`${caseItem.name}：有效 Bearer JWT → 放行`, async () => {
      const res = await call(caseItem, caseItem.request(await jwtHeaders()));
      await caseItem.assertPassed(res);
    });
  }

  it("单用户 + 局域网 + 无凭据 → 既有开放语义不回归（activity 仍 200）", async () => {
    state.multiUser = false;
    const activityCase = CASES[0];
    if (!activityCase) throw new Error("CASES[0]（activity）缺失");
    const res = await call(activityCase, activityCase.request());
    await activityCase.assertPassed(res);
  });

  it("单用户 + 远程（cf-ray）+ 无凭据 → fail-closed 401", async () => {
    state.multiUser = false;
    const activityCase = CASES[0];
    if (!activityCase) throw new Error("CASES[0]（activity）缺失");
    const headers = new Headers({ "cf-ray": "test-ray" });
    const res = await call(activityCase, activityCase.request(Object.fromEntries(headers)));
    expect(res.status).toBe(401);
  });
});

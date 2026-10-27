import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../../../../lib/demo-mode", () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock("../../../../../lib/settings-attention-server", () => ({
  dismissSettingsAttentionItem: vi.fn(async () => {}),
}));
// S5.4：dismiss 改走 lib/auth-chain 登录链，mock 需补上链路所需导出。
// 默认单用户 + 局域网 → 默认账号（既有 LAN 开放语义）；401 用例把
// multiUser 拨真即可让无凭据请求 fail-closed。
const authState = { multiUser: false };
vi.mock("../../../../../lib/workflow-runtime", () => ({
  SESSION_COOKIE_NAME: "mt_session",
  DEFAULT_ACCOUNT_ID: "acct_default",
  isMultiUserEnabled: () => authState.multiUser,
  isRemoteRequest: () => false,
  resolveSessionAccountId: async () => null,
  getJwtSecret: async () => "dismiss-test-secret",
    resolveBearerAccountId: async (headers?: Headers) => {
      const header = headers?.get("authorization");
      // 与真实实现同一语义：scheme 大小写无关（proxy 粗筛也是 /^bearer /i）
    const match = /^bearer (.+)$/i.exec(header ?? "");
    if (!match) return null;
      const token = match[1]!.trim();
      if (token.length === 0) return null;
      try {
        const claims = await verifyToken(token, "dismiss-test-secret");
        return claims.sub;
      } catch {
        return null;
      }
    },
}));

import { isDemoMode } from "../../../../../lib/demo-mode";
import { dismissSettingsAttentionItem } from "../../../../../lib/settings-attention-server";
import { POST } from "./route";
import { verifyToken } from "@media-track/shared";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/settings/attention/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/settings/attention/dismiss", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.multiUser = false;
    (isDemoMode as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it("records a valid dismissal for the authenticated account", async () => {
    const res = await post({ id: "frozen:cs1" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(dismissSettingsAttentionItem).toHaveBeenCalledWith("acct_default", "frozen:cs1");
  });

  it("rejects unknown/garbage ids with 400 (bounded write surface)", async () => {
    for (const id of ["", "update_available", "../x", "frozen:", 42, undefined]) {
      const res = await post({ id });
      expect(res.status).toBe(400);
    }
    expect(dismissSettingsAttentionItem).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated (multi-user instance, no credentials)", async () => {
    authState.multiUser = true;
    const res = await post({ id: "missing_llm" });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "未登录，请先登录后再操作。" });
    expect(dismissSettingsAttentionItem).not.toHaveBeenCalled();
  });

  it("403 in demo mode (read-only)", async () => {
    (isDemoMode as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const res = await post({ id: "missing_llm" });
    expect(res.status).toBe(403);
    expect(dismissSettingsAttentionItem).not.toHaveBeenCalled();
  });
});

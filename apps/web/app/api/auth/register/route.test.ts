import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const env = vi.hoisted(() => ({ allowRegistration: undefined as string | undefined }));

vi.mock("../../../../lib/demo-mode", () => ({ isDemoMode: () => false }));
vi.mock("../../../../lib/workflow-runtime", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/workflow-runtime")>(
    "../../../../lib/workflow-runtime",
  );
  return {
    isRemoteRequest: actual.isRemoteRequest,
    SESSION_COOKIE_NAME: "mt_session",
    isMultiUserEnabled: vi.fn(() => true),
    isCookieSecure: vi.fn(() => false),
    getBootstrapState: vi.fn(),
    registerAccount: vi.fn(async () => ({ ok: true, accountId: "acct_default", signedCookie: "signed" })),
  };
});

import { POST } from "./route";
import * as runtime from "../../../../lib/workflow-runtime";

const TUNNEL = { "cf-ray": "8f3-abc", "cf-connecting-ip": "203.0.113.7" };

function post(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ username: "owner", password: "correct horse" }),
  });
}

describe("POST /api/auth/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEDIA_TRACK_ALLOW_REGISTRATION = env.allowRegistration;
    if (env.allowRegistration === undefined) delete process.env.MEDIA_TRACK_ALLOW_REGISTRATION;
  });

  it("refuses to claim an unclaimed instance over the tunnel", async () => {
    // Claiming takes over the existing library and drives as the instance owner.
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({ needsClaim: true, hasExistingLibrary: true });
    const res = await POST(post(TUNNEL));
    expect(res.status).toBe(403);
    expect(runtime.registerAccount).not.toHaveBeenCalled();
  });

  it("claims from the LAN", async () => {
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({ needsClaim: true, hasExistingLibrary: true });
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(runtime.registerAccount).toHaveBeenCalled();
  });

  it("still lets family members register their own accounts over the tunnel once claimed", async () => {
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({ needsClaim: false, hasExistingLibrary: true });
    const res = await POST(post(TUNNEL));
    expect(res.status).toBe(200);
    expect(runtime.registerAccount).toHaveBeenCalled();
  });

  /**
   * 自助注册关闭（`MEDIA_TRACK_ALLOW_REGISTRATION=0`）：已认领实例上不得再新建账号，
   * 否则"关掉注册"只是藏了按钮（本项目已有反例：藏 UI 挡不住直接打接口）。
   */
  it("已认领 + 注册关闭 ⇒ 403，且不调用 registerAccount（拦在服务端，不是藏按钮）", async () => {
    env.allowRegistration = "0";
    process.env.MEDIA_TRACK_ALLOW_REGISTRATION = "0";
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({ needsClaim: false, hasExistingLibrary: true });
    try {
      const res = await POST(post());
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error?: string }).error).toContain("关闭自助注册");
      expect(runtime.registerAccount).not.toHaveBeenCalled();
    } finally {
      delete process.env.MEDIA_TRACK_ALLOW_REGISTRATION;
      env.allowRegistration = undefined;
    }
  });

  /**
   * 关闭注册**不得**连认领一起关：未认领实例上关掉它会把实例彻底锁死
   * （没有站主 → 没人能进设置页 → 没人能建第一个账号）。
   */
  it("未认领 + 注册关闭 ⇒ 仍允许认领（否则实例被永久锁死）", async () => {
    env.allowRegistration = "0";
    process.env.MEDIA_TRACK_ALLOW_REGISTRATION = "0";
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({ needsClaim: true, hasExistingLibrary: true });
    try {
      const res = await POST(post());
      expect(res.status).toBe(200);
      expect(runtime.registerAccount).toHaveBeenCalled();
    } finally {
      delete process.env.MEDIA_TRACK_ALLOW_REGISTRATION;
      env.allowRegistration = undefined;
    }
  });
});

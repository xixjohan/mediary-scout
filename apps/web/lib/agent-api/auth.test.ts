import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../workflow-runtime", () => ({  // S5.7：auth-chain 通道 3 现在 import hasLoginPassword（设了密码后
  // 局域网也要登录），漏了它会在 LAN 无凭据用例上炸。
  hasLoginPassword: vi.fn(async () => false),

  getWorkflowRepository: vi.fn(() => ({
    getSetting: vi.fn(async () => null),
  })),
}));

import { NextRequest } from "next/server";
import { agentApiGuard } from "./guard";
import { getAgentApiToken, verifyAgentApiToken } from "./auth";
import { getWorkflowRepository } from "../workflow-runtime";

/** 与 apps/web 其它测试同一构造法：cookie 必须走 headers（NextRequest 的 cookies
 *  选项不生效），这里只需要 authorization 头。 */
function request(init: { authorization?: string } = {}): NextRequest {
  const headers = new Headers();
  if (init.authorization) headers.set("authorization", init.authorization);
  return new NextRequest("http://127.0.0.1:3000/api/agent/acquire", { method: "POST", headers });
}

describe("getAgentApiToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MEDIA_TRACK_AGENT_TOKEN;
  });

  it("prefers the env token over the persisted value", async () => {
    process.env.MEDIA_TRACK_AGENT_TOKEN = "env-token";
    (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: vi.fn(async () => "db-token"),
    });
    expect(await getAgentApiToken()).toBe("env-token");
  });

  it("falls back to the persisted app_settings value when env is unset", async () => {
    (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: vi.fn(async () => "db-token"),
    });
    expect(await getAgentApiToken()).toBe("db-token");
  });

  it("returns null when neither env nor DB has a token", async () => {
    (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: vi.fn(async () => null),
    });
    expect(await getAgentApiToken()).toBeNull();
  });

  it("trims and treats whitespace-only as absent", async () => {
    process.env.MEDIA_TRACK_AGENT_TOKEN = "   ";
    (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: vi.fn(async () => "  db-token  "),
    });
    expect(await getAgentApiToken()).toBe("db-token");
  });
});

describe("verifyAgentApiToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEDIA_TRACK_AGENT_TOKEN = "secret-token-12345678";
    (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: vi.fn(async () => null),
    });
  });

  it("accepts the correct bearer token", async () => {
    expect(await verifyAgentApiToken("Bearer secret-token-12345678")).toBe(true);
  });

  it("is case-insensitive on the Bearer scheme", async () => {
    expect(await verifyAgentApiToken("bearer secret-token-12345678")).toBe(true);
  });

  it("rejects a wrong token", async () => {
    expect(await verifyAgentApiToken("Bearer wrong-token-abcdefgh")).toBe(false);
  });

  it("rejects a token of different length (no crash)", async () => {
    expect(await verifyAgentApiToken("Bearer short")).toBe(false);
  });

  it("rejects a missing header", async () => {
    expect(await verifyAgentApiToken(null)).toBe(false);
  });

  it("rejects a malformed header without Bearer scheme", async () => {
    expect(await verifyAgentApiToken("secret-token-12345678")).toBe(false);
  });

  it("returns false when no token is configured", async () => {
    delete process.env.MEDIA_TRACK_AGENT_TOKEN;
    expect(await verifyAgentApiToken("Bearer anything")).toBe(false);
  });
});

/**
 * L1（逐维核查补缺）：`agentApiGuard` 的 HTTP 形态映射没有任何用例——
 * 「未配 token → 404 而非 401」是有意的（不暴露 agent 面存在），却只活在实现里。
 */
describe("agentApiGuard 的响应映射（L1）", () => {
  beforeEach(() => {
    process.env.MEDIA_TRACK_AGENT_TOKEN = "secret-token-12345678";
    (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: vi.fn(async () => null),
    });
  });

  it("未配 token → 404（不暴露 agent 面存在性）", async () => {
    delete process.env.MEDIA_TRACK_AGENT_TOKEN;
    (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: vi.fn(async () => null),
    });
    const denied = await agentApiGuard(request());
    expect(denied?.status).toBe(404);
    expect(((await denied?.json()) as { error: string }).error).toBe("not found");
  });

  it("配了 token + 错 Bearer → 401 且带 WWW-Authenticate", async () => {
    const denied = await agentApiGuard(request({ authorization: "Bearer nope" }));
    expect(denied?.status).toBe(401);
    expect(denied?.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("配了 token + 正确 Bearer → null（放行）", async () => {
    expect(await agentApiGuard(request({ authorization: "Bearer secret-token-12345678" }))).toBeNull();
  });
});

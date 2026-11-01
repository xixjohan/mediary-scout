import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("../../../../platform/next-context/auth-chain", () => ({
  requireApiAccount: vi.fn(),
}));

vi.mock("../../../../lib/workflow-runtime", () => ({
  getWorkflowRepository: vi.fn(),
}));

import { GET } from "./route";
import * as authChain from "../../../../platform/next-context/auth-chain";
import * as runtime from "../../../../lib/workflow-runtime";

describe("GET /api/auth/me", () => {
  const mockRepo = {
    getAccountById: vi.fn(),
    listConnectedStorages: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(runtime.getWorkflowRepository).mockReturnValue(mockRepo as any);
  });

  it("returns 401 if unauthenticated", async () => {
    vi.mocked(authChain.requireApiAccount).mockResolvedValue(
      NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 }),
    );

    const req = new NextRequest("http://localhost:3000/api/auth/me");
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "UNAUTHORIZED" });
  });

  it("returns 404 if account not found in DB", async () => {
    vi.mocked(authChain.requireApiAccount).mockResolvedValue("acct_ghost");
    mockRepo.getAccountById.mockResolvedValue(null);

    const req = new NextRequest("http://localhost:3000/api/auth/me");
    const res = await GET(req);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "ACCOUNT_NOT_FOUND" });
  });

  it("returns owner profile with full permissions and storage count", async () => {
    vi.mocked(authChain.requireApiAccount).mockResolvedValue("acct_owner");
    mockRepo.getAccountById.mockResolvedValue({
      id: "acct_owner",
      username: "admin_master",
      isOwner: true,
      createdAt: "2026-10-30T10:00:00.000Z",
    });
    mockRepo.listConnectedStorages.mockResolvedValue([
      { id: "cs_1", provider: "pan115" },
      { id: "cs_2", provider: "quark" },
    ]);

    const req = new NextRequest("http://localhost:3000/api/auth/me");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user).toEqual({
      id: "acct_owner",
      username: "admin_master",
      isOwner: true,
      role: {
        id: "role_owner",
        name: "站长 (Owner)",
        level: 10,
      },
      permissions: ["*"],
      storageCount: 2,
      createdAt: "2026-10-30T10:00:00.000Z",
    });
    expect(res.headers.get("cache-control")).toBe("no-store, private");
  });

  it("returns member profile with scoped permissions", async () => {
    vi.mocked(authChain.requireApiAccount).mockResolvedValue("acct_member1");
    mockRepo.getAccountById.mockResolvedValue({
      id: "acct_member1",
      username: "family_user",
      isOwner: false,
      createdAt: "2026-10-31T12:00:00.000Z",
    });
    mockRepo.listConnectedStorages.mockResolvedValue([]);

    const req = new NextRequest("http://localhost:3000/api/auth/me");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.isOwner).toBe(false);
    expect(body.user.role.id).toBe("role_member");
    expect(body.user.role.level).toBe(40);
    expect(body.user.storageCount).toBe(0);
    expect(body.user.permissions).toContain("media:search");
    expect(body.user.permissions).not.toContain("*");
  });
});

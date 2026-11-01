import { describe, expect, it, vi, beforeEach } from "vitest";
import { GET as getAvailablePermissions } from "./route";
import { NextRequest } from "next/server";
import { resetRuntimeContainerForTests } from "../../../../../composition/runtime-container";
import { BUILTIN_ROLES } from "@media-track/shared";

vi.mock("../../../../../lib/demo-mode", () => ({
  isDemoMode: () => false,
}));

let mockIsOwner = false;
vi.mock("../../../../../lib/settings-attention-server", () => ({
  resolveCurrentIsOwner: async () => mockIsOwner,
}));

let mockAccountId = "acct_member";
vi.mock("../../../../../lib/auth-chain", () => ({
  requireApiAccount: async () => mockAccountId,
}));

const mockGetUserPermissions = vi.fn();
vi.mock("../../../../../composition/runtime-container", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getUserManagementService: () => ({
      getUserPermissions: (...args: unknown[]) => mockGetUserPermissions(...args),
    }),
  };
});

describe("Available Permissions API (/api/settings/api-keys/available-permissions)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOwner = false;
    mockAccountId = "acct_member";
  });

  it("marks all leaves isAllowed=true when user is owner", async () => {
    mockIsOwner = true;
    mockGetUserPermissions.mockResolvedValue(["*"]);

    const req = new NextRequest("http://localhost:3000/api/settings/api-keys/available-permissions");
    const res = await getAvailablePermissions(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isSuperUser).toBe(true);

    const allLeaves = data.catalog.flatMap((m: { leaves: Array<{ isAllowed: boolean }> }) => m.leaves);
    expect(allLeaves.every((l: { isAllowed: boolean }) => l.isAllowed)).toBe(true);
  });

  it("marks leaves based on user permissions when user is member", async () => {
    mockIsOwner = false;
    const memberPerms = BUILTIN_ROLES.role_member.permissions; // has media:search, NOT storage:delete
    mockGetUserPermissions.mockResolvedValue(memberPerms);

    const req = new NextRequest("http://localhost:3000/api/settings/api-keys/available-permissions");
    const res = await getAvailablePermissions(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isSuperUser).toBe(false);

    const allLeaves = data.catalog.flatMap((m: { leaves: Array<{ id: string; isAllowed: boolean }> }) => m.leaves);
    const searchLeaf = allLeaves.find((l: { id: string }) => l.id === "media:search");
    const deleteLeaf = allLeaves.find((l: { id: string }) => l.id === "storage:delete");

    expect(searchLeaf?.isAllowed).toBe(true);
    expect(deleteLeaf?.isAllowed).toBe(false); // Locked!
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";
import { GET as getUsers, POST as createUser } from "./route";
import { PUT as updateUser } from "./[id]/route";
import { NextRequest } from "next/server";
import { ROLE_LEVELS } from "@media-track/shared";

vi.mock("../../../../lib/demo-mode", () => ({
  isDemoMode: () => false,
}));

let mockIsOwner = true;
vi.mock("../../../../lib/settings-attention-server", () => ({
  resolveCurrentIsOwner: async () => mockIsOwner,
}));

vi.mock("../../../../lib/auth-chain", () => ({
  requireApiAccount: async () => "acct_boss",
}));

const mockListManagedUsers = vi.fn();
const mockCreateManagedUser = vi.fn();
const mockSetUserRole = vi.fn();
const mockSetUserActive = vi.fn();
const mockResetUserPassword = vi.fn();
const mockGetUserRole = vi.fn();

vi.mock("../../../../composition/runtime-container", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getUserManagementService: () => ({
      listManagedUsers: () => mockListManagedUsers(),
      createManagedUser: (...args: unknown[]) => mockCreateManagedUser(...args),
      setUserRole: (...args: unknown[]) => mockSetUserRole(...args),
      setUserActive: (...args: unknown[]) => mockSetUserActive(...args),
      resetUserPassword: (...args: unknown[]) => mockResetUserPassword(...args),
      getUserRole: () => mockGetUserRole(),
    }),
  };
});

function makeRequest(url: string, method = "GET", body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("Users API (/api/settings/users)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOwner = true;
    mockGetUserRole.mockResolvedValue({ level: ROLE_LEVELS.OWNER });
  });

  it("lists managed users for owner", async () => {
    mockListManagedUsers.mockResolvedValue([
      { id: "acct_1", username: "boss", isOwner: true, roleId: "role_owner", roleLevel: 10 },
      { id: "acct_2", username: "alice", isOwner: false, roleId: "role_member", roleLevel: 40 },
    ]);

    const res = await getUsers(makeRequest("http://localhost:3000/api/settings/users"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].username).toBe("boss");
  });

  it("dispatches set_role action", async () => {
    mockSetUserRole.mockResolvedValue(undefined);

    const res = await updateUser(
      makeRequest("http://localhost:3000/api/settings/users/acct_2", "PUT", {
        action: "set_role",
        roleId: "role_admin",
      }),
      { params: Promise.resolve({ id: "acct_2" }) }
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(mockSetUserRole).toHaveBeenCalledWith("acct_boss", "acct_2", "role_admin");
  });

  it("dispatches set_active action", async () => {
    mockSetUserActive.mockResolvedValue(undefined);

    const res = await updateUser(
      makeRequest("http://localhost:3000/api/settings/users/acct_2", "PUT", {
        action: "set_active",
        isActive: false,
      }),
      { params: Promise.resolve({ id: "acct_2" }) }
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(mockSetUserActive).toHaveBeenCalledWith("acct_boss", "acct_2", false);
  });

  it("creates a managed user via POST", async () => {
    mockCreateManagedUser.mockResolvedValue({
      id: "acct_new",
      username: "carol",
      roleId: "role_member",
      roleName: "普通成员",
      isActive: true,
      createdAt: "2026-11-01T00:00:00.000Z",
    });

    const res = await createUser(
      makeRequest("http://localhost:3000/api/settings/users", "POST", {
        username: "carol",
        password: "SecretPassword123!",
        roleId: "role_member",
      }),
    );

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.username).toBe("carol");
    expect(mockCreateManagedUser).toHaveBeenCalledWith("acct_boss", {
      username: "carol",
      password: "SecretPassword123!",
      roleId: "role_member",
    });
  });

  it("rejects POST with missing username or password", async () => {
    const res = await createUser(
      makeRequest("http://localhost:3000/api/settings/users", "POST", {
        username: "",
      }),
    );

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("必须提供");
  });
});

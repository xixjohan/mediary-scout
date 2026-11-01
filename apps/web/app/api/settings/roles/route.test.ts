import { describe, expect, it, vi, beforeEach } from "vitest";
import { GET as getRoles, POST as createRole } from "./route";
import { GET as getRoleById, PUT as updateRole, DELETE as deleteRole } from "./[id]/route";
import { NextRequest } from "next/server";
import {
  resetRuntimeContainerForTests,
  getRoleStore,
} from "../../../../composition/runtime-container";
import { InMemoryWorkflowRepository } from "@media-track/workflow";

// Mock isDemoMode
vi.mock("../../../../lib/demo-mode", () => ({
  isDemoMode: () => false,
}));

// Mock resolveCurrentIsOwner
let mockIsOwner = true;
vi.mock("../../../../lib/settings-attention-server", () => ({
  resolveCurrentIsOwner: async () => mockIsOwner,
}));

// Mock requireApiAccount
vi.mock("../../../../lib/auth-chain", () => ({
  requireApiAccount: async () => "acct_owner",
}));

function makeRequest(url: string, method = "GET", body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("Roles API (/api/settings/roles)", () => {
  let repo: InMemoryWorkflowRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeContainerForTests();
    repo = new InMemoryWorkflowRepository();
    mockIsOwner = true;
  });

  it("lists all roles including system roles", async () => {
    const res = await getRoles(makeRequest("http://localhost:3000/api/settings/roles"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((r: { id: string }) => r.id === "role_owner")).toBe(true);
    expect(data.some((r: { id: string }) => r.id === "role_member")).toBe(true);
  });

  it("creates custom role when owner", async () => {
    const res = await createRole(
      makeRequest("http://localhost:3000/api/settings/roles", "POST", {
        name: "剪辑师角色",
        description: "影视剪辑工作者",
        permissions: ["media:search", "storage:list"],
      })
    );

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id.startsWith("role_")).toBe(true);
    expect(data.name).toBe("剪辑师角色");
    expect(data.permissions).toEqual(["media:search", "storage:list"]);

    // Fetch by ID
    const getRes = await getRoleById(
      makeRequest(`http://localhost:3000/api/settings/roles/${data.id}`),
      { params: Promise.resolve({ id: data.id }) }
    );
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.name).toBe("剪辑师角色");
  });

  it("updates role permissions", async () => {
    const store = getRoleStore();
    const role = await store.createRole({
      name: "临时角色",
      permissions: ["media:search"],
    });

    const updateRes = await updateRole(
      makeRequest(`http://localhost:3000/api/settings/roles/${role.id}`, "PUT", {
        permissions: ["media:search", "storage:list", "storage:transfer"],
      }),
      { params: Promise.resolve({ id: role.id }) }
    );

    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.permissions).toContain("storage:transfer");
  });

  it("prevents deleting system roles", async () => {
    const delRes = await deleteRole(
      makeRequest("http://localhost:3000/api/settings/roles/role_member", "DELETE"),
      { params: Promise.resolve({ id: "role_member" }) }
    );

    expect(delRes.status).toBe(400);
    const data = await delRes.json();
    expect(data.error).toContain("内置系统角色");
  });
});

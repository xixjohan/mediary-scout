import { describe, expect, it, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { NextRequest } from "next/server";
import { resetRuntimeContainerForTests } from "../../../composition/runtime-container";

// Mock auth-chain
const mockSecurityContext = vi.fn();
vi.mock("../../../platform/next-context/auth-chain", () => ({
  resolveSecurityContext: () => mockSecurityContext(),
}));

// Mock execute functions
vi.mock("../../../features/assistant/application/chat-agent-service", () => ({
  executeSearchMedia: vi.fn(async (q: string) => ({ reply: `Searched for ${q}` })),
  executeQueryStatus: vi.fn(async () => ({ reply: "No runs active" })),
  executeQueryLibrary: vi.fn(async () => ({ reply: "Tracking 2 shows" })),
}));

vi.mock("../../../features/assistant/core/chat-discover", () => ({
  executeDiscoverMedia: vi.fn(async () => ({ reply: "Discovered 5 movies" })),
}));

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3000/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("MCP Server Route (/api/mcp)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeContainerForTests();
  });

  it("returns 401 when unauthenticated", async () => {
    mockSecurityContext.mockResolvedValue(null);
    const res = await POST(makeRequest({ jsonrpc: "2.0", method: "initialize", id: 1 }));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.code).toBe(-32001);
  });

  it("handles initialize successfully", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_test",
      isMaster: true,
      roleId: "role_owner",
      permissions: new Set(["*"]),
    });

    const res = await POST(makeRequest({ jsonrpc: "2.0", method: "initialize", id: "req_1" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.serverInfo.name).toBe("mediary-scout-mcp");
    expect(data.result.capabilities.tools).toBeDefined();
  });

  it("projects all tools when caller has full permissions (*)", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_test",
      isMaster: true,
      roleId: "role_owner",
      permissions: new Set(["*"]),
    });

    const res = await POST(makeRequest({ jsonrpc: "2.0", method: "tools/list", id: 2 }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.tools).toHaveLength(4);
    const names = data.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("searchMedia");
    expect(names).toContain("discoverMedia");
    expect(names).toContain("queryStatus");
    expect(names).toContain("queryLibrary");
  });

  it("dynamically projects tools when caller only has media:search", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_guest",
      isMaster: false,
      roleId: "role_guest",
      permissions: new Set(["media:search"]), // only searchMedia!
    });

    const res = await POST(makeRequest({ jsonrpc: "2.0", method: "tools/list", id: 3 }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.tools).toHaveLength(1);
    expect(data.result.tools[0].name).toBe("searchMedia");
  });

  it("allows tools/call when caller possesses required permission", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_member",
      isMaster: false,
      roleId: "role_member",
      permissions: new Set(["media:search"]),
    });

    const res = await POST(
      makeRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 4,
        params: { name: "searchMedia", arguments: { query: "Inception" } },
      })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.content[0].text).toContain("Searched for Inception");
  });

  it("rejects tools/call when caller lacks required permission (forbidden)", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_restricted",
      isMaster: false,
      roleId: "role_guest",
      permissions: new Set(["media:search"]), // does NOT have workflow:status
    });

    const res = await POST(
      makeRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 5,
        params: { name: "queryStatus", arguments: {} },
      })
    );

    expect(res.status).toBe(200); // JSON-RPC standard error response
    const data = await res.json();
    expect(data.error.code).toBe(-32003);
    expect(data.error.message).toContain("Forbidden");
  });
});

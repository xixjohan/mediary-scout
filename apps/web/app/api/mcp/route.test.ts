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

const mockFileManager = {
  listDirectory: vi.fn().mockResolvedValue({
    files: [{ id: "f1", name: "Inception.2010.mkv", size: 1024 }],
  }),
};

vi.mock("../../../lib/workflow-runtime", () => ({
  getAccountDriveFileManager: vi.fn().mockImplementation(async () => mockFileManager),
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
    expect(data.result.tools).toHaveLength(9);
    const names = data.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("searchMedia");
    expect(names).toContain("discoverMedia");
    expect(names).toContain("queryStatus");
    expect(names).toContain("queryLibrary");
    expect(names).toContain("subscribeMedia");
    expect(names).toContain("listStorageFiles");
    expect(names).toContain("submitOfflineTask");
    expect(names).toContain("triggerAcquisition");
    expect(names).toContain("getSystemHealth");
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

  it("dynamically projects storage tools when caller only has storage:list", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_storage",
      isMaster: false,
      roleId: "role_member",
      permissions: new Set(["storage:list"]),
    });

    const res = await POST(makeRequest({ jsonrpc: "2.0", method: "tools/list", id: 31 }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.tools).toHaveLength(1);
    expect(data.result.tools[0].name).toBe("listStorageFiles");
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

  it("executes subscribeMedia when caller has media:subscribe", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_member",
      isMaster: false,
      roleId: "role_member",
      permissions: new Set(["media:subscribe"]),
    });

    const res = await POST(
      makeRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 41,
        params: { name: "subscribeMedia", arguments: { tmdbId: 157336, type: "movie" } },
      })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.content[0].text).toContain("已为 TMDB ID: 157336 建立追更订阅与自动入库策略");
  });

  it("executes submitOfflineTask when caller has storage:transfer", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_member",
      isMaster: false,
      roleId: "role_member",
      permissions: new Set(["storage:transfer"]),
    });

    const res = await POST(
      makeRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 42,
        params: {
          name: "submitOfflineTask",
          arguments: { urls: ["magnet:?xt=urn:btih:abc123456789"] },
        },
      })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.content[0].text).toContain("成功向云盘提交 1 条离线转存任务");
  });

  it("executes getSystemHealth when caller has system:health", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_member",
      isMaster: false,
      roleId: "role_member",
      permissions: new Set(["system:health"]),
    });

    const res = await POST(
      makeRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 43,
        params: { name: "getSystemHealth", arguments: {} },
      })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.content[0].text).toContain("healthy");
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

  it("rejects request with 403 when API key has allowMcp: false", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_test",
      isMaster: false,
      roleId: "role_member",
      permissions: new Set(["*"]),
      apiKeyId: "key_api_only",
      allowApi: true,
      allowMcp: false,
    });

    const res = await POST(
      makeRequest({
        jsonrpc: "2.0",
        method: "initialize",
        id: 99,
      })
    );

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe(-32003);
    expect(data.error.message).toContain("未开放 MCP 协议访问通道");
  });

  it("executes discoverMedia when caller has media:detail", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_member",
      isMaster: false,
      roleId: "role_member",
      permissions: new Set(["media:detail"]),
    });

    const res = await POST(
      makeRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 44,
        params: { name: "discoverMedia", arguments: { genre: "action", type: "movie" } },
      })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.content[0].text).toContain("Discovered 5 movies");
  });

  it("executes queryStatus when caller has workflow:status", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_member",
      isMaster: false,
      roleId: "role_member",
      permissions: new Set(["workflow:status"]),
    });

    const res = await POST(
      makeRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 45,
        params: { name: "queryStatus", arguments: {} },
      })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.content[0].text).toContain("No runs active");
  });

  it("executes queryLibrary when caller has media:detail", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_member",
      isMaster: false,
      roleId: "role_member",
      permissions: new Set(["media:detail"]),
    });

    const res = await POST(
      makeRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 46,
        params: { name: "queryLibrary", arguments: {} },
      })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.content[0].text).toContain("Tracking 2 shows");
  });

  it("executes listStorageFiles when caller has storage:list", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_member",
      isMaster: false,
      roleId: "role_member",
      permissions: new Set(["storage:list"]),
    });

    const res = await POST(
      makeRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 47,
        params: { name: "listStorageFiles", arguments: { path: "/movies" } },
      })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.content[0].text).toContain("Inception.2010.mkv");
  });

  it("executes triggerAcquisition when caller has workflow:trigger", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_member",
      isMaster: false,
      roleId: "role_member",
      permissions: new Set(["workflow:trigger"]),
    });

    const res = await POST(
      makeRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 48,
        params: { name: "triggerAcquisition", arguments: { tmdbId: 550 } },
      })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.content[0].text).toContain("已触发 TMDB ID: 550");
  });

  it("returns -32601 when calling an unregistered tool", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_admin",
      isMaster: true,
      roleId: "role_owner",
      permissions: new Set(["*"]),
    });

    const res = await POST(
      makeRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 49,
        params: { name: "nonExistentTool", arguments: {} },
      })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error.code).toBe(-32601);
    expect(data.error.message).toContain("Tool not found");
  });

  it("returns -32600 on invalid or malformed JSON-RPC request", async () => {
    mockSecurityContext.mockResolvedValue({
      accountId: "acct_admin",
      isMaster: true,
      roleId: "role_owner",
      permissions: new Set(["*"]),
    });

    const res = await POST(makeRequest({ invalid: "not-json-rpc" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe(-32600);
  });
});

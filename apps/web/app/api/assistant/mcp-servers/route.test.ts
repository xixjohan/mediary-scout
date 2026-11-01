import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as listServers, POST as createServer } from "./route";
import { POST as testServer } from "./test/route";
import {
  GET as getServer,
  PUT as updateServer,
  DELETE as deleteServer,
} from "./[id]/route";
import { POST as toggleTool } from "./[id]/toggle-tool/route";
import {
  setExternalMcpServerStoreForTest,
  resetRuntimeContainerForTests,
} from "../../../../composition/runtime-container";
import { ExternalMcpServerStore } from "@media-track/workflow";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

const state = {
  demo: false,
  owner: true,
  user: "acct_admin",
};

vi.mock("../../../../lib/demo-mode", () => ({
  isDemoMode: () => state.demo,
}));

vi.mock("../../../../lib/settings-attention-server", () => ({
  resolveCurrentIsOwner: async () => state.owner,
}));

vi.mock("../../../../lib/auth-chain", () => ({
  requireApiAccount: async () => state.user,
}));

describe("Assistant MCP Server API Routes", () => {
  let memory: Record<string, string>;
  let mockRepo: any;
  let store: ExternalMcpServerStore;

  beforeEach(() => {
    resetRuntimeContainerForTests();
    memory = {};
    mockRepo = {
      getSetting: async (k: string) => memory[k] || null,
      setSetting: async (k: string, v: string) => {
        memory[k] = v;
      },
    };
    store = new ExternalMcpServerStore(mockRepo);
    setExternalMcpServerStoreForTest(store);
    state.demo = false;
    state.owner = true;
    state.user = "acct_admin";
  });

  afterEach(() => {
    resetRuntimeContainerForTests();
  });

  it("lists empty servers initially", async () => {
    const res = await listServers(new NextRequest("http://localhost:3000/api/assistant/mcp-servers"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("validates missing endpointUrl on create", async () => {
    const res = await createServer(
      new NextRequest("http://localhost:3000/api/assistant/mcp-servers", {
        method: "POST",
        body: JSON.stringify({ name: "Incomplete" }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("creates, retrieves, toggles tool, updates, and deletes an MCP server", async () => {
    // 1. Create server
    const createRes = await createServer(
      new NextRequest("http://localhost:3000/api/assistant/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "My Weather MCP",
          endpointUrl: "http://localhost:3300/mcp",
          transport: "http",
          tools: [
            { name: "get_weather", enabled: true },
            { name: "get_forecast", enabled: false },
          ],
        }),
      })
    );
    expect(createRes.status).toBe(201);
    const server = await createRes.json();
    expect(server.name).toBe("My Weather MCP");
    const serverId = server.id;

    // 2. GET server
    const getRes = await getServer(
      new NextRequest(`http://localhost:3000/api/assistant/mcp-servers/${serverId}`),
      { params: Promise.resolve({ id: serverId }) }
    );
    expect(getRes.status).toBe(200);
    const retrieved = await getRes.json();
    expect(retrieved.id).toBe(serverId);

    // 3. Toggle tool
    const toggleRes = await toggleTool(
      new NextRequest(`http://localhost:3000/api/assistant/mcp-servers/${serverId}/toggle-tool`, {
        method: "POST",
        body: JSON.stringify({ toolName: "get_forecast", enabled: true }),
      }),
      { params: Promise.resolve({ id: serverId }) }
    );
    expect(toggleRes.status).toBe(200);
    const toggleData = await toggleRes.json();
    expect(toggleData.enabled).toBe(true);

    // 4. PUT update
    const putRes = await updateServer(
      new NextRequest(`http://localhost:3000/api/assistant/mcp-servers/${serverId}`, {
        method: "PUT",
        body: JSON.stringify({ name: "Updated Weather MCP" }),
      }),
      { params: Promise.resolve({ id: serverId }) }
    );
    expect(putRes.status).toBe(200);
    const updated = await putRes.json();
    expect(updated.name).toBe("Updated Weather MCP");

    // 5. DELETE server
    const delRes = await deleteServer(
      new NextRequest(`http://localhost:3000/api/assistant/mcp-servers/${serverId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: serverId }) }
    );
    expect(delRes.status).toBe(200);
    expect((await store.listServers()).length).toBe(0);
  });
});

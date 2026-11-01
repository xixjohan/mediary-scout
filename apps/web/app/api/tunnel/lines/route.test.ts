import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as listLinesGet, POST as createLinePost } from "./route";
import {
  GET as getLineGet,
  PUT as updateLinePut,
  DELETE as deleteLineDelete,
} from "./[id]/route";
import { POST as startLinePost } from "./[id]/start/route";
import { POST as stopLinePost } from "./[id]/stop/route";
import { GET as getLogsGet } from "./[id]/logs/route";
import {
  setFrpTunnelManagerForTest,
  resetRuntimeContainerForTests,
} from "../../../../composition/runtime-container";
import {
  FrpTunnelManager,
  InMemoryFrpTunnelStorage,
} from "@media-track/shared";

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

describe("Tunnel Lines API Routes", () => {
  let memoryStorage: InMemoryFrpTunnelStorage;
  let manager: FrpTunnelManager;

  beforeEach(() => {
    resetRuntimeContainerForTests();
    memoryStorage = new InMemoryFrpTunnelStorage();
    manager = new FrpTunnelManager(memoryStorage);
    setFrpTunnelManagerForTest(manager);
    state.demo = false;
    state.owner = true;
    state.user = "acct_admin";
  });

  afterEach(() => {
    resetRuntimeContainerForTests();
  });

  it("lists lines (initially empty)", async () => {
    const req = new NextRequest("http://localhost:3000/api/tunnel/lines");
    const res = await listLinesGet(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  it("validates required fields on create", async () => {
    const req = new NextRequest("http://localhost:3000/api/tunnel/lines", {
      method: "POST",
      body: JSON.stringify({ name: "Incomplete" }),
    });
    const res = await createLinePost(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("缺少必填字段");
  });

  it("creates a new line successfully", async () => {
    const req = new NextRequest("http://localhost:3000/api/tunnel/lines", {
      method: "POST",
      body: JSON.stringify({
        name: "My Tunnel",
        serverUrl: "wss://cf-proxy.example.com",
        tunnelHost: "myhome.example.com",
        apiKey: "sec_123456",
        localTargetUrl: "http://127.0.0.1:3000",
      }),
    });
    const res = await createLinePost(req);
    expect(res.status).toBe(201);
    const line = await res.json();
    expect(line.name).toBe("My Tunnel");
    expect(line.serverUrl).toBe("wss://cf-proxy.example.com");
    expect(line.tunnelHost).toBe("myhome.example.com");
    expect(line.id).toBeDefined();

    // Now list lines
    const listRes = await listLinesGet(new NextRequest("http://localhost:3000/api/tunnel/lines"));
    const list = await listRes.json();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(line.id);
  });

  it("gets, updates, starts, stops, reads logs, and deletes a line", async () => {
    // 1. Setup existing line
    const lineId = "line_test_1";
    await memoryStorage.saveLine({
      id: lineId,
      name: "Original Name",
      enabled: false,
      serverUrl: "wss://tunnel.example.com",
      tunnelHost: "lan.example.com",
      apiKey: "key_secret",
      localTargetUrl: "http://127.0.0.1:3000",
      createdAt: 1000,
      updatedAt: 1000,
    });

    // 2. GET line
    const getRes = await getLineGet(
      new NextRequest(`http://localhost:3000/api/tunnel/lines/${lineId}`),
      { params: Promise.resolve({ id: lineId }) }
    );
    expect(getRes.status).toBe(200);
    const getData = await getRes.json();
    expect(getData.line.name).toBe("Original Name");
    expect(getData.status.state).toBe("Disconnected");

    // 3. PUT update
    const putRes = await updateLinePut(
      new NextRequest(`http://localhost:3000/api/tunnel/lines/${lineId}`, {
        method: "PUT",
        body: JSON.stringify({ name: "Updated Name" }),
      }),
      { params: Promise.resolve({ id: lineId }) }
    );
    expect(putRes.status).toBe(200);
    const updated = await putRes.json();
    expect(updated.name).toBe("Updated Name");

    // 4. Start line
    const startRes = await startLinePost(
      new NextRequest(`http://localhost:3000/api/tunnel/lines/${lineId}/start`, { method: "POST" }),
      { params: Promise.resolve({ id: lineId }) }
    );
    expect(startRes.status).toBe(200);
    const startData = await startRes.json();
    expect(startData.ok).toBe(true);

    // 5. Read logs
    const logsRes = await getLogsGet(
      new NextRequest(`http://localhost:3000/api/tunnel/lines/${lineId}/logs`),
      { params: Promise.resolve({ id: lineId }) }
    );
    expect(logsRes.status).toBe(200);
    const logsData = await logsRes.json();
    expect(logsData.id).toBe(lineId);
    expect(Array.isArray(logsData.logs)).toBe(true);

    // 6. Stop line
    const stopRes = await stopLinePost(
      new NextRequest(`http://localhost:3000/api/tunnel/lines/${lineId}/stop`, { method: "POST" }),
      { params: Promise.resolve({ id: lineId }) }
    );
    expect(stopRes.status).toBe(200);
    const stopData = await stopRes.json();
    expect(stopData.ok).toBe(true);
    expect(stopData.status.state).toBe("Stopped");

    // 7. DELETE line
    const delRes = await deleteLineDelete(
      new NextRequest(`http://localhost:3000/api/tunnel/lines/${lineId}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: lineId }) }
    );
    expect(delRes.status).toBe(200);
    expect((await memoryStorage.listLines()).length).toBe(0);
  });
});

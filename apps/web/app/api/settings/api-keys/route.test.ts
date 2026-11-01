import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getCatalog } from "./catalog/route";
import { GET as listKeys, POST as createKey } from "./route";
import { GET as getKey, DELETE as deleteKey } from "./[id]/route";
import { POST as revokeKey } from "./[id]/revoke/route";
import {
  setApiKeyV2StoreForTest,
  resetRuntimeContainerForTests,
} from "../../../../composition/runtime-container";
import { ApiKeyV2Store } from "@media-track/workflow";

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

describe("API Keys V2 Management API Routes", () => {
  let inMemoryStore: Record<string, string>;
  let mockRepo: any;
  let keyStore: ApiKeyV2Store;

  beforeEach(() => {
    resetRuntimeContainerForTests();
    inMemoryStore = {};
    mockRepo = {
      getSetting: async (k: string) => inMemoryStore[k] || null,
      setSetting: async (k: string, v: string) => {
        inMemoryStore[k] = v;
      },
    };
    keyStore = new ApiKeyV2Store(mockRepo);
    setApiKeyV2StoreForTest(keyStore);
    state.demo = false;
    state.owner = true;
    state.user = "acct_admin";
  });

  afterEach(() => {
    resetRuntimeContainerForTests();
  });

  it("fetches permission catalog", async () => {
    const res = await getCatalog(new NextRequest("http://localhost:3000/api/settings/api-keys/catalog"));
    expect(res.status).toBe(200);
    const catalog = await res.json();
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.find((c: any) => c.id === "media")).toBeDefined();
  });

  it("lists empty keys initially", async () => {
    const res = await listKeys(new NextRequest("http://localhost:3000/api/settings/api-keys"));
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list).toEqual([]);
  });

  it("validates missing name when creating key", async () => {
    const res = await createKey(
      new NextRequest("http://localhost:3000/api/settings/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: "   " }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("creates, retrieves, revokes and deletes an API key", async () => {
    // 1. Create key
    const createRes = await createKey(
      new NextRequest("http://localhost:3000/api/settings/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: "HomeAssistant Key",
          permissions: ["media:search", "media:detail"],
        }),
      })
    );
    expect(createRes.status).toBe(201);
    const createData = await createRes.json();
    expect(createData.plainTextKey.startsWith("msk_live_")).toBe(true);
    expect(createData.entity.name).toBe("HomeAssistant Key");
    expect(createData.entity.permissions).toEqual(["media:search", "media:detail"]);
    const keyId = createData.entity.id;

    // 2. GET key
    const getRes = await getKey(
      new NextRequest(`http://localhost:3000/api/settings/api-keys/${keyId}`),
      { params: Promise.resolve({ id: keyId }) }
    );
    expect(getRes.status).toBe(200);
    const retrieved = await getRes.json();
    expect(retrieved.id).toBe(keyId);
    expect(retrieved.keyHash).toBeUndefined(); // Sensitive hash stripped

    // 3. Revoke key
    const revokeRes = await revokeKey(
      new NextRequest(`http://localhost:3000/api/settings/api-keys/${keyId}/revoke`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: keyId }) }
    );
    expect(revokeRes.status).toBe(200);
    const revokedData = await revokeRes.json();
    expect(revokedData.revoked).toBe(true);

    // 4. Delete key
    const deleteRes = await deleteKey(
      new NextRequest(`http://localhost:3000/api/settings/api-keys/${keyId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: keyId }) }
    );
    expect(deleteRes.status).toBe(200);
    expect((await keyStore.listKeys()).length).toBe(0);
  });

  it("rejects non-owner member creating a key with permissions outside their role", async () => {
    state.owner = false;
    state.user = "acct_guest";

    const res = await createKey(
      new NextRequest("http://localhost:3000/api/settings/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: "Escalated Key",
          permissions: ["media:search", "storage:delete"],
        }),
      })
    );

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("权限越界");
  });
});

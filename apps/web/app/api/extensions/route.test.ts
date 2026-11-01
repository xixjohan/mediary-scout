import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as listExts, POST as createExt } from "./route";
import { GET as getExt, DELETE as deleteExt } from "./[id]/route";
import { GET as getCode, POST as saveCode } from "./[id]/code/route";
import { GET as getSnapshots, POST as rollbackSnapshot } from "./[id]/snapshots/route";
import { POST as debugRun } from "./[id]/debug-run/route";
import {
  setExtensionManagerForTest,
  resetRuntimeContainerForTests,
} from "../../../composition/runtime-container";
import { ExtensionManager } from "@media-track/workflow";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

const state = {
  demo: false,
  owner: true,
  user: "acct_admin",
};

vi.mock("../../../lib/demo-mode", () => ({
  isDemoMode: () => state.demo,
}));

vi.mock("../../../lib/settings-attention-server", () => ({
  resolveCurrentIsOwner: async () => state.owner,
}));

vi.mock("../../../lib/auth-chain", () => ({
  requireApiAccount: async () => state.user,
}));

describe("Dynamic Extensions API Routes", () => {
  let tempDir: string;
  let manager: ExtensionManager;

  beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `api_ext_test_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    resetRuntimeContainerForTests();
    manager = new ExtensionManager(tempDir);
    setExtensionManagerForTest(manager);
    state.demo = false;
    state.owner = true;
    state.user = "acct_admin";
  });

  it("lists empty extensions initially and validates creation parameters", async () => {
    const listRes = await listExts(new NextRequest("http://localhost:3000/api/extensions"));
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual([]);

    const badRes = await createExt(
      new NextRequest("http://localhost:3000/api/extensions", {
        method: "POST",
        body: JSON.stringify({ id: "" }),
      })
    );
    expect(badRes.status).toBe(400);
  });

  it("creates, reads/edits code, snapshots, debug-runs, and deletes an extension", async () => {
    // 1. Create scaffolding
    const createRes = await createExt(
      new NextRequest("http://localhost:3000/api/extensions", {
        method: "POST",
        body: JSON.stringify({ id: "my_custom_provider", name: "My Custom Provider" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.manifest.id).toBe("my_custom_provider");

    // 2. GET extension
    const getRes = await getExt(
      new NextRequest("http://localhost:3000/api/extensions/my_custom_provider"),
      { params: Promise.resolve({ id: "my_custom_provider" }) }
    );
    expect(getRes.status).toBe(200);

    // 3. Read Code
    const readCodeRes = await getCode(
      new NextRequest("http://localhost:3000/api/extensions/my_custom_provider/code?file=index.js"),
      { params: Promise.resolve({ id: "my_custom_provider" }) }
    );
    expect(readCodeRes.status).toBe(200);
    const codeData = await readCodeRes.json();
    expect(codeData.content).toContain("My Custom Provider");

    // 4. Save updated code
    const updatedCode = `
module.exports = {
  search({ keyword }) {
    return {
      candidates: [
        { title: "API Result: " + keyword, type: "pan115", source: "Custom" }
      ]
    };
  }
};
`;
    const saveRes = await saveCode(
      new NextRequest("http://localhost:3000/api/extensions/my_custom_provider/code", {
        method: "POST",
        body: JSON.stringify({ file: "index.js", content: updatedCode }),
      }),
      { params: Promise.resolve({ id: "my_custom_provider" }) }
    );
    expect(saveRes.status).toBe(200);
    const saveData = await saveRes.json();
    expect(saveData.snapshotId).toBeDefined();

    // 5. List snapshots & rollback
    const snapRes = await getSnapshots(
      new NextRequest("http://localhost:3000/api/extensions/my_custom_provider/snapshots?file=index.js"),
      { params: Promise.resolve({ id: "my_custom_provider" }) }
    );
    expect(snapRes.status).toBe(200);
    const snapData = await snapRes.json();
    expect(snapData.snapshots.length).toBe(1);

    // 6. Debug run in fork sandbox
    const debugRes = await debugRun(
      new NextRequest("http://localhost:3000/api/extensions/my_custom_provider/debug-run", {
        method: "POST",
        body: JSON.stringify({ keyword: "Blade Runner" }),
      }),
      { params: Promise.resolve({ id: "my_custom_provider" }) }
    );
    expect(debugRes.status).toBe(200);
    const debugData = await debugRes.json();
    expect(debugData.success).toBe(true);
    expect(debugData.data.candidates[0].title).toBe("API Result: Blade Runner");

    // 7. Delete extension
    const delRes = await deleteExt(
      new NextRequest("http://localhost:3000/api/extensions/my_custom_provider", { method: "DELETE" }),
      { params: Promise.resolve({ id: "my_custom_provider" }) }
    );
    expect(delRes.status).toBe(200);
    expect((await manager.listExtensions()).length).toBe(0);
  });
});

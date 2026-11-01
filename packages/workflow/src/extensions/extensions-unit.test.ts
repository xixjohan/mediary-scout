import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeZipPath } from "./zip-extractor.js";
import { ExtensionMementoEditor } from "./memento-editor.js";
import { ForkSandboxRunner } from "./fork-sandbox-runner.js";
import { DynamicSearchProviderAdapter } from "./dynamic-search-provider.js";
import { ExtensionManager } from "./extension-manager.js";
import { createExtensionAgentTools } from "./extension-agent-tools.js";

describe("Dynamic Extension Service & Option A Fork Sandbox", () => {
  let tempBaseDir: string;

  beforeAll(async () => {
    tempBaseDir = path.join(os.tmpdir(), `mediary_ext_test_${Date.now()}`);
    await fs.mkdir(tempBaseDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("Zip Slip Defense", () => {
    it("allows valid relative paths within target directory", () => {
      const target = path.join(tempBaseDir, "my_ext");
      const safe = assertSafeZipPath(target, "index.js");
      expect(safe).toBe(path.join(target, "index.js"));

      const subSafe = assertSafeZipPath(target, "lib/utils.js");
      expect(subSafe).toBe(path.join(target, "lib", "utils.js"));
    });

    it("rejects path traversal attempts escaping the target directory", () => {
      const target = path.join(tempBaseDir, "my_ext");
      expect(() => assertSafeZipPath(target, "../../../evil.js")).toThrow(/ZipSlipDetected/);
      expect(() => assertSafeZipPath(target, "..\\..\\evil.js")).toThrow(/ZipSlipDetected/);
    });
  });

  describe("ExtensionMementoEditor", () => {
    it("saves code with automatic backup snapshot and rolls back correctly", async () => {
      const extDir = path.join(tempBaseDir, "memento_test");
      await fs.mkdir(extDir, { recursive: true });

      // 1. Initial write
      await ExtensionMementoEditor.saveCode(extDir, "index.js", "version 1");
      const content1 = await ExtensionMementoEditor.readCode(extDir, "index.js");
      expect(content1).toBe("version 1");

      // 2. Overwrite with version 2
      const saveRes = await ExtensionMementoEditor.saveCode(extDir, "index.js", "version 2");
      expect(saveRes.snapshotId).toBeDefined();

      const content2 = await ExtensionMementoEditor.readCode(extDir, "index.js");
      expect(content2).toBe("version 2");

      // 3. List snapshots
      const snapshots = await ExtensionMementoEditor.listSnapshots(extDir, "index.js");
      expect(snapshots.length).toBe(1);
      expect(snapshots[0]!.id).toBe(saveRes.snapshotId);

      // 4. Rollback to version 1
      await ExtensionMementoEditor.rollbackSnapshot(extDir, "index.js", snapshots[0]!.id);
      const rolledBack = await ExtensionMementoEditor.readCode(extDir, "index.js");
      expect(rolledBack).toBe("version 1");
    });
  });

  describe("ForkSandboxRunner (Option A Hard Isolation)", () => {
    it("executes extension code in isolated child process with scrubbed env", async () => {
      const scriptDir = path.join(tempBaseDir, "sandbox_test");
      await fs.mkdir(scriptDir, { recursive: true });
      const scriptPath = path.join(scriptDir, "index.js");

      const scriptContent = `
module.exports = {
  search({ keyword }) {
    return {
      candidates: [
        {
          title: "Isolated: " + keyword,
          type: "pan115",
          source: "TestSandbox"
        }
      ]
    };
  }
};
`;
      await fs.writeFile(scriptPath, scriptContent, "utf8");

      const result = await ForkSandboxRunner.executeMethod<{ candidates: any[] }>(
        scriptPath,
        "search",
        { keyword: "Interstellar" },
        { timeoutMs: 5000 }
      );

      expect(result.success).toBe(true);
      expect(result.data?.candidates.length).toBe(1);
      expect(result.data?.candidates[0].title).toBe("Isolated: Interstellar");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("enforces hard timeout and terminates hanging scripts with SIGKILL", async () => {
      const scriptDir = path.join(tempBaseDir, "hang_test");
      await fs.mkdir(scriptDir, { recursive: true });
      const scriptPath = path.join(scriptDir, "hang.js");

      // Simulate infinite hang
      const hangScript = `
module.exports = {
  async search() {
    return new Promise((resolve) => setTimeout(resolve, 100000));
  }
};
`;
      await fs.writeFile(scriptPath, hangScript, "utf8");

      const result = await ForkSandboxRunner.executeMethod(
        scriptPath,
        "search",
        {},
        { timeoutMs: 600 } // Short 600ms timeout for testing
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("SandboxTimeout");
    });
  });

  describe("ExtensionManager & Agent Tools", () => {
    it("creates scaffolding, adapts to ResourceProvider, and runs debug search", async () => {
      const manager = new ExtensionManager(path.join(tempBaseDir, "installed_exts"));
      const ext = await manager.createScaffolding("quark_sample", "Quark Sample Provider");
      expect(ext.manifest.id).toBe("quark_sample");

      // Adapter test
      const adapter = new DynamicSearchProviderAdapter(ext);
      const snapshot = await adapter.search({ keyword: "The Matrix" });
      expect(snapshot.keyword).toBe("The Matrix");
      expect(snapshot.candidates.length).toBe(1);
      expect(snapshot.candidates[0]!.title).toContain("The Matrix");

      // Agent Tools test
      const tools = createExtensionAgentTools(manager);
      const debugRes = await tools.extension_debug_run.execute({
        id: "quark_sample",
        keyword: "Avatar",
      });
      expect(debugRes.ok).toBe(true);
      expect(debugRes.candidates.length).toBe(1);
      expect(debugRes.candidates[0]!.title).toContain("Avatar");

      // Delete test
      const deleted = await manager.deleteExtension("quark_sample");
      expect(deleted).toBe(true);
      expect(await manager.getExtension("quark_sample")).toBeNull();
    });
  });
});

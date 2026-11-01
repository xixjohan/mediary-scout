import { describe, expect, it } from "vitest";
import {
  PERMISSION_CATALOG,
  ApiKeyPermissionPreset,
  generateApiKeyV2,
  hashApiKeyV2,
  verifyApiKeyV2Hash,
  isForbiddenApiKeyPath,
} from "./api-key-matrix.js";

describe("ApiKeyMatrix & Presets", () => {
  it("has valid module and leaf structure in catalog", () => {
    expect(PERMISSION_CATALOG.length).toBeGreaterThan(0);
    const mediaModule = PERMISSION_CATALOG.find((m) => m.id === "media");
    expect(mediaModule).toBeDefined();
    expect(mediaModule?.leaves.length).toBeGreaterThan(0);

    // Ensure all leaves have unique IDs
    const allLeafIds = PERMISSION_CATALOG.flatMap((m) => m.leaves.map((l) => l.id));
    const uniqueIds = new Set(allLeafIds);
    expect(uniqueIds.size).toBe(allLeafIds.length);
  });

  it("applies FullAccess strategy excluding Dangerous permissions", () => {
    const full = ApiKeyPermissionPreset.applyStrategy("full");
    expect(full).toContain("media:search");
    expect(full).toContain("storage:transfer");
    expect(full).not.toContain("storage:delete"); // Dangerous excluded
  });

  it("applies ReadOnly strategy", () => {
    const readOnly = ApiKeyPermissionPreset.applyStrategy("readonly");
    expect(readOnly).toContain("media:search");
    expect(readOnly).toContain("storage:list");
    expect(readOnly).not.toContain("storage:transfer"); // Execute excluded
    expect(readOnly).not.toContain("storage:delete");
  });

  it("calculates tri-state module selection accurately", () => {
    const mediaModule = PERMISSION_CATALOG.find((m) => m.id === "media")!;
    const leafIds = mediaModule.leaves.map((l) => l.id);

    // Empty -> unchecked
    expect(ApiKeyPermissionPreset.calculateModuleState(mediaModule, new Set())).toBe("unchecked");

    // All selected -> checked
    expect(ApiKeyPermissionPreset.calculateModuleState(mediaModule, new Set(leafIds))).toBe("checked");

    // Partial selected -> indeterminate
    expect(ApiKeyPermissionPreset.calculateModuleState(mediaModule, new Set([leafIds[0]!]))).toBe("indeterminate");
  });

  it("cascades module toggle correctly", () => {
    const mediaModule = PERMISSION_CATALOG.find((m) => m.id === "media")!;
    const leafIds = mediaModule.leaves.map((l) => l.id);

    // Check all
    const afterCheck = ApiKeyPermissionPreset.toggleModule(mediaModule, [], true);
    for (const id of leafIds) {
      expect(afterCheck).toContain(id);
    }

    // Uncheck all
    const afterUncheck = ApiKeyPermissionPreset.toggleModule(mediaModule, afterCheck, false);
    for (const id of leafIds) {
      expect(afterUncheck).not.toContain(id);
    }
  });

  it("projects MCP tools dynamically to save tokens and prevent hallucinations", () => {
    const mockTools = [
      { name: "search_media", desc: "Search" },
      { name: "delete_cloud_file", desc: "Delete" },
      { name: "get_system_health", desc: "Health" },
    ];
    const mapping = {
      search_media: "media:search",
      delete_cloud_file: "storage:delete",
      get_system_health: "system:health",
    };

    // Client only has media:search
    const projected = ApiKeyPermissionPreset.projectMcpTools(["media:search"], mockTools, mapping);
    expect(projected.map((t) => t.name)).toEqual(["search_media"]);

    // Wildcard has all
    const all = ApiKeyPermissionPreset.projectMcpTools(["*"], mockTools, mapping);
    expect(all.length).toBe(3);
  });

  it("generates and cryptographically verifies API keys", () => {
    const { key, keyHash, keyPrefix, maskedKey } = generateApiKeyV2();
    expect(key.startsWith("msk_live_")).toBe(true);
    expect(keyPrefix.startsWith("msk_live_")).toBe(true);
    expect(maskedKey).toContain("...");

    expect(hashApiKeyV2(key)).toBe(keyHash);
    expect(verifyApiKeyV2Hash(key, keyHash)).toBe(true);
    expect(verifyApiKeyV2Hash("msk_live_invalid", keyHash)).toBe(false);
  });

  it("correctly identifies forbidden management paths for API keys", () => {
    expect(isForbiddenApiKeyPath("/api/auth/token")).toBe(true);
    expect(isForbiddenApiKeyPath("/api/settings/api-keys")).toBe(true);
    expect(isForbiddenApiKeyPath("/api/settings/api-key")).toBe(true);
    expect(isForbiddenApiKeyPath("/api/tunnel/lines")).toBe(true);
    expect(isForbiddenApiKeyPath("/api/settings/security")).toBe(true);
    expect(isForbiddenApiKeyPath("/api/settings/password")).toBe(true);

    // Business API paths should be allowed
    expect(isForbiddenApiKeyPath("/api/titles/resources")).toBe(false);
    expect(isForbiddenApiKeyPath("/api/storage/files")).toBe(false);
    expect(isForbiddenApiKeyPath("/api/health")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  WorkspaceResolutionChain,
  resolveWorkspaceWithChain,
  MemoryWorkspacePreferenceAdapter,
  transitionWorkspaceState,
  type WorkspaceResolutionContext,
  type WorkspaceStorageSummary,
  type WorkspaceSwitcherMachineState,
} from "../../src/domain/workspace-resolution.js";
import { WorkspaceNotFoundError } from "../../src/domain/workflow-scope.js";

const mockStorages: WorkspaceStorageSummary[] = [
  { id: "cs_primary", createdAt: "2026-01-01T00:00:00.000Z", label: "主盘 115" },
  { id: "cs_secondary", createdAt: "2026-02-01T00:00:00.000Z", label: "副盘 夸克" },
  { id: "cs_tertiary", createdAt: "2026-03-01T00:00:00.000Z", label: "第三盘 天翼" },
];

describe("WorkspaceResolutionChain & Design Patterns", () => {
  it("prioritizes PathWorkspaceStrategy over query and preference (Precedence rule)", () => {
    const chain = new WorkspaceResolutionChain();
    const ctx: WorkspaceResolutionContext = {
      accountId: "acct_test",
      storages: mockStorages,
      pathStorageId: "cs_secondary",
      queryStorageId: "cs_tertiary",
      preferredStorageId: "cs_primary",
    };

    const res = chain.resolve(ctx);
    expect(res.storageId).toBe("cs_secondary");
    expect(res.source).toBe("path");
    expect(res.isPrimary).toBe(false);
    expect(res.basePath).toBe("/w/cs_secondary");
    expect(res.shouldSyncPreference).toBe(true);
  });

  it("throws WorkspaceNotFoundError when pathStorageId is not owned (Security isolation)", () => {
    const chain = new WorkspaceResolutionChain();
    const ctx: WorkspaceResolutionContext = {
      accountId: "acct_test",
      storages: mockStorages,
      pathStorageId: "cs_unowned_hacker",
    };

    expect(() => chain.resolve(ctx)).toThrow(WorkspaceNotFoundError);
  });

  it("uses QueryWorkspaceStrategy when path is absent (Global single page navigation)", () => {
    const chain = new WorkspaceResolutionChain();
    const ctx: WorkspaceResolutionContext = {
      accountId: "acct_test",
      storages: mockStorages,
      queryStorageId: "cs_tertiary",
      preferredStorageId: "cs_secondary",
    };

    const res = chain.resolve(ctx);
    expect(res.storageId).toBe("cs_tertiary");
    expect(res.source).toBe("query");
    expect(res.isPrimary).toBe(false);
    expect(res.basePath).toBe("/w/cs_tertiary");
    expect(res.shouldSyncPreference).toBe(true);
  });

  it("ignores queryStorageId if it is not owned and falls back to subsequent strategies", () => {
    const chain = new WorkspaceResolutionChain();
    const ctx: WorkspaceResolutionContext = {
      accountId: "acct_test",
      storages: mockStorages,
      queryStorageId: "cs_invalid_param",
      preferredStorageId: "cs_secondary",
    };

    const res = chain.resolve(ctx);
    expect(res.storageId).toBe("cs_secondary");
    expect(res.source).toBe("preference");
  });

  it("uses PreferenceWorkspaceStrategy when path and query are absent (Persistent memory)", () => {
    const chain = new WorkspaceResolutionChain();
    const ctx: WorkspaceResolutionContext = {
      accountId: "acct_test",
      storages: mockStorages,
      preferredStorageId: "cs_secondary",
    };

    const res = chain.resolve(ctx);
    expect(res.storageId).toBe("cs_secondary");
    expect(res.source).toBe("preference");
    expect(res.isPrimary).toBe(false);
    expect(res.basePath).toBe("/w/cs_secondary");
    expect(res.shouldSyncPreference).toBe(false);
  });

  it("self-heals ghost drive preference and falls back to PrimaryFallbackStrategy (Ghost drive defense)", () => {
    const chain = new WorkspaceResolutionChain();
    const ctx: WorkspaceResolutionContext = {
      accountId: "acct_test",
      storages: mockStorages,
      preferredStorageId: "cs_deleted_ghost",
    };

    const res = chain.resolve(ctx);
    expect(res.storageId).toBe("cs_primary");
    expect(res.source).toBe("primary");
    expect(res.isPrimary).toBe(true);
    expect(res.basePath).toBe("/");
  });

  it("bypasses preference when account has fewer than 2 drives (Single drive optimization)", () => {
    const chain = new WorkspaceResolutionChain();
    const singleDrive: WorkspaceStorageSummary[] = [
      { id: "cs_only_one", createdAt: "2026-01-01T00:00:00.000Z", label: "单盘" },
    ];
    const ctx: WorkspaceResolutionContext = {
      accountId: "acct_test",
      storages: singleDrive,
      preferredStorageId: "cs_only_one",
    };

    const res = chain.resolve(ctx);
    expect(res.storageId).toBe("cs_only_one");
    expect(res.source).toBe("primary");
  });

  it("resolves primary drive by earliest createdAt when no preferences or params exist", () => {
    const res = resolveWorkspaceWithChain({
      accountId: "acct_test",
      storages: mockStorages,
    });
    expect(res.storageId).toBe("cs_primary");
    expect(res.source).toBe("primary");
    expect(res.isPrimary).toBe(true);
    expect(res.basePath).toBe("/");
  });

  it("handles empty storage list gracefully", () => {
    const res = resolveWorkspaceWithChain({
      accountId: "acct_test",
      storages: [],
    });
    expect(res.storageId).toBe("");
    expect(res.isPrimary).toBe(true);
    expect(res.basePath).toBe("/");
  });
});

describe("Workspace Preference Adapter & State Machine", () => {
  it("MemoryWorkspacePreferenceAdapter stores, retrieves, and clears preference", async () => {
    const adapter = new MemoryWorkspacePreferenceAdapter();
    expect(await adapter.getPreference()).toBeNull();

    await adapter.setPreference("cs_custom");
    expect(await adapter.getPreference()).toBe("cs_custom");

    await adapter.clearPreference();
    expect(await adapter.getPreference()).toBeNull();
  });

  it("transitionWorkspaceState cycles through state machine transitions", () => {
    let state: WorkspaceSwitcherMachineState = { currentStorageId: "cs_primary", status: "idle" };

    state = transitionWorkspaceState(state, { type: "START_SWITCH", targetStorageId: "cs_secondary" });
    expect(state.status).toBe("validating");
    expect(state.targetStorageId).toBe("cs_secondary");

    state = transitionWorkspaceState(state, { type: "VALIDATION_SUCCESS" });
    expect(state.status).toBe("switching");
    expect(state.currentStorageId).toBe("cs_secondary");

    state = transitionWorkspaceState(state, { type: "COMPLETED" });
    expect(state.status).toBe("idle");

    // Failure transition
    state = transitionWorkspaceState(state, { type: "START_SWITCH", targetStorageId: "cs_ghost" });
    expect(state.status).toBe("validating");

    state = transitionWorkspaceState(state, { type: "VALIDATION_FAILED" });
    expect(state.status).toBe("degraded_fallback");
  });
});

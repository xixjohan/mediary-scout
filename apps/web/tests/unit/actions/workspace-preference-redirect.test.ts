import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowRepository, WORKSPACE_COOKIE_NAME } from "@media-track/workflow";
import {
  setWorkflowRepositoryForTest,
  resolvePreferredWorkspaceRedirect,
  getActiveWorkspaceScope,
} from "../../../lib/workflow-runtime";

let mockCookieValue: string | undefined = undefined;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (name === WORKSPACE_COOKIE_NAME && mockCookieValue ? { value: mockCookieValue } : undefined),
  })),
}));

describe("resolvePreferredWorkspaceRedirect & Workspace Persistence", () => {
  let repo: InMemoryWorkflowRepository;

  beforeEach(async () => {
    repo = new InMemoryWorkflowRepository();
    setWorkflowRepositoryForTest(repo);
    mockCookieValue = undefined;

    // 绑定 2 块网盘：主盘 115 与副盘 夸克
    await repo.upsertConnectedStorage({
      id: "cs_primary",
      accountId: "acct_default",
      provider: "pan115",
      providerUid: "115_uid",
      label: "115主盘",
      payload: { cookie: "test" },
      rootCid: "r1",
      moviesCid: "m1",
      tvCid: "t1",
      animeCid: "a1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await repo.upsertConnectedStorage({
      id: "cs_secondary",
      accountId: "acct_default",
      provider: "quark",
      providerUid: "quark_uid",
      label: "夸克副盘",
      payload: { cookie: "test" },
      rootCid: "r2",
      moviesCid: "m2",
      tvCid: "t2",
      animeCid: "a2",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when storageId is already specified (explicit URL route never redirects)", async () => {
    mockCookieValue = "cs_secondary";
    const target = await resolvePreferredWorkspaceRedirect("acct_default", "cs_secondary");
    expect(target).toBeNull();
  });

  it("returns null when no active workspace cookie is present", async () => {
    mockCookieValue = undefined;
    const target = await resolvePreferredWorkspaceRedirect("acct_default", undefined);
    expect(target).toBeNull();
  });

  it("returns null when cookie points to the primary drive (stays on root '/')", async () => {
    mockCookieValue = "cs_primary";
    const target = await resolvePreferredWorkspaceRedirect("acct_default", undefined);
    expect(target).toBeNull();
  });

  it("returns null when cookie points to an unowned or deleted ghost drive (self-healing)", async () => {
    mockCookieValue = "cs_ghost_deleted";
    const target = await resolvePreferredWorkspaceRedirect("acct_default", undefined);
    expect(target).toBeNull();
  });

  it("redirects to canonical secondary workspace URL when cookie points to valid secondary drive", async () => {
    mockCookieValue = "cs_secondary";
    const target = await resolvePreferredWorkspaceRedirect("acct_default", undefined);
    expect(target).toBe("/w/cs_secondary");
  });

  it("preserves searchParams when redirecting to preferred workspace", async () => {
    mockCookieValue = "cs_secondary";
    const target = await resolvePreferredWorkspaceRedirect("acct_default", undefined, {
      tab: "library",
      filter: "completed",
    });
    expect(target).toBe("/w/cs_secondary?tab=library&filter=completed");
  });

  it("returns null when account has fewer than 2 drives (single drive optimization)", async () => {
    // 删掉副盘，只留 1 块盘
    await repo.deleteConnectedStorage("acct_default", "cs_secondary");
    mockCookieValue = "cs_secondary";
    const target = await resolvePreferredWorkspaceRedirect("acct_default", undefined);
    expect(target).toBeNull();
  });

  it("getActiveWorkspaceScope resolves to preferred workspace when storageId is undefined", async () => {
    mockCookieValue = "cs_secondary";
    const scope = await getActiveWorkspaceScope(undefined);
    expect(scope.connectedStorageId).toBe("cs_secondary");
    expect(scope.basePath).toBe("/w/cs_secondary");
    expect(scope.activeStorageId).toBe("cs_secondary");
  });
});

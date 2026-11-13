/**
 * Unit tests for pan115-token-keepalive.ts
 *
 * Tests the proactive 115 Open OAuth token keep-alive mechanism that runs
 * on every background-worker tick to prevent refresh_token expiry.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import type { Pan115OpenOAuthCredentials } from "@media-track/workflow";

// ---------------------------------------------------------------------------
// Mocks — use vi.hoisted() so variables are available inside vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockEnsureValidToken,
  mockMakePan115OpenOAuthPersister,
  mockMakePan115OpenOAuthRefreshCoordinator,
  mockListConnectedStorages,
  mockFreezeConnectedStorage,
} = vi.hoisted(() => ({
  mockEnsureValidToken: vi.fn<() => Promise<string>>(),
  mockMakePan115OpenOAuthPersister: vi.fn(),
  mockMakePan115OpenOAuthRefreshCoordinator: vi.fn(),
  mockListConnectedStorages: vi.fn(),
  mockFreezeConnectedStorage: vi.fn(),
}));

vi.mock("@media-track/workflow", () => {
  class MockPan115OpenClient {
    constructor(public opts: { credentials: Pan115OpenOAuthCredentials }) {}
    getCredentials = () => this.opts.credentials;
    get hasPendingCredentialPersistence() { return false; }
    ensureValidToken = mockEnsureValidToken;
  }
  class MockPan115OpenAuthError extends Error {
    readonly code: number;
    readonly isFatal: boolean;
    constructor(code: number, message: string, isFatal = true) {
      super(`[115 Open API Error] code=${code}: ${message}`);
      this.name = "Pan115OpenAuthError";
      this.code = code;
      this.isFatal = isFatal;
    }
  }
  return {
    Pan115OpenClient: MockPan115OpenClient,
    Pan115OpenAuthError: MockPan115OpenAuthError,
  };
});

vi.mock("../features/storage-drives/application/drive-service", () => ({
  makePan115OpenOAuthPersister: mockMakePan115OpenOAuthPersister,
  makePan115OpenOAuthRefreshCoordinator: mockMakePan115OpenOAuthRefreshCoordinator,
  freezeConnectedStorage: mockFreezeConnectedStorage,
}));

vi.mock("../composition/runtime-container", () => ({
  getWorkflowRepository: () => ({ listConnectedStorages: mockListConnectedStorages }),
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------
import {
  runPan115TokenKeepAlive,
  __resetTokenKeepAliveStateForTests,
} from "./pan115-token-keepalive";
import { Pan115OpenAuthError } from "@media-track/workflow";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed epoch for reproducibility

function makeStorage(
  overrides: {
    id?: string;
    provider?: string;
    expiresAt?: number;
    hasOAuth?: boolean;
    status?: "active" | "frozen";
  } = {},
) {
  const {
    id = "storage-1",
    provider = "pan115",
    expiresAt = NOW + 10 * 60 * 1000, // 10 min from now — within 15min threshold
    hasOAuth = true,
    status = "active",
  } = overrides;

  const openOAuth: Pan115OpenOAuthCredentials | undefined = hasOAuth
    ? {
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt,
      }
    : undefined;

  return {
    id,
    provider,
    status,
    payload: hasOAuth ? { openOAuth } : {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPan115TokenKeepAlive", () => {
  beforeEach(() => {
    __resetTokenKeepAliveStateForTests();
    vi.clearAllMocks();
    vi.setSystemTime(NOW);

    // Default: listConnectedStorages returns no storages
    mockListConnectedStorages.mockResolvedValue([]);
    mockMakePan115OpenOAuthPersister.mockReturnValue(vi.fn());
    mockMakePan115OpenOAuthRefreshCoordinator.mockReturnValue(vi.fn());
    mockEnsureValidToken.mockResolvedValue("new-access-token");
    mockFreezeConnectedStorage.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Basic skip conditions
  // -------------------------------------------------------------------------

  it("returns empty result when no storages are connected", async () => {
    const result = await runPan115TokenKeepAlive("account-1");
    expect(result).toEqual({ refreshed: 0, failed: 0, fatal: 0 });
  });

  it("skips non-pan115 providers", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ provider: "quark", hasOAuth: true }),
    ]);
    const result = await runPan115TokenKeepAlive("account-1");
    expect(result.refreshed).toBe(0);
    expect(mockEnsureValidToken).not.toHaveBeenCalled();
  });

  it("skips pan115 storages without Open OAuth credentials", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ provider: "pan115", hasOAuth: false }),
    ]);
    const result = await runPan115TokenKeepAlive("account-1");
    expect(result.refreshed).toBe(0);
    expect(mockEnsureValidToken).not.toHaveBeenCalled();
  });

  it("skips tokens with more than 15 minutes remaining", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW + 16 * 60 * 1000 }), // 16 min left — above threshold
    ]);
    const result = await runPan115TokenKeepAlive("account-1");
    expect(result.refreshed).toBe(0);
    expect(mockEnsureValidToken).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Refresh triggered
  // -------------------------------------------------------------------------

  it("refreshes a token expiring within 15 minutes", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW + 10 * 60 * 1000 }), // 10 min left
    ]);
    const result = await runPan115TokenKeepAlive("account-1");
    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.fatal).toBe(0);
    expect(mockEnsureValidToken).toHaveBeenCalledOnce();
  });

  it("refreshes an already-expired token", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW - 10 * 60 * 1000 }), // expired 10 min ago
    ]);
    const result = await runPan115TokenKeepAlive("account-1");
    expect(result.refreshed).toBe(1);
  });

  it("完全跳过刷新：PAN115_OAUTH_REFRESH_DISABLED=1（多副本只留一个写者）", async () => {
    process.env.PAN115_OAUTH_REFRESH_DISABLED = "1";
    try {
      mockListConnectedStorages.mockResolvedValue([makeStorage({ expiresAt: NOW - 60_000 })]);
      const result = await runPan115TokenKeepAlive("account-1");
      expect(result).toEqual({ refreshed: 0, failed: 0, fatal: 0 });
      expect(mockEnsureValidToken).not.toHaveBeenCalled();
    } finally {
      delete process.env.PAN115_OAUTH_REFRESH_DISABLED;
    }
  });

  it("跳过已冻结的盘（需重新授权后不再空转重试）", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ status: "frozen", expiresAt: NOW - 60_000 }),
    ]);
    const result = await runPan115TokenKeepAlive("account-1");
    expect(result.refreshed).toBe(0);
    expect(mockEnsureValidToken).not.toHaveBeenCalled();
  });

  it("致命失效时把盘标记为冻结，供 UI 提示重新授权", async () => {
    const { Pan115OpenAuthError } = await import("@media-track/workflow");
    mockEnsureValidToken.mockRejectedValue(new Pan115OpenAuthError(40140137, "refresh_token 已失效"));
    mockListConnectedStorages.mockResolvedValue([makeStorage({ id: "stor-fatal" })]);

    const result = await runPan115TokenKeepAlive("account-1");

    expect(result.fatal).toBe(1);
    expect(mockFreezeConnectedStorage).toHaveBeenCalledWith(
      "stor-fatal",
      expect.stringContaining("115_OAUTH_NEEDS_REAUTH"),
    );
  });

  it("passes makeTokenPersister as onCredentialsPersist to Pan115OpenClient", async () => {
    const mockPersister = vi.fn();
    mockMakePan115OpenOAuthPersister.mockReturnValue(mockPersister);
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ id: "stor-1", provider: "pan115" }),
    ]);

    await runPan115TokenKeepAlive("acct-42");

    expect(mockMakePan115OpenOAuthPersister).toHaveBeenCalledWith("acct-42", "stor-1");
  });

  // -------------------------------------------------------------------------
  // Debounce
  // -------------------------------------------------------------------------

  it("debounces: skips the same storage refreshed < 20 minutes ago", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW + 10 * 60 * 1000 }),
    ]);

    // First run — should refresh
    await runPan115TokenKeepAlive("account-1");
    expect(mockEnsureValidToken).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW + 10 * 60 * 1000 }),
    ]);
    mockEnsureValidToken.mockResolvedValue("new-access-token-2");

    // Second run immediately — should be debounced (success sets 20-min debounce)
    const result = await runPan115TokenKeepAlive("account-1");
    expect(mockEnsureValidToken).not.toHaveBeenCalled();
    expect(result.refreshed).toBe(0);
  });

  it("debounces after transient failure (5-min cooldown)", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW + 10 * 60 * 1000 }),
    ]);
    mockEnsureValidToken.mockRejectedValue(new Error("Network timeout"));

    // First run — fails
    const result1 = await runPan115TokenKeepAlive("account-1");
    expect(result1.failed).toBe(1);
    vi.clearAllMocks();
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW + 10 * 60 * 1000 }),
    ]);
    mockEnsureValidToken.mockResolvedValue("recovered-token");

    // Second run immediately — should be in cooldown
    const result2 = await runPan115TokenKeepAlive("account-1");
    expect(mockEnsureValidToken).not.toHaveBeenCalled();
    expect(result2.failed).toBe(0);
    expect(result2.refreshed).toBe(0);
  });

  it("debounces after fatal failure (30-min cooldown)", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW + 10 * 60 * 1000 }),
    ]);
    const fatalErr = new Pan115OpenAuthError(40140120, "refresh_token invalid", true);
    mockEnsureValidToken.mockRejectedValue(fatalErr);

    // First run — fatal
    const result1 = await runPan115TokenKeepAlive("account-1");
    expect(result1.fatal).toBe(1);
    vi.clearAllMocks();
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW + 10 * 60 * 1000 }),
    ]);
    mockEnsureValidToken.mockResolvedValue("re-auth-token");

    // Second run immediately — should be in long cooldown
    const result2 = await runPan115TokenKeepAlive("account-1");
    expect(mockEnsureValidToken).not.toHaveBeenCalled();
    expect(result2.fatal).toBe(0);
  });

  it("allows re-refresh after debounce window (> 20 min)", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW + 10 * 60 * 1000 }),
    ]);

    await runPan115TokenKeepAlive("account-1");
    expect(mockEnsureValidToken).toHaveBeenCalledOnce();

    // Advance time by 21 minutes
    vi.setSystemTime(NOW + 21 * 60 * 1000);
    vi.clearAllMocks();
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW + 10 * 60 * 1000 }), // still within threshold relative to new now
    ]);
    mockEnsureValidToken.mockResolvedValue("newer-token");

    const result = await runPan115TokenKeepAlive("account-1");
    expect(mockEnsureValidToken).toHaveBeenCalledOnce();
    expect(result.refreshed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it("counts non-fatal errors as 'failed' without throwing", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW + 10 * 60 * 1000 }),
    ]);
    mockEnsureValidToken.mockRejectedValue(new Error("Network timeout"));

    const result = await runPan115TokenKeepAlive("account-1");
    expect(result.failed).toBe(1);
    expect(result.fatal).toBe(0);
    expect(result.refreshed).toBe(0);
  });

  it("counts fatal Pan115OpenAuthError as 'fatal' without throwing", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW + 10 * 60 * 1000 }),
    ]);
    const fatalErr = new Pan115OpenAuthError(40140120, "refresh_token invalid", true);
    mockEnsureValidToken.mockRejectedValue(fatalErr);

    const result = await runPan115TokenKeepAlive("account-1");
    expect(result.fatal).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.refreshed).toBe(0);
  });

  it("counts non-fatal Pan115OpenAuthError as 'failed'", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ expiresAt: NOW + 10 * 60 * 1000 }),
    ]);
    const retryableErr = new Pan115OpenAuthError(40100000, "temporary server error", false);
    mockEnsureValidToken.mockRejectedValue(retryableErr);

    const result = await runPan115TokenKeepAlive("account-1");
    expect(result.failed).toBe(1);
    expect(result.fatal).toBe(0);
  });

  it("processes multiple storages independently", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ id: "stor-A", expiresAt: NOW + 10 * 60 * 1000 }),
      makeStorage({ id: "stor-B", expiresAt: NOW + 70 * 60 * 1000 }), // above threshold
      makeStorage({ id: "stor-C", expiresAt: NOW + 5 * 60 * 1000 }),
    ]);
    mockMakePan115OpenOAuthPersister.mockReturnValue(vi.fn());

    const result = await runPan115TokenKeepAlive("account-1");
    expect(result.refreshed).toBe(2); // stor-A and stor-C
    expect(mockEnsureValidToken).toHaveBeenCalledTimes(2);
  });

  it("continues processing other storages when one fails", async () => {
    mockListConnectedStorages.mockResolvedValue([
      makeStorage({ id: "stor-A", expiresAt: NOW + 10 * 60 * 1000 }),
      makeStorage({ id: "stor-B", expiresAt: NOW + 15 * 60 * 1000 }),
    ]);
    mockEnsureValidToken
      .mockRejectedValueOnce(new Error("stor-A failed"))
      .mockResolvedValueOnce("stor-B-new-token");

    const result = await runPan115TokenKeepAlive("account-1");
    expect(result.failed).toBe(1);
    expect(result.refreshed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Resilience: DB error on listConnectedStorages
  // -------------------------------------------------------------------------

  it("returns empty result gracefully when listConnectedStorages throws", async () => {
    mockListConnectedStorages.mockRejectedValue(new Error("DB locked"));

    const result = await runPan115TokenKeepAlive("account-1");
    expect(result).toEqual({ refreshed: 0, failed: 0, fatal: 0 });
    expect(mockEnsureValidToken).not.toHaveBeenCalled();
  });
});

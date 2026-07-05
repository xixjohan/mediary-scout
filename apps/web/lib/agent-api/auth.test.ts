import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../workflow-runtime", () => ({
  getWorkflowRepository: vi.fn(() => ({
    getSetting: vi.fn(async () => null),
  })),
}));

import { getAgentApiToken, verifyAgentApiToken } from "./auth";
import { getWorkflowRepository } from "../workflow-runtime";

describe("getAgentApiToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MEDIA_TRACK_AGENT_TOKEN;
  });

  it("prefers the env token over the persisted value", async () => {
    process.env.MEDIA_TRACK_AGENT_TOKEN = "env-token";
    (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: vi.fn(async () => "db-token"),
    });
    expect(await getAgentApiToken()).toBe("env-token");
  });

  it("falls back to the persisted app_settings value when env is unset", async () => {
    (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: vi.fn(async () => "db-token"),
    });
    expect(await getAgentApiToken()).toBe("db-token");
  });

  it("returns null when neither env nor DB has a token", async () => {
    (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: vi.fn(async () => null),
    });
    expect(await getAgentApiToken()).toBeNull();
  });

  it("trims and treats whitespace-only as absent", async () => {
    process.env.MEDIA_TRACK_AGENT_TOKEN = "   ";
    (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: vi.fn(async () => "  db-token  "),
    });
    expect(await getAgentApiToken()).toBe("db-token");
  });
});

describe("verifyAgentApiToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEDIA_TRACK_AGENT_TOKEN = "secret-token-12345678";
    (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: vi.fn(async () => null),
    });
  });

  it("accepts the correct bearer token", async () => {
    expect(await verifyAgentApiToken("Bearer secret-token-12345678")).toBe(true);
  });

  it("is case-insensitive on the Bearer scheme", async () => {
    expect(await verifyAgentApiToken("bearer secret-token-12345678")).toBe(true);
  });

  it("rejects a wrong token", async () => {
    expect(await verifyAgentApiToken("Bearer wrong-token-abcdefgh")).toBe(false);
  });

  it("rejects a token of different length (no crash)", async () => {
    expect(await verifyAgentApiToken("Bearer short")).toBe(false);
  });

  it("rejects a missing header", async () => {
    expect(await verifyAgentApiToken(null)).toBe(false);
  });

  it("rejects a malformed header without Bearer scheme", async () => {
    expect(await verifyAgentApiToken("secret-token-12345678")).toBe(false);
  });

  it("returns false when no token is configured", async () => {
    delete process.env.MEDIA_TRACK_AGENT_TOKEN;
    expect(await verifyAgentApiToken("Bearer anything")).toBe(false);
  });
});

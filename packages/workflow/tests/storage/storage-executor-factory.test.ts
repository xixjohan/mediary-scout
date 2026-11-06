import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExecutorForBrand,
  QuarkStorageExecutor,
  Storage115Executor,
  STORAGE_BRANDS,
} from "../../src/index.js";
import { GuangYaStorageExecutor } from "../../src/storage/guangya-storage-executor.js";
import { Pan123StorageExecutor } from "../../src/storage/pan123-storage-executor.js";
import { TianyiStorageExecutor } from "../../src/storage/tianyi-storage-executor.js";
import * as barrel from "../../src/index.js";

describe("createExecutorForBrand", () => {
  it("pan115 → Storage115Executor (write scope from scopeCids)", () => {
    const exec = createExecutorForBrand({ provider: "pan115", cookie: "UID=1;CID=2", scopeCids: ["root"] });
    expect(exec).toBeInstanceOf(Storage115Executor);
  });

  it.each([
    ["dual_engine", "UID=1;CID=2"],
    ["open_only", ""],
  ] as const)("pan115 %s OAuth executor uses its connected-drive scope", async (engineMode, cookie) => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected network request");
    });
    vi.stubGlobal("fetch", fetchMock);

    const exec = createExecutorForBrand({
      provider: "pan115",
      cookie,
      credential: {
        engineMode,
        openOAuth: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: Date.now() + 60_000,
        },
      },
      scopeCids: ["connected-root"],
      scopeSource: "connected-storage",
      env: {},
    });

    await expect(exec.removeDirectory("connected-root")).rejects.toThrow("SAFETY_VIOLATION");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pan115 OAuth executor prefers connected-drive scope over a process-wide scope", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected network request");
    });
    vi.stubGlobal("fetch", fetchMock);

    const exec = createExecutorForBrand({
      provider: "pan115",
      cookie: "UID=1;CID=2",
      credential: {
        engineMode: "dual_engine",
        openOAuth: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: Date.now() + 60_000,
        },
      },
      scopeCids: ["connected-root"],
      scopeSource: "connected-storage",
      env: { MEDIA_TRACK_115_WRITE_SCOPE_CIDS: "other-drive-root" },
    });

    await expect(exec.removeDirectory("connected-root")).rejects.toThrow("SAFETY_VIOLATION");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["cookie_only", "UID=1;CID=2", undefined],
    ["dual_engine", "UID=1;CID=2", {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
    }],
    ["open_only", "", {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
    }],
  ] as const)("pan115 %s connected drive cannot fall back to a global scope", (engineMode, cookie, openOAuth) => {
    expect(() => createExecutorForBrand({
      provider: "pan115",
      cookie,
      credential: openOAuth === undefined ? { engineMode } : { engineMode, openOAuth },
      scopeCids: [],
      scopeSource: "connected-storage",
      env: {
        MEDIA_TRACK_115_TEST_ROOT_CID: "legacy-test-root",
        MEDIA_TRACK_115_WRITE_SCOPE_CIDS: "legacy-global-root",
      },
    })).toThrow("MEDIA_TRACK_115_WRITE_SCOPE_REQUIRED");
  });

  it("quark → QuarkStorageExecutor", () => {
    const exec = createExecutorForBrand({ provider: "quark", cookie: "__uid=1", scopeCids: ["ROOT"] });
    expect(exec).toBeInstanceOf(QuarkStorageExecutor);
  });

  it("quark → client 过令牌桶限速（P13 接线不断）", async () => {
    const { withBrandPacing } = await import("../../src/storage/brand-pacing.js");
    const spy = vi.spyOn(await import("../../src/storage/brand-pacing.js"), "withBrandPacing");
    createExecutorForBrand({ provider: "quark", cookie: "__uid=1", scopeCids: ["ROOT"] });
    expect(spy).toHaveBeenCalledWith(expect.anything(), "quark", expect.objectContaining({ clock: expect.any(Function) }));
    expect(withBrandPacing).toBeTypeOf("function");
    spy.mockRestore();
  });

  it("guangya → GuangYaStorageExecutor (from a token credential blob, no cookie)", () => {
    const exec = createExecutorForBrand({
      provider: "guangya",
      credential: { accessToken: "AT", refreshToken: "RT", deviceId: "d" },
      scopeCids: ["root"],
    });
    expect(exec).toBeInstanceOf(GuangYaStorageExecutor);
  });

  it("tianyi → TianyiStorageExecutor (from a token credential blob, no cookie)", () => {
    const exec = createExecutorForBrand({
      provider: "tianyi",
      credential: { sessionKey: "SK", accessToken: "AT", refreshToken: "RT" },
      scopeCids: ["s1"],
    });
    expect(exec).toBeInstanceOf(TianyiStorageExecutor);
  });

  it("tianyi constructs across the optional paths (familySessionKey / onCredentialRefresh present and absent)", () => {
    // exactOptionalPropertyTypes pin: the factory must not set optional client
    // options to `undefined` — both shapes must construct.
    const bare = createExecutorForBrand({
      provider: "tianyi",
      credential: { sessionKey: "SK", accessToken: "AT", refreshToken: "RT" },
      scopeCids: ["s1"],
    });
    expect(bare).toBeInstanceOf(TianyiStorageExecutor);

    const full = createExecutorForBrand({
      provider: "tianyi",
      credential: {
        sessionKey: "SK",
        accessToken: "AT",
        refreshToken: "RT",
        familySessionKey: "FSK",
      },
      scopeCids: ["s1"],
      onCredentialRefresh: () => {},
    });
    expect(full).toBeInstanceOf(TianyiStorageExecutor);
  });

  it("pan123 → Pan123StorageExecutor (from a token credential blob, no cookie)", () => {
    const exec = createExecutorForBrand({
      provider: "pan123",
      credential: { token: "TK" },
      scopeCids: ["s1"],
    });
    expect(exec).toBeInstanceOf(Pan123StorageExecutor);
  });

  it("pan123 constructs when the credential is missing or empty (token falls back to '')", () => {
    const empty = createExecutorForBrand({ provider: "pan123", credential: {}, scopeCids: ["s1"] });
    expect(empty).toBeInstanceOf(Pan123StorageExecutor);

    const absent = createExecutorForBrand({ provider: "pan123", scopeCids: ["s1"] });
    expect(absent).toBeInstanceOf(Pan123StorageExecutor);
  });

  it("barrel exports the three pan123 modules (client / qrcode login / executor)", () => {
    expect(barrel.Pan123StorageExecutor).toBe(Pan123StorageExecutor);
    expect(typeof barrel.Pan123Client).toBe("function");
    expect(typeof barrel.Pan123QrLoginClient).toBe("function");
  });

  it("barrel exports the three tianyi modules (client / qrcode login / executor)", () => {
    expect(barrel.TianyiStorageExecutor).toBe(TianyiStorageExecutor);
    expect(typeof barrel.TianyiClient).toBe("function");
    expect(typeof barrel.TianyiQrLoginClient).toBe("function");
  });

  it("unknown provider throws", () => {
    expect(() => createExecutorForBrand({ provider: "baidu", cookie: "x", scopeCids: ["y"] })).toThrowError(
      /unknown storage brand/i,
    );
  });
});

describe("STORAGE_BRANDS writeScope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A staging recovery walks down from the category dirs only on "listed" drives. A brand
  // marked "parents" whose executor really checks listings would refuse every recovery
  // write (2026-09-30 production), so the registry value is checked against the executor.
  for (const brand of STORAGE_BRANDS) {
    it(`${brand.provider} (${brand.writeScope}): the executor checks writes the way the registry says`, async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("offline (test)");
      });
      vi.stubGlobal("fetch", fetchMock);
      const executor = createExecutorForBrand({
        provider: brand.provider,
        cookie: "UID=1_A1_2;CID=2;SEID=3;__uid=1",
        credential: { token: "TK", accessToken: "AT", refreshToken: "RT", sessionKey: "SK" },
        scopeCids: ["scope-root"],
        env: {},
      });
      const error: unknown = await executor.removeDirectory("never-listed").then(
        () => null,
        (rejected: unknown) => rejected,
      );
      expect(error).not.toBeNull();
      if (brand.writeScope === "listed") {
        // Refused from what this executor has listed, without asking the drive.
        expect(String(error)).toMatch(/WRITE_SCOPE_VIOLATION/);
        expect(fetchMock).not.toHaveBeenCalled();
      } else {
        // Looked the directory up on the drive before deciding.
        expect(fetchMock).toHaveBeenCalled();
      }
    });
  }
});

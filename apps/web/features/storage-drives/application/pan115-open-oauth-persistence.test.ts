import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteWorkflowRepository,
  type Pan115OpenOAuthCredentials,
  type WorkflowRepository,
} from "@media-track/workflow";
import {
  createPan115OpenOAuthPersister,
  createPan115OpenOAuthRefreshCoordinator,
} from "./pan115-open-oauth-persistence";

const credentials: Pan115OpenOAuthCredentials = {
  accessToken: "next-access-token",
  refreshToken: "next-refresh-token",
  expiresAt: 2_000,
};

function makeRepository(result: "updated" | "already_current" | "stale" | "missing" = "updated") {
  return {
    persistPan115OpenOAuthCredentials: vi.fn().mockResolvedValue(result),
  } as unknown as Pick<WorkflowRepository, "persistPan115OpenOAuthCredentials">;
}

describe("createPan115OpenOAuthPersister", () => {
  it("delegates to the atomic repository operation", async () => {
    const repository = makeRepository();

    await createPan115OpenOAuthPersister(repository, "account-1", "storage-1")(credentials);

    expect(repository.persistPan115OpenOAuthCredentials).toHaveBeenCalledWith(
      "account-1",
      "storage-1",
      credentials,
    );
  });

  it("rejects when the storage record is missing instead of reporting persistence success", async () => {
    const repository = makeRepository("missing");

    await expect(
      createPan115OpenOAuthPersister(repository, "account-1", "storage-1")(credentials),
    ).rejects.toThrow("storage-1");
  });

  it("does not overwrite credentials that were refreshed more recently", async () => {
    const repository = makeRepository("stale");

    await expect(
      createPan115OpenOAuthPersister(repository, "account-1", "storage-1")(credentials),
    ).rejects.toThrow("newer OAuth credentials");
  });

  it("propagates database write failures to the refresh caller", async () => {
    const repository = makeRepository();
    vi.mocked(repository.persistPan115OpenOAuthCredentials).mockRejectedValue(new Error("write failed"));

    await expect(
      createPan115OpenOAuthPersister(repository, "account-1", "storage-1")(credentials),
    ).rejects.toThrow("write failed");
  });

  it("atomically updates only openOAuth while preserving the rest of the payload", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pan115-oauth-persist-"));
    const repository = createSqliteWorkflowRepository({ path: join(directory, "mediary.db") });
    try {
      await repository.upsertConnectedStorage({
        id: "storage-1",
        accountId: "account-1",
        provider: "pan115",
        providerUid: "115-user-1",
        label: "115 drive",
        payload: {
          cookie: "UID=mock; CID=mock",
          openOAuth: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1_000 },
          engineMode: "dual_engine",
          meta: { loginName: "mock-user" },
        },
        rootCid: "root",
        moviesCid: "movies",
        tvCid: "tv",
        animeCid: "anime",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      await createPan115OpenOAuthPersister(repository, "account-1", "storage-1")(credentials);
      await expect(
        createPan115OpenOAuthPersister(repository, "account-1", "storage-1")({
          accessToken: "stale-access",
          refreshToken: "stale-refresh",
          expiresAt: 1_500,
        }),
      ).rejects.toThrow("newer OAuth credentials");

      expect(await repository.getConnectedStorageById("storage-1")).toMatchObject({
        payload: {
          cookie: "UID=mock; CID=mock",
          openOAuth: credentials,
          engineMode: "dual_engine",
          meta: { loginName: "mock-user" },
        },
        rootCid: "root",
        moviesCid: "movies",
        tvCid: "tv",
        animeCid: "anime",
      });
    } finally {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("createPan115OpenOAuthRefreshCoordinator", () => {
  it("serializes refreshes across SQLite connections and lets the second caller reuse the persisted token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pan115-oauth-coordinator-"));
    const path = join(directory, "mediary.db");
    const firstRepository = createSqliteWorkflowRepository({ path });
    const secondRepository = createSqliteWorkflowRepository({ path });
    const initial = {
      accessToken: "expired-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: Date.now() - 1,
    };
    await firstRepository.upsertConnectedStorage({
      id: "storage-1",
      accountId: "account-1",
      provider: "pan115",
      providerUid: "115-user-1",
      label: "115 drive",
      payload: { openOAuth: initial },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const firstCoordinator = createPan115OpenOAuthRefreshCoordinator(firstRepository, "account-1", "storage-1");
    const secondCoordinator = createPan115OpenOAuthRefreshCoordinator(secondRepository, "account-1", "storage-1");
    const persist = createPan115OpenOAuthPersister(firstRepository, "account-1", "storage-1");
    let refreshCalls = 0;
    const refreshIfNeeded = async (current: Pan115OpenOAuthCredentials) => {
      if (current.expiresAt > Date.now() + 5 * 60_000) return current;
      refreshCalls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const next = {
        accessToken: "rotated-access-token",
        refreshToken: "rotated-refresh-token",
        expiresAt: Date.now() + 60 * 60_000,
      };
      await persist(next);
      return next;
    };

    try {
      const results = await Promise.all([
        firstCoordinator(refreshIfNeeded),
        secondCoordinator(refreshIfNeeded),
      ]);
      expect(refreshCalls).toBe(1);
      expect(results.map((result) => result.refreshToken)).toEqual([
        "rotated-refresh-token",
        "rotated-refresh-token",
      ]);
      expect(await secondRepository.listConnectedStorages("account-1")).toMatchObject([
        { payload: { openOAuth: { refreshToken: "rotated-refresh-token" } } },
      ]);
    } finally {
      firstRepository.close();
      secondRepository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

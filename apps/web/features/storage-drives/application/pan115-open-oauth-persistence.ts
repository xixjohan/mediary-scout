import { randomUUID } from "node:crypto";
import {
  Pan115OpenAuthError,
  type ConnectedStorage,
  type Pan115OpenOAuthCredentials,
  type Pan115TokenRefreshCoordinator,
  type WorkflowRepository,
} from "@media-track/workflow";

type Pan115OAuthPersisterRepository = Pick<WorkflowRepository, "persistPan115OpenOAuthCredentials">;
type Pan115OAuthStorageRepository = Pick<WorkflowRepository, "listConnectedStorages">;
type Pan115OAuthCoordinatorRepository = Pan115OAuthStorageRepository & Pick<
  WorkflowRepository,
  | "tryAcquirePan115OAuthRefreshLease"
  | "renewPan115OAuthRefreshLease"
  | "releasePan115OAuthRefreshLease"
>;

const REFRESH_LEASE_TTL_MS = 60_000;
const REFRESH_LEASE_RENEW_INTERVAL_MS = 20_000;
const REFRESH_LEASE_WAIT_TIMEOUT_MS = 5 * 60_000;

function assertCompleteCredentials(
  credentials: Pan115OpenOAuthCredentials,
  storageId: string,
): void {
  const complete =
    typeof credentials.accessToken === "string" && credentials.accessToken.trim().length > 0 &&
    typeof credentials.refreshToken === "string" && credentials.refreshToken.trim().length > 0 &&
    Number.isFinite(credentials.expiresAt);
  if (!complete) {
    throw new Error(`115 Open OAuth credentials are incomplete for storage ${storageId}`);
  }
}

async function findPan115Storage(
  repository: Pan115OAuthStorageRepository,
  accountId: string,
  storageId: string,
): Promise<ConnectedStorage> {
  const storage = (await repository.listConnectedStorages(accountId)).find(
    (row) => row.id === storageId,
  );
  if (!storage || storage.provider !== "pan115") {
    throw new Error(`115 Open OAuth storage ${storageId} is missing from account ${accountId}`);
  }
  return storage;
}

function asPayload(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Build a strict persister for rotated 115 Open OAuth credentials. */
export function createPan115OpenOAuthPersister(
  repository: Pan115OAuthPersisterRepository,
  accountId: string,
  storageId: string,
): (credentials: Pan115OpenOAuthCredentials) => Promise<void> {
  return async (credentials) => {
    assertCompleteCredentials(credentials, storageId);
    const result = await repository.persistPan115OpenOAuthCredentials(accountId, storageId, credentials);
    if (result === "missing") {
      throw new Error(`115 Open OAuth storage ${storageId} is missing from account ${accountId}`);
    }
    if (result === "stale") {
      throw new Error(`115 Open OAuth storage ${storageId} already has newer OAuth credentials`);
    }
  };
}

/** Coordinate a persisted OAuth token refresh across web and worker processes. */
export function createPan115OpenOAuthRefreshCoordinator(
  repository: Pan115OAuthCoordinatorRepository,
  accountId: string,
  storageId: string,
): Pan115TokenRefreshCoordinator {
  return async (refresh) => {
    // 多副本共用同一 115 账号时，只允许一个写者刷新：旋转会让其它副本的 refresh_token 失效。
    // 被禁用的实例必须"快速失败"，否则一次业务请求就会把生产实例打成需重新授权。
    if (process.env.PAN115_OAUTH_REFRESH_DISABLED === "1") {
      throw new Pan115OpenAuthError(
        409,
        "115 OAuth refresh is disabled on this instance (PAN115_OAUTH_REFRESH_DISABLED=1); " +
          "re-authorize on the instance that owns the refresh token",
      );
    }
    const ownerId = randomUUID();
    const waitDeadline = Date.now() + REFRESH_LEASE_WAIT_TIMEOUT_MS;
    let pollDelayMs = 50;

    while (Date.now() < waitDeadline) {
      const now = Date.now();
      const acquired = await repository.tryAcquirePan115OAuthRefreshLease(
        storageId,
        ownerId,
        now + REFRESH_LEASE_TTL_MS,
        now,
      );
      if (acquired) {
        return runRefreshUnderLease(repository, accountId, storageId, ownerId, refresh);
      }
      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
      pollDelayMs = Math.min(500, pollDelayMs * 2);
    }

    throw new Error(`Timed out waiting for 115 OAuth refresh lease for storage ${storageId}`);
  };
}

async function runRefreshUnderLease(
  repository: Pan115OAuthCoordinatorRepository,
  accountId: string,
  storageId: string,
  ownerId: string,
  refresh: (credentials: Pan115OpenOAuthCredentials) => Promise<Pan115OpenOAuthCredentials>,
): Promise<Pan115OpenOAuthCredentials> {
  let lostLease = false;
  const renewalTimer = setInterval(() => {
    const now = Date.now();
    void repository
      .renewPan115OAuthRefreshLease(storageId, ownerId, now + REFRESH_LEASE_TTL_MS, now)
      .then((renewed) => {
        if (!renewed) lostLease = true;
      })
      .catch(() => {
        lostLease = true;
      });
  }, REFRESH_LEASE_RENEW_INTERVAL_MS);

  try {
    const storage = await findPan115Storage(repository, accountId, storageId);
    const latest = asPayload(storage.payload).openOAuth as Pan115OpenOAuthCredentials | undefined;
    if (!latest) {
      throw new Error(`115 Open OAuth credentials are missing for storage ${storageId}`);
    }
    assertCompleteCredentials(latest, storageId);
    const result = await refresh({ ...latest });
    if (lostLease) {
      throw new Error(`115 Open OAuth refresh lease was lost for storage ${storageId}`);
    }
    return result;
  } finally {
    clearInterval(renewalTimer);
    await repository.releasePan115OAuthRefreshLease(storageId, ownerId);
  }
}

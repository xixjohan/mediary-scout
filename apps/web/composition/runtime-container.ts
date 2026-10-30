import {
  DEFAULT_ACCOUNT_ID,
  UNAUTHENTICATED_ACCOUNT_ID,
  UnauthenticatedAccountError,
} from "@media-track/contracts";
import {
  createSqliteWorkflowRepository,
  sqliteDbPathFromEnv,
  type ResourceProvider,
  type StorageExecutor,
  type WorkflowRepository,
} from "@media-track/workflow";

const PAN115_COOKIE_KEY = "pan115.cookie";

let repository: WorkflowRepository | null = null;
let demoSeedPromise: Promise<void> | null = null;
let fakeResourceProvider: ResourceProvider | null = null;
let fakeStorageExecutor: StorageExecutor | null = null;
let jwtSecretCache: string | null = null;
let sessionSecretCache: string | null = null;
let pan115CookieHydrated = false;
let inProcessWorkerLoop = false;
let currentAccountIdProvider: () => Promise<string> = async () => DEFAULT_ACCOUNT_ID;
const lastRecordedPanSouHealth = new Map<string, { ok: boolean; checkedAt: number }>();

export function resetRuntimeContainerForTests(): void {
  repository = null;
  demoSeedPromise = null;
  fakeResourceProvider = null;
  fakeStorageExecutor = null;
  jwtSecretCache = null;
  sessionSecretCache = null;
  pan115CookieHydrated = false;
  inProcessWorkerLoop = false;
  currentAccountIdProvider = async () => DEFAULT_ACCOUNT_ID;
  lastRecordedPanSouHealth.clear();
}

export function registerCurrentAccountIdProvider(provider: () => Promise<string>): void {
  currentAccountIdProvider = provider;
}

export async function getCurrentAccountId(): Promise<string> {
  return currentAccountIdProvider();
}

export async function requireAuthenticatedAccountId(): Promise<string> {
  const accountId = await getCurrentAccountId();
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) {
    throw new UnauthenticatedAccountError();
  }
  return accountId;
}

export function getWorkflowRepository(): WorkflowRepository {
  if (!repository) {
    repository = createSqliteWorkflowRepository({
      path: sqliteDbPathFromEnv(process.env),
    });
  }
  return repository;
}

export function setWorkflowRepositoryForTest(repo: WorkflowRepository | null): void {
  repository = repo;
}

export async function hydratePan115CookieFromDb(): Promise<void> {
  if (pan115CookieHydrated) {
    return;
  }
  pan115CookieHydrated = true;
  try {
    const cookie = await getWorkflowRepository().getSetting(PAN115_COOKIE_KEY);
    if (cookie && cookie.trim()) {
      process.env.PAN115_COOKIE = cookie.trim();
    }
  } catch (error) {
    console.error(`[media-track] failed to hydrate 115 cookie from DB: ${String(error)}`);
  }
}

export function isPan115CookieHydrated(): boolean {
  return pan115CookieHydrated;
}

export function setPan115CookieHydrated(hydrated: boolean): void {
  pan115CookieHydrated = hydrated;
}

export function getDemoSeedPromise(): Promise<void> | null {
  return demoSeedPromise;
}

export function setDemoSeedPromise(promise: Promise<void> | null): void {
  demoSeedPromise = promise;
}

export function getFakeResourceProvider(): ResourceProvider | null {
  return fakeResourceProvider;
}

export function setFakeResourceProvider(provider: ResourceProvider | null): void {
  fakeResourceProvider = provider;
}

export function getFakeStorageExecutor(): StorageExecutor | null {
  return fakeStorageExecutor;
}

export function setFakeStorageExecutor(executor: StorageExecutor | null): void {
  fakeStorageExecutor = executor;
}

export function getJwtSecretCache(): string | null {
  return jwtSecretCache;
}

export function setJwtSecretCache(secret: string | null): void {
  jwtSecretCache = secret;
}

export function getSessionSecretCache(): string | null {
  return sessionSecretCache;
}

export function setSessionSecretCache(secret: string | null): void {
  sessionSecretCache = secret;
}

export function getPanSouHealthCache(): Map<string, { ok: boolean; checkedAt: number }> {
  return lastRecordedPanSouHealth;
}

export function resetPanSouHealthCacheForTests(): void {
  lastRecordedPanSouHealth.clear();
}

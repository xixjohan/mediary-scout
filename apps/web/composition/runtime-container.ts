import path from "node:path";
import {
  DEFAULT_ACCOUNT_ID,
  UNAUTHENTICATED_ACCOUNT_ID,
  UnauthenticatedAccountError,
} from "@media-track/contracts";
import {
  FrpTunnelManager,
} from "@media-track/shared";
import {
  AppSettingTunnelStorage,
  ApiKeyV2Store,
  ExternalMcpServerStore,
  ExtensionManager,
  MediaServerCoordinator,
  SingleFlight,
  type ResolvedStream,
  createSqliteWorkflowRepository,
  sqliteDbPathFromEnv,
  type ResourceProvider,
  type StorageExecutor,
  type WorkflowRepository,
  RoleStore,
  UserManagementService,
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
let frpTunnelManager: FrpTunnelManager | null = null;
let apiKeyV2Store: ApiKeyV2Store | null = null;
let externalMcpServerStore: ExternalMcpServerStore | null = null;
let roleStore: RoleStore | null = null;
let userManagementService: UserManagementService | null = null;
let extensionManager: ExtensionManager | null = null;
let mediaServerCoordinator: MediaServerCoordinator | null = null;
let strmSingleFlight: SingleFlight<ResolvedStream> | null = null;

export function resetRuntimeContainerForTests(): void {
  if (frpTunnelManager) {
    void frpTunnelManager.stopAll();
    frpTunnelManager = null;
  }
  if (mediaServerCoordinator) {
    if (typeof mediaServerCoordinator.dispose === "function") {
      mediaServerCoordinator.dispose();
    }
    mediaServerCoordinator = null;
  }
  strmSingleFlight = null;
  apiKeyV2Store = null;
  externalMcpServerStore = null;
  roleStore = null;
  userManagementService = null;
  extensionManager = null;
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

export function getApiKeyV2Store(): ApiKeyV2Store {
  if (!apiKeyV2Store) {
    apiKeyV2Store = new ApiKeyV2Store(getWorkflowRepository());
  }
  return apiKeyV2Store;
}

export function setApiKeyV2StoreForTest(store: ApiKeyV2Store | null): void {
  apiKeyV2Store = store;
}

export function getExternalMcpServerStore(): ExternalMcpServerStore {
  if (!externalMcpServerStore) {
    externalMcpServerStore = new ExternalMcpServerStore(getWorkflowRepository());
  }
  return externalMcpServerStore;
}

export function setExternalMcpServerStoreForTest(store: ExternalMcpServerStore | null): void {
  externalMcpServerStore = store;
}

export function getRoleStore(): RoleStore {
  if (!roleStore) {
    roleStore = new RoleStore(getWorkflowRepository());
  }
  return roleStore;
}

export function setRoleStoreForTest(store: RoleStore | null): void {
  roleStore = store;
}

export function getUserManagementService(): UserManagementService {
  if (!userManagementService) {
    userManagementService = new UserManagementService(getWorkflowRepository());
  }
  return userManagementService;
}

export function setUserManagementServiceForTest(service: UserManagementService | null): void {
  userManagementService = service;
}

export function getExtensionManager(): ExtensionManager {
  if (!extensionManager) {
    const baseDir = path.resolve(process.env.MEDIA_TRACK_EXTENSIONS_DIR || "data/extensions");
    extensionManager = new ExtensionManager(baseDir);
  }
  return extensionManager;
}

export function setExtensionManagerForTest(manager: ExtensionManager | null): void {
  extensionManager = manager;
}

export function getFrpTunnelManager(): FrpTunnelManager {
  if (!frpTunnelManager) {
    const storage = new AppSettingTunnelStorage(getWorkflowRepository());
    frpTunnelManager = new FrpTunnelManager(storage);
  }
  return frpTunnelManager;
}

export function setFrpTunnelManagerForTest(manager: FrpTunnelManager | null): void {
  frpTunnelManager = manager;
}

export function getMediaServerCoordinator(): MediaServerCoordinator {
  if (!mediaServerCoordinator) {
    mediaServerCoordinator = new MediaServerCoordinator({
      store: getWorkflowRepository(),
    });
  }
  return mediaServerCoordinator;
}

export function setMediaServerCoordinatorForTest(
  coordinator: MediaServerCoordinator | null,
): void {
  mediaServerCoordinator = coordinator;
}

export function getStrmSingleFlight(): SingleFlight<ResolvedStream> {
  if (!strmSingleFlight) {
    strmSingleFlight = new SingleFlight<ResolvedStream>();
  }
  return strmSingleFlight;
}

export function setStrmSingleFlightForTest(
  singleFlight: SingleFlight<ResolvedStream> | null,
): void {
  strmSingleFlight = singleFlight;
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

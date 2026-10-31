import {
  isUpdateInProgress,
  getAccountScopedSettings,
  UpdateInProgressError,
  ensureDemoSeeded,
  runStartupMigrations,
  getJevBaseUrlOverride,
  getJevInheritedBaseUrl,
} from "../features/settings-system/application/system-settings-service";
import { runAutoUpdateIfDue } from "../features/settings-system/application/auto-update-service";
import { getWorkflowStatusView as getWorkflowStatusViewService } from "../features/activity";
import { type CandidateTrackingRequestResult, type CandidateReserveRequestResult } from "../features/acquisition/contracts/acquisition-types";
import { type ForeignWorkFinding, type ForeignWorkReview, getForeignWorkReview as getForeignWorkReviewService } from "../features/catalog/application/catalog-service";
import {
  type Pan115ConnectionStatus,
  type ConnectedStorageView,
  type AccountStorageCredentials,
  StorageOwnedByOtherAccountError,
  clearPan115GlobalMirrorForUnboundDrive,
  getPan115ConnectionStatus,
  getAccountConnectedStorages as getAccountConnectedStoragesService,
  testConnection,
  STORAGE_PROBES,
  workerHasConfiguredDrive,
  getAccountDriveFileManager,
  getAccountStorageCredentials,
  resolveQueueStorage,
  frozenDriveMessage,
  defaultDriveIdOf,
  customDirNamesFromEnv,
  makeTokenPersister,
  provisionDriveCategoryDirs,
  completePan115QrLogin as completePan115QrLoginService,
  connectPan115Cookie as connectPan115CookieService,
  connectQuarkCookie as connectQuarkCookieService,
  connectUcCookie as connectUcCookieService,
  completeQuarkQrLogin as completeQuarkQrLoginService,
  completeUcQrLogin as completeUcQrLoginService,
  connectGuangYa as connectGuangYaService,
  completeTianyiQrLogin as completeTianyiQrLoginService,
  connectTianyiSson as connectTianyiSsonService,
  completePan123QrLogin as completePan123QrLoginService,
  connectPan123Token as connectPan123TokenService,
} from "../features/storage-drives";
import {
  buildMovieCandidateId,
  buildTitleId,
  buildTvCandidateId,
  parseMovieCandidateId,
  parseTvCandidateId,
  type MediaIdParseReason,
} from "@media-track/workflow";
import { formatNetworkError } from "./http-proxy";
import { isLiveSearch } from "./search-provider";
import { isAgentMemoryEnabled } from "./agent-memory-server";
import {
  getWorkflowRepository,
  setWorkflowRepositoryForTest,
  resetRuntimeContainerForTests,
  hydratePan115CookieFromDb,
  isPan115CookieHydrated,
  setPan115CookieHydrated,
  resetPanSouHealthCacheForTests as __resetPanSouHealthCacheForTests,
} from "../composition/runtime-container";
import {
  UNAUTHENTICATED_ACCOUNT_ID,
  SESSION_COOKIE_NAME,
  SESSION_SECRET_SETTING_KEY,
  JWT_SECRET_SETTING_KEY,
  type LoginPasswordState,
  type AuthOutcome,
  type ManagedAccount,
  type AccountBootstrapState,
  UnauthenticatedAccountError,
} from "../features/auth/contracts/auth-tokens";
import {
  isRemoteRequest,
  resolveSingleUserAccountId,
} from "../features/auth/core/identity-resolver";
import {
  isMultiUserEnabled,
  isCookieSecure,
  getSessionSecret,
  getJwtSecret,
  getJwtTtlSeconds,
  issueUserJwt,
  createLoginSession,
  resolveSessionAccountId,
  resolveBearerAccountId,
  hasLoginPassword,
  registerAccount,
  loginAccount,
  logoutSession,
  setSingleUserPassword,
  clearSingleUserPassword,
  changeOwnPassword,
  resetUserPassword,
  getBootstrapState,
  listManagedAccounts,
} from "../features/auth/application/account-service";
import {
  getCurrentAccountId,
  requireAuthenticatedAccountId,
  getCurrentAccountSummary,
} from "../platform/next-context/request-account";
import {
  PanSouResourceProvider,
  createProtectedPan115CookieStorageExecutorFromEnv,
  createBootstrapPan115CookieStorageExecutor,
  CompositeResourceProvider,
  ProwlarrResourceProvider,
  HaisouResourceProvider,
  createTmdbMetadataProvider,
  episodeCode,
  FakeResourceProvider,
  FakeStorageExecutor,
  FINISHED_RUN_RETENTION_MS,
  llmConfigError,
  formatDailyDigestPushText,
  scheduledDigestItems,
  getTrackedSeasonStatusView,
  importForeignWorkAsMovie,
  prepareMovieTarget,
  prepareSeriesTarget,
  prepareTrackingTarget,
  queueMovieAcquisition,
  queueSeriesInitialization,
  queueTrackingInitialization,
  reserveMovie,
  enqueueUrgentReplaceRequests,
  runQueuedManualImport,
  runQueuedMovieAcquisition,
  runQueuedReplaceRequest,
  runQueuedStagingRecovery,
  runQueuedSeriesInitialization,
  runQueuedType2Workflow,
  resolveDriveSourceLabels,
  runScheduledType3Monitoring,
  sweepOrphanStagingDirs,
  sendPushNotifications,
  migrateLegacyCookieToDefaultAccount,
  resolveStorageBinding,
  provisionCategoryDirs,
  parsePan115Uid,
  createDriveFileManager,
  type DriveFileManager,
  createExecutorForBrand,
  getStorageBrand,
  buildBootstrapExecutorForBrand,
  isRegisteredStorageProvider,
  allowedResourceTypesForKinds,
  parseCloudDriveUid,
  parseQuarkUid,
  UC_PROFILE,
  parseTianyiUid,
  parsePan123Uid,
  generateGuangYaDeviceId,
  GuangYaClient,
  isRunOrItsSeasonRecord,
  type QueueClaimOptions,
  type ResolveAccountWorkerContext,
  DEFAULT_ACCOUNT_ID,
  pickWorkspaceStorageId,
  resolveQueueStorageChoice,
  resolveWorkspaceFromParam,
  type Account,
  type WorkflowScope,
  type MediaSearchCandidate,
  type MediaTitle,
  type NotificationEvent,
  type ResourceProvider,
  type ResourceType,
  type SeasonMetadataSync,
  type StagingJanitorDrive,
  type StorageExecutor,
  type TianyiSession,
  type TianyiQrSession,
  type TrackedSeason,
  type TrackedSeasonStatusView,
  type VerifiedFile,
  type WorkflowRepository,
  type StorageProvider,
  type ConnectedStorage,
  Pan115CookieClient,
  QuarkCookieClient,
  TianyiClient,
  Pan123Client,
} from "@media-track/workflow";
import {
  buildPanSouProviderChain,
  getPanSouAuth,
  resolveUserPanSouBaseUrl,
} from "./pansou-chain";
import {
  ASSRT_TOKEN_SETTING_KEY,
  AUTO_UPDATE_ENABLED_SETTING_KEY,
  AUTO_UPDATE_FAIL_STREAK_SETTING_KEY,
  AUTO_UPDATE_LAST_ATTEMPT_SETTING_KEY,
  AUTO_UPDATE_TIME_SETTING_KEY,
  beijingDateTime,
  DAILY_SWEEP_TIME_SETTING_KEY,
  DAILY_SWEEP_TIMES_SETTING_KEY,
  DEFAULT_DAILY_SWEEP_TIME,
  DEFAULT_PATROL_CONCURRENCY,
  DEFAULT_TMDB_PROXY_BASE_URL,
  getAgentModel,
  getAgentModelForSearch,
  getAssrtToken,
  getAutoUpdateSettings,
  getAutoUpdateTime,
  getDailySweepTime,
  getDailySweepTimes,
  getHaisouApiKey,
  getJevConfig,
  getJevInheritedBaseUrl as getJevInheritedBaseUrlFromRepo,
  getLlmConfig,
  getPanSouBaseUrl,
  getPatrolConcurrency,
  getPreferredLanguage,
  getProwlarrConfig,
  getQualityPreference,
  getTmdbAccesses,
  HAISOU_API_KEY_SETTING_KEY,
  isAutoUpdateEnabled,
  isJevPrefilterActive,
  JEV_API_KEY_SETTING_KEY,
  JEV_BASE_URL_SETTING_KEY,
  JEV_HEALTH_SETTING_KEY,
  JEV_MODEL_SETTING_KEY,
  JEV_PREFILTER_ENABLED_SETTING_KEY,
  JEV_PROBED_FOR_SETTING_KEY,
  type JevConfig,
  jevConfigFingerprint,
  type JevSettingsSource,
  LAST_SWEEP_CLAIMS_SETTING_KEY,
  LAST_SWEEP_COMPLETED_AT_SETTING_KEY,
  LAST_SWEEP_DATE_SETTING_KEY,
  LLM_API_KEY_SETTING_KEY,
  LLM_BASE_URL_SETTING_KEY,
  LLM_MODEL_ID_SETTING_KEY,
  MAX_DAILY_SWEEP_TIMES,
  MAX_PATROL_CONCURRENCY,
  PANSOU_BASE_URL_SETTING_KEY,
  PANSOU_HEALTH_SETTING_KEY,
  parseAutoUpdateFailStreak,
  PATROL_CONCURRENCY_SETTING_KEY,
  PREFERRED_LANGUAGE_SETTING_KEY,
  PROWLARR_API_KEY_SETTING_KEY,
  PROWLARR_BASE_URL_SETTING_KEY,
  QUALITY_PREFERENCE_SETTING_KEY,
  readSweepClaims,
  resolveAgentModelConfig,
  resolveJevJudge,
  resolveTitleResearchOptions,
  TMDB_API_KEY_SETTING_KEY,
} from "./runtime/settings-readers";
import { findDemoCandidateById, findDemoCandidateByTmdbId } from "./demo-candidates";
import { seedDemoWorkflowRepository } from "./demo-workflow";
import { isDemoMode } from "./demo-mode";
import { isUpdateHoldActive, whileInFlight } from "./update-hold";
import { shouldAutoUpdate } from "./auto-update-schedule";

/** Checked by the workflow package right before each claim or patrol reservation, not
 *  only at entry: the updater can take the hold while a tick is still setting up. */
const mayStartRun = () => !isUpdateHoldActive(Date.now());

/** True while the updater holds new work before a container swap. Lets server actions
 *  (e.g. importForeignWorkAction) refuse upfront without importing update-hold directly. */
export { isUpdateInProgress };

export type { CandidateTrackingRequestResult };

let demoSeedPromise: Promise<void> | null = null;
let fakeResourceProvider: ResourceProvider | null = null;
let fakeStorageExecutor: StorageExecutor | null = null;

export {
  ASSRT_TOKEN_SETTING_KEY,
  AUTO_UPDATE_ENABLED_SETTING_KEY,
  AUTO_UPDATE_FAIL_STREAK_SETTING_KEY,
  AUTO_UPDATE_TIME_SETTING_KEY,
  beijingDateTime,
  DAILY_SWEEP_TIME_SETTING_KEY,
  DAILY_SWEEP_TIMES_SETTING_KEY,
  DEFAULT_DAILY_SWEEP_TIME,
  DEFAULT_PATROL_CONCURRENCY,
  DEFAULT_TMDB_PROXY_BASE_URL,
  getAgentModel,
  getAgentModelForSearch,
  getAssrtToken,
  getAutoUpdateSettings,
  getDailySweepTime,
  getDailySweepTimes,
  getHaisouApiKey,
  getJevConfig,
  getLlmConfig,
  getPanSouBaseUrl,
  getPatrolConcurrency,
  getPreferredLanguage,
  getProwlarrConfig,
  getQualityPreference,
  getTmdbAccesses,
  HAISOU_API_KEY_SETTING_KEY,
  isJevPrefilterActive,
  JEV_API_KEY_SETTING_KEY,
  JEV_BASE_URL_SETTING_KEY,
  JEV_HEALTH_SETTING_KEY,
  JEV_MODEL_SETTING_KEY,
  JEV_PREFILTER_ENABLED_SETTING_KEY,
  JEV_PROBED_FOR_SETTING_KEY,
  type JevConfig,
  jevConfigFingerprint,
  type JevSettingsSource,
  LAST_SWEEP_CLAIMS_SETTING_KEY,
  LAST_SWEEP_COMPLETED_AT_SETTING_KEY,
  LAST_SWEEP_DATE_SETTING_KEY,
  LLM_API_KEY_SETTING_KEY,
  LLM_BASE_URL_SETTING_KEY,
  LLM_MODEL_ID_SETTING_KEY,
  MAX_DAILY_SWEEP_TIMES,
  MAX_PATROL_CONCURRENCY,
  PANSOU_BASE_URL_SETTING_KEY,
  PANSOU_HEALTH_SETTING_KEY,
  PATROL_CONCURRENCY_SETTING_KEY,
  PREFERRED_LANGUAGE_SETTING_KEY,
  PROWLARR_API_KEY_SETTING_KEY,
  PROWLARR_BASE_URL_SETTING_KEY,
  QUALITY_PREFERENCE_SETTING_KEY,
  resolveAgentModelConfig,
  resolveJevJudge,
  resolveTitleResearchOptions,
  TMDB_API_KEY_SETTING_KEY,
};

export {
  getWorkflowRepository,
  setWorkflowRepositoryForTest,
  resetRuntimeContainerForTests,
  hydratePan115CookieFromDb,
  isPan115CookieHydrated,
  setPan115CookieHydrated,
  __resetPanSouHealthCacheForTests,
  UNAUTHENTICATED_ACCOUNT_ID,
  DEFAULT_ACCOUNT_ID,
  SESSION_COOKIE_NAME,
  SESSION_SECRET_SETTING_KEY,
  JWT_SECRET_SETTING_KEY,
  type LoginPasswordState,
  type AuthOutcome,
  type ManagedAccount,
  type AccountBootstrapState,
  UnauthenticatedAccountError,
  isRemoteRequest,
  resolveSingleUserAccountId,
  isMultiUserEnabled,
  isCookieSecure,
  getSessionSecret,
  getJwtSecret,
  getJwtTtlSeconds,
  issueUserJwt,
  createLoginSession,
  resolveSessionAccountId,
  resolveBearerAccountId,
  hasLoginPassword,
  registerAccount,
  loginAccount,
  logoutSession,
  setSingleUserPassword,
  clearSingleUserPassword,
  changeOwnPassword,
  resetUserPassword,
  getBootstrapState,
  listManagedAccounts,
  getCurrentAccountId,
  requireAuthenticatedAccountId,
  getCurrentAccountSummary,
};

export {
  getAccountScopedSettings,
  UpdateInProgressError,
  ensureDemoSeeded,
  runStartupMigrations,
  getJevBaseUrlOverride,
  getJevInheritedBaseUrl,
};

export async function getWorkflowStatusView(
  targetRepository: WorkflowRepository,
  accountId?: string,
): Promise<TrackedSeasonStatusView | null> {
  const resolvedAccountId = accountId ?? (await getCurrentAccountId());
  return getWorkflowStatusViewService(targetRepository, resolvedAccountId);
}


// ---------------------------------------------------------------------------
// Acquisition & worker runner facade (delegating to features/acquisition)
export { resolveIsDesktop } from "./desktop-flag";
export { DEFAULT_PANSOU_BASE_URL } from "./pansou-chain";
export { runAutoUpdateIfDue } from "../features/settings-system/application/auto-update-service";
export {
  queueCandidateTracking,
  queueCandidateSeries,
  reserveCandidate,
  acquireLlmPreflightError,
  importForeignWorkFiles,
  movieTargetFromTmdbId,
  buildAccountContextResolver,
  runNextQueuedWorkflow,
  recoverOrphanedRuns,
  runScheduledType3,
  getWorkerConcurrency,
  getWorkerResourceProvider,
} from "../features/acquisition";
// Storage drives connection & account management facade
export type { Pan115ConnectionStatus, ConnectedStorageView, AccountStorageCredentials };
export {
  StorageOwnedByOtherAccountError,
  clearPan115GlobalMirrorForUnboundDrive,
  getPan115ConnectionStatus,
  workerHasConfiguredDrive,
  testConnection,
  STORAGE_PROBES,
  getAccountDriveFileManager,
  customDirNamesFromEnv,
};

export async function getAccountConnectedStorages(explicitAccountId?: string): Promise<ConnectedStorageView[]> {
  const accountId = explicitAccountId ?? (await getCurrentAccountId());
  return getAccountConnectedStoragesService(accountId);
}

export async function completePan115QrLogin(
  input: { session: { uid: string; time: number; sign: string; qrcodeContent: string }; app?: string },
  explicitAccountId?: string,
): Promise<{ userName: string; app: string }> {
  const accountId = explicitAccountId ?? (await requireAuthenticatedAccountId());
  return completePan115QrLoginService(input, accountId);
}

export async function connectPan115Cookie(
  rawCookie: string,
  explicitAccountId?: string,
): Promise<{ providerUid: string; userName: string }> {
  const accountId = explicitAccountId ?? (await requireAuthenticatedAccountId());
  return connectPan115CookieService(rawCookie, accountId);
}

export async function connectQuarkCookie(rawCookie: string, explicitAccountId?: string): Promise<{ providerUid: string }> {
  const accountId = explicitAccountId ?? (await requireAuthenticatedAccountId());
  return connectQuarkCookieService(rawCookie, accountId);
}

export async function connectUcCookie(rawCookie: string, explicitAccountId?: string): Promise<{ providerUid: string }> {
  const accountId = explicitAccountId ?? (await requireAuthenticatedAccountId());
  return connectUcCookieService(rawCookie, accountId);
}

export async function completeQuarkQrLogin(serviceTicket: string, explicitAccountId?: string): Promise<{ providerUid: string }> {
  const accountId = explicitAccountId ?? (await requireAuthenticatedAccountId());
  return completeQuarkQrLoginService(serviceTicket, accountId);
}

export async function completeUcQrLogin(serviceTicket: string, explicitAccountId?: string): Promise<{ providerUid: string }> {
  const accountId = explicitAccountId ?? (await requireAuthenticatedAccountId());
  return completeUcQrLoginService(serviceTicket, accountId);
}

export async function connectGuangYa(
  rawAccessToken: string,
  rawRefreshToken: string,
  explicitAccountId?: string,
): Promise<{ providerUid: string }> {
  const accountId = explicitAccountId ?? (await requireAuthenticatedAccountId());
  return connectGuangYaService(rawAccessToken, rawRefreshToken, accountId);
}

export async function completeTianyiQrLogin(
  session: TianyiQrSession,
  redirectUrl: string,
  explicitAccountId?: string,
): Promise<{ providerUid: string }> {
  const accountId = explicitAccountId ?? (await requireAuthenticatedAccountId());
  return completeTianyiQrLoginService(session, redirectUrl, accountId);
}

export async function connectTianyiSson(sson: string, explicitAccountId?: string): Promise<{ providerUid: string }> {
  const accountId = explicitAccountId ?? (await requireAuthenticatedAccountId());
  return connectTianyiSsonService(sson, accountId);
}

export async function completePan123QrLogin(token: string, explicitAccountId?: string): Promise<{ providerUid: string }> {
  const accountId = explicitAccountId ?? (await requireAuthenticatedAccountId());
  return completePan123QrLoginService(token, accountId);
}

export async function connectPan123Token(rawToken: string, explicitAccountId?: string): Promise<{ providerUid: string }> {
  const accountId = explicitAccountId ?? (await requireAuthenticatedAccountId());
  return connectPan123TokenService(rawToken, accountId);
}


export const NOTIFICATION_WINDOW_DAYS = 7;

export function notificationWindowSince(): string {
  return new Date(Date.now() - NOTIFICATION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export async function getActiveWorkspaceScope(storageId?: string): Promise<WorkflowScope> {
  const accountId = await getCurrentAccountId();
  const storages = (await getWorkflowRepository().listConnectedStorages(accountId)).filter((s) =>
    isRegisteredStorageProvider(s.provider),
  );
  return { accountId, ...resolveWorkspaceFromParam(storages, storageId) };
}

export async function resolveGlobalWorkspace(w: string | undefined) {
  const accountId = await getCurrentAccountId();
  const storages = (await getWorkflowRepository().listConnectedStorages(accountId)).filter((s) =>
    isRegisteredStorageProvider(s.provider),
  );
  return { accountId, ...resolveWorkspaceFromParam(storages, w) };
}

export async function untrackTrackedTitle(
  tmdbId: number,
  storageId: string | undefined,
  mediaKind: "movie" | "tv",
  seasonNumber?: number,
) {
  const scope = await getActiveWorkspaceScope(storageId);
  return getWorkflowRepository().untrackTitle(tmdbId, scope, mediaKind, seasonNumber);
}

export async function getRegisteredDriveCount(): Promise<number> {
  const storages = await getWorkflowRepository().listConnectedStorages(await getCurrentAccountId());
  return storages.filter((s) => isRegisteredStorageProvider(s.provider)).length;
}

export const getForeignWorkReview = getForeignWorkReviewService;

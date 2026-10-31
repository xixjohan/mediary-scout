/**
 * Server Actions Root Facade
 * 
 * Sliced into vertical feature action adapters under app/actions/*.
 * Re-exported here with named exports for Next.js Server Action RPC compilation.
 */

export {
  type TestStorageConnectionResult,
  type UnbindStorageActionResult,
  type ConnectQuarkActionResult,
  testStorageConnectionAction,
  unbindStorageAction,
  connectPan115CookieAction,
  connectQuarkAction,
  connectUcAction,
  connectGuangYaAction,
  connectTianyiSsonAction,
  connectPan123TokenAction,
} from "./actions/storage-drives-actions";

export {
  type RequestTrackingActionResult,
  type ForeignWorkImportActionResult,
  acquireLlmNotConfigured,
  requestTrackingAction,
  requestSeriesAction,
  importForeignWorkAction,
  requestSeasonAction,
  requestRemainingAction,
  untrackTitleAction,
} from "./actions/acquisition-actions";

export {
  type PushSettingsActionResult,
  type LlmConfigResult,
  type PanSouConfigInput,
  savePushSettingsAction,
  clearPushChannelAction,
  saveDailySweepTimesAction,
  savePatrolConcurrencyAction,
  runPatrolNowAction,
  savePreferredLanguageAction,
  saveQualityPreferenceAction,
  saveLlmConfigAction,
  restoreFreeLlmAction,
  testLlmConnectionAction,
  saveTmdbApiKeyAction,
  clearTmdbApiKeyAction,
  saveAssrtTokenAction,
  clearAssrtTokenAction,
  savePanSouConfigAction,
  saveProwlarrConfigAction,
  clearProwlarrConfigAction,
  saveHaisouConfigAction,
  clearHaisouConfigAction,
  saveJevConfigAction,
  clearJevConfigAction,
  setJevPrefilterEnabledAction,
  testPushNotificationAction,
} from "./actions/settings-system-actions";

export {
  type ConnectLoginActionResult,
  type TestRemoteAccessResult,
  changePasswordAction,
  resetUserPasswordAction,
  requestConnectLoginAction,
  testRemoteAccessConnectionAction,
} from "./actions/auth-actions";

export {
  type MemoryAddressInput,
  type PendingEpisodeInput,
  type ProcessMessagesNowStatus,
  setAgentMemoryEnabledAction,
  deleteAgentMemoryAction,
  postUserMessageAction,
  editUserMessageAction,
  withdrawUserMessageAction,
  processMessagesNowAction,
  keepEpisodesAsIsAction,
  restoreEpisodesToPendingAction,
} from "./actions/assistant-actions";

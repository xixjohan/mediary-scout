import {
  createProtectedStorage115Executor,
  Storage115Executor,
  PAN115_TRANSFER_RESERVE_CALLS,
  PAN115_HARNESS_RESERVE_CALLS,
  type Pan115ApiGuard,
  type Pan115ApiGuardOptions,
  type Pan115StorageApi,
} from "./storage-115-executor.js";
import {
  Pan115CookieClient,
  type Pan115CookieClientOptions,
  type Pan115FetchJson,
} from "./pan115-cookie-client.js";
import { Pan115OpenClient, type Pan115OpenClientOptions } from "./pan115-open-client.js";
import {
  Pan115UnifiedStorageApi,
  type Pan115UnifiedStorageApiOptions,
} from "./pan115-unified-api.js";
import type {
  Pan115OpenOAuthCredentials,
  Pan115EngineMode,
} from "./account-credentials.js";
import { resolvePan115EngineMode, isPan115OpenOAuthValid } from "./account-credentials.js";

export interface ProtectedPan115CookieStorageExecutorFromEnvOptions {
  env?: Record<string, string | undefined> | undefined;
  fetchJson?: Pan115FetchJson | undefined;
  apiGuard?: Pan115ApiGuard | undefined;
  apiGuardOptions?: Pan115ApiGuardOptions | undefined;
  listLimit?: number | undefined;
}

export function createProtectedPan115CookieStorageExecutorFromEnv(
  options: ProtectedPan115CookieStorageExecutorFromEnvOptions = {},
): Storage115Executor {
  const env = options.env ?? process.env;
  const clientOptions: Pan115CookieClientOptions = {
    cookie: env["PAN115_COOKIE"] ?? "",
  };
  if (options.fetchJson !== undefined) {
    clientOptions.fetchJson = options.fetchJson;
  }
  if (options.listLimit !== undefined) {
    clientOptions.listLimit = options.listLimit;
  }
  const api = new Pan115CookieClient(clientOptions);
  const executorOptions: Parameters<typeof createProtectedStorage115Executor>[0] = {
    api,
    env,
  };
  if (options.apiGuard !== undefined) {
    executorOptions.apiGuard = options.apiGuard;
  }
  if (options.apiGuardOptions !== undefined) {
    executorOptions.apiGuardOptions = options.apiGuardOptions;
  }
  return createProtectedStorage115Executor(executorOptions);
}

/**
 * Bootstrap 115 executor with an EMPTY write scope = unrestricted writes. ONLY for
 * the connect-time `provisionCategoryDirs` bootstrap — find-or-create of the media
 * tree (`Mediary Scout/{Movies,TV,Anime}`) under the 115 account root.
 */
export function createBootstrapPan115CookieStorageExecutor(options: {
  cookie: string;
  env?: Record<string, string | undefined> | undefined;
  fetchJson?: Pan115FetchJson | undefined;
}): Storage115Executor {
  const env = options.env ?? process.env;
  const clientOptions: Pan115CookieClientOptions = { cookie: options.cookie };
  if (options.fetchJson !== undefined) {
    clientOptions.fetchJson = options.fetchJson;
  }
  const api = new Pan115CookieClient(clientOptions);
  const minDelayMs = Number(env["MEDIA_TRACK_115_MIN_DELAY_MS"]);
  const maxCalls = Number(env["MEDIA_TRACK_115_MAX_API_CALLS"]);
  return new Storage115Executor({
    api,
    writeScopeDirectoryIds: [],
    apiGuardOptions: {
      minDelayMs: Number.isFinite(minDelayMs) && minDelayMs > 0 ? minDelayMs : 1_200,
      maxCallsPerOperation: Number.isFinite(maxCalls) && maxCalls > 0 ? maxCalls : 300,
      transferReserveCalls: PAN115_TRANSFER_RESERVE_CALLS,
      harnessReserveCalls: PAN115_HARNESS_RESERVE_CALLS,
      maxListItemsPerResponse: 1_000,
    },
  });
}

export interface UnifiedPan115StorageExecutorOptions {
  cookie?: string | undefined;
  openOAuth?: Pan115OpenOAuthCredentials | undefined;
  engineMode?: Pan115EngineMode | undefined;
  scopeCids?: string[] | undefined;
  env?: Record<string, string | undefined> | undefined;
  fetchJson?: Pan115FetchJson | undefined;
  apiGuard?: Pan115ApiGuard | undefined;
  apiGuardOptions?: Pan115ApiGuardOptions | undefined;
  onOpenCredentialsPersist?: ((creds: Pan115OpenOAuthCredentials) => Promise<void> | void) | undefined;
}

/**
 * 创建统一的双轨 115 执行器 (Pan115 Unified Storage Executor)
 * 智能聚合 Cookie 与 Open OAuth 引擎，按操作类型实现策略派发与平滑降级
 */
export function createUnifiedPan115StorageExecutor(
  options: UnifiedPan115StorageExecutorOptions,
): Storage115Executor {
  const env = options.env ?? process.env;
  const hasCookie = Boolean(options.cookie && options.cookie.trim().length > 0);
  const hasOpen = isPan115OpenOAuthValid(options.openOAuth);

  let cookieApi: Pan115StorageApi | undefined;
  if (hasCookie) {
    const clientOptions: Pan115CookieClientOptions = { cookie: options.cookie! };
    if (options.fetchJson !== undefined) {
      clientOptions.fetchJson = options.fetchJson;
    }
    cookieApi = new Pan115CookieClient(clientOptions);
  }

  let openApi: Pan115OpenClient | undefined;
  if (hasOpen && options.openOAuth) {
    const openClientOpts: Pan115OpenClientOptions = {
      credentials: options.openOAuth,
    };
    if (options.onOpenCredentialsPersist !== undefined) {
      openClientOpts.onCredentialsPersist = options.onOpenCredentialsPersist;
    }
    openApi = new Pan115OpenClient(openClientOpts);
  }

  const mode = options.engineMode ?? resolvePan115EngineMode({
    cookie: options.cookie,
    openOAuth: options.openOAuth,
    engineMode: options.engineMode,
  });

  const unifiedApiOpts: Pan115UnifiedStorageApiOptions = {
    mode,
    onFallback: (op, err) => {
      console.warn(`[Pan115UnifiedStorageExecutor] Fallback occurred on "${op}":`, err);
    },
  };
  if (cookieApi !== undefined) {
    unifiedApiOpts.cookieApi = cookieApi;
  }
  if (openApi !== undefined) {
    unifiedApiOpts.openApi = openApi;
  }

  const api = new Pan115UnifiedStorageApi(unifiedApiOpts);

  const executorOptions: Parameters<typeof createProtectedStorage115Executor>[0] = {
    api,
    env,
  };
  if (options.apiGuard !== undefined) {
    executorOptions.apiGuard = options.apiGuard;
  }
  if (options.apiGuardOptions !== undefined) {
    executorOptions.apiGuardOptions = options.apiGuardOptions;
  }

  return createProtectedStorage115Executor(executorOptions);
}

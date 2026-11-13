/**
 * 115 Open OAuth Token 主动保活模块 (Pan115 Open OAuth Proactive Keep-Alive)
 *
 * 职责：在 background-worker 每次 tick 中检查所有已连接的 115 Open OAuth 账号，
 * 当 access_token 临近过期（< 60 分钟）时主动刷新，确保 refresh_token 轮换结果
 * 被正确持久化，避免长时间不使用导致的 token 自然老化失效（40140116）以及
 * 因新 refresh_token 未持久化导致的防篡改校验失败（40140120）。
 *
 * 架构说明：
 *   - 复用已有的 Pan115OpenClient.ensureValidToken() 刷新逻辑（含 SingleFlight 防并发）
 *   - 复用专用 115 Open OAuth persister，完整保留 storage payload
 *   - 内存防抖防止同一账号 30 分钟内重复触发
 *   - 致命失败（token 被撤销）不抛出，仅记录日志（通知系统待接入）
 *
 * 参考：
 *   - LitePan `internal/auth/refresh_runner.go` CallerActive 主动调度
 *   - 本项目 `packages/workflow/src/storage/pan115-open-client.ts` ensureValidToken
 *   - 本项目 `apps/web/features/storage-drives/application/drive-service.ts` makeTokenPersister
 */

import {
  Pan115OpenClient,
  Pan115OpenAuthError,
  type ConnectedStorage,
  type Pan115OpenOAuthCredentials,
} from "@media-track/workflow";
import {
  freezeConnectedStorage,
  makePan115OpenOAuthPersister,
  makePan115OpenOAuthRefreshCoordinator,
} from "../features/storage-drives/application/drive-service";
import { getWorkflowRepository } from "../composition/runtime-container";

/** access_token 有效期少于此值时触发主动刷新（提前 15 分钟，降低重启即旋转的概率） */
const PROACTIVE_REFRESH_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * 同一 storage 两次成功刷新之间的最短间隔（内存防抖）。
 * background-worker 每 3 秒 tick 一次，此防抖保证不会每次 tick 都检查刷新。
 */
const MIN_REFRESH_INTERVAL_MS = 20 * 60 * 1000; // 20 分钟

/**
 * 刷新失败（无论瞬态还是致命）后的冷却期。
 * 避免 background-worker 高频 tick 在失败后立即重试，
 * 防止触发 115 平台频率限制（40140117）或无效地重试已吊销的 token。
 * - 瞬态失败（网络抖动）: 5 分钟后再试
 * - 致命失败（token 吊销）: 30 分钟冷却（需人工重授权，自动重试无意义）
 */
const TRANSIENT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // 5 分钟
const FATAL_FAILURE_COOLDOWN_MS = 30 * 60 * 1000; // 30 分钟

/** 禁用提示只打印一次，避免每个 tick 刷屏 */
let refreshDisabledLogged = false;

/** 记录上次尝试刷新时间（成功或失败都记录，in-memory，重启后重置） */
const lastRefreshedAt = new Map<string, number>();
const clientsByStorage = new Map<string, Pan115OpenClient>();

function openOAuthFromStorage(storage: ConnectedStorage): Pan115OpenOAuthCredentials | null {
  if (storage.provider !== "pan115") return null;
  const payload = storage.payload as Record<string, unknown> | null;
  const credentials = payload?.openOAuth as Pan115OpenOAuthCredentials | undefined;
  return credentials?.accessToken && credentials.refreshToken ? credentials : null;
}

function shouldRefresh(storageId: string, expiresAt: number, now: number): boolean {
  const lastAt = lastRefreshedAt.get(storageId) ?? 0;
  if (now - lastAt < MIN_REFRESH_INTERVAL_MS) return false;
  return expiresAt - now <= PROACTIVE_REFRESH_THRESHOLD_MS;
}

function getOrCreateKeepAliveClient(
  accountId: string,
  storageId: string,
  credentials: Pan115OpenOAuthCredentials,
): Pan115OpenClient {
  let client = clientsByStorage.get(storageId);
  const cached = client?.getCredentials();
  const matchesPersisted =
    cached?.accessToken === credentials.accessToken &&
    cached?.refreshToken === credentials.refreshToken &&
    cached?.expiresAt === credentials.expiresAt;
  const hasUnpersistedRotation =
    client?.hasPendingCredentialPersistence === true &&
    cached !== undefined &&
    cached.expiresAt > credentials.expiresAt;
  if (!client || (!matchesPersisted && !hasUnpersistedRotation)) {
    client = new Pan115OpenClient({
      credentials: { ...credentials },
      onCredentialsPersist: makePan115OpenOAuthPersister(accountId, storageId),
      coordinateTokenRefresh: makePan115OpenOAuthRefreshCoordinator(accountId, storageId),
    });
    clientsByStorage.set(storageId, client);
  }
  return client;
}

async function refreshStorageToken(
  accountId: string,
  storage: ConnectedStorage,
  credentials: Pan115OpenOAuthCredentials,
  expiresAt: number,
  now: number,
  result: TokenKeepAliveResult,
): Promise<void> {
  const minutesLeft = Math.round((expiresAt - now) / 60_000);
  try {
    const client = getOrCreateKeepAliveClient(accountId, storage.id, credentials);
    await client.ensureValidToken();
    lastRefreshedAt.set(storage.id, Date.now());
    result.refreshed++;
    console.log(
      `[token-keepalive] 115 Open OAuth for ${storage.id} refreshed proactively` +
        (minutesLeft <= 0 ? " (was already expired)" : ` (${minutesLeft} min left)`),
    );
  } catch (err) {
    const isFatal = err instanceof Pan115OpenAuthError && err.isFatal;
    if (isFatal) {
      result.fatal++;
      lastRefreshedAt.set(storage.id, now + FATAL_FAILURE_COOLDOWN_MS - MIN_REFRESH_INTERVAL_MS);
      console.error(
        `[token-keepalive] FATAL: 115 Open OAuth for ${storage.id} requires re-authorization. ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      // 落库：把"需要重新授权"变成持久状态，UI 才能提示，重启也不会再空转重试。
      await freezeConnectedStorage(
        storage.id,
        `115_OAUTH_NEEDS_REAUTH: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    result.failed++;
    lastRefreshedAt.set(storage.id, now + TRANSIENT_FAILURE_COOLDOWN_MS - MIN_REFRESH_INTERVAL_MS);
    console.warn(
      `[token-keepalive] transient refresh failure for ${storage.id} (will retry in ~${TRANSIENT_FAILURE_COOLDOWN_MS / 60_000} min): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface TokenKeepAliveResult {
  /** 检查的 115 Open OAuth 账号数（已过期阈值的） */
  refreshed: number;
  /** 刷新失败（非致命，可重试） */
  failed: number;
  /** 致命失败（token 被撤销 / 用户踢出，需重新授权） */
  fatal: number;
}

/**
 * 执行一轮 115 Open OAuth Token 保活检查。
 *
 * 被 background-worker drainQueueOnce() 在每次 tick 结束时调用。
 * 通常不需要显式调用，由 WorkerRuntime.runTokenKeepAlive 包装后注入。
 */
export async function runPan115TokenKeepAlive(
  accountId: string,
): Promise<TokenKeepAliveResult> {
  const result: TokenKeepAliveResult = { refreshed: 0, failed: 0, fatal: 0 };

  // 多副本共用同一个 115 账号时，刷新会旋转 refresh_token 并作废其它副本。
  // 开发实例通过该开关彻底放弃刷新权，只做只读使用，避免把生产实例打成"需重新授权"。
  if (process.env.PAN115_OAUTH_REFRESH_DISABLED === "1") {
    if (!refreshDisabledLogged) {
      refreshDisabledLogged = true;
      console.warn(
        "[token-keepalive] disabled by PAN115_OAUTH_REFRESH_DISABLED=1: " +
          "this instance will not refresh 115 OAuth (avoids rotation conflict with the other instance)",
      );
    }
    return result;
  }

  const now = Date.now();

  let storages: Awaited<ReturnType<ReturnType<typeof getWorkflowRepository>["listConnectedStorages"]>>;
  try {
    storages = await getWorkflowRepository().listConnectedStorages(accountId);
  } catch {
    // 数据库暂不可用，跳过本次保活
    return result;
  }

  for (const storage of storages) {
    // 已冻结（需重新授权）的盘不再重试：重试旧 refresh_token 会触发 115 的复用检测。
    if (storage.status === "frozen") continue;
    const openOAuth = openOAuthFromStorage(storage);
    if (!openOAuth || !shouldRefresh(storage.id, openOAuth.expiresAt, now)) continue;
    await refreshStorageToken(accountId, storage, openOAuth, openOAuth.expiresAt, now, result);
  }

  return result;
}

/** Test-only: 清除内存防抖状态，使下次 keepalive 可以立即对所有账号执行检查 */
export function __resetTokenKeepAliveStateForTests(): void {
  lastRefreshedAt.clear();
  clientsByStorage.clear();
}

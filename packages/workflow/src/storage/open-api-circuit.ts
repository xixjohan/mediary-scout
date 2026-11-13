/**
 * 115 Open API 的「致命失效熔断器」。
 *
 * 背景：OAuth 的 refresh_token 一旦被判失效（`40140137` / `40140116`），
 * 每次解析直链仍会先尝试 Open API —— 白付一次网络往返 + 一次必然失败的刷新，
 * 然后才降级到 Cookie。播放高峰时这段无效开销会直接体现在首字节上。
 *
 * 这里按 storageId 记录「已知致命」状态，在冷却期内直接跳过 Open API。
 * 进程内内存即可：重新授权后进程重启或冷却到期都会自动恢复。
 */

/** 致命失效后的跳过期：与 keepalive 的冷却保持一致（30 分钟）。 */
const FATAL_COOLDOWN_MS = 30 * 60 * 1000;

const blockedUntil = new Map<string, number>();

export function markOpenApiFatal(storageId: string, now: number = Date.now()): void {
  blockedUntil.set(storageId, now + FATAL_COOLDOWN_MS);
}

export function shouldSkipOpenApi(storageId: string, now: number = Date.now()): boolean {
  const until = blockedUntil.get(storageId);
  if (until === undefined) return false;
  if (until <= now) {
    blockedUntil.delete(storageId);
    return false;
  }
  return true;
}

/** 重新授权成功后应立即解除熔断。 */
export function clearOpenApiFatal(storageId: string): void {
  blockedUntil.delete(storageId);
}

export function __resetOpenApiCircuitForTests(): void {
  blockedUntil.clear();
}

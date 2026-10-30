/**
 * Cooldown limiter for the user-triggered resource search (W2,
 * `POST /api/titles/resources`).
 *
 * The plan scopes this endpoint hard: 「scope 门控 + 60s 限流 + 30 分钟 TTL。仅详情页
 * 手动触发」. A user-triggered search spends the same indexer/drive budget the
 * background agent does — §2.3 of the plan measures a single transfer at dozens of
 * drive calls — so an unthrottled button would let one user starve every run.
 *
 * Cooldown (not a request-count window) is the right shape here: the budget we are
 * protecting is "how often may I spend a search", not "how many searches per minute".
 * It also makes the rejection informative — `remainingMs` feeds a `Retry-After`
 * header, so the UI can say "60 秒后可再查" instead of a bare 429.
 *
 * The clock is injected so cooldown boundaries are tested without waiting.
 */
export interface CooldownLimiterOptions {
  /** Injectable clock (ms since epoch). */
  now: () => number;
  cooldownMs: number;
}

export class CooldownLimiter {
  private readonly lastAllowed = new Map<string, number>();

  constructor(private readonly options: CooldownLimiterOptions) {
    if (!Number.isFinite(options.cooldownMs) || options.cooldownMs <= 0) {
      throw new Error("CooldownLimiter: cooldownMs must be a positive number");
    }
  }

  /**
   * Try to spend one slot. Returns true and stamps the key when allowed; returns
   * false and leaves the previous stamp untouched when still cooling down — a
   * rejected attempt must NOT extend the cooldown, or a user hammering the button
   * would lock themselves out indefinitely.
   */
  tryAcquire(key: string): boolean {
    const at = this.options.now();
    const last = this.lastAllowed.get(key);
    if (last !== undefined && at - last < this.options.cooldownMs) {
      return false;
    }
    this.lastAllowed.set(key, at);
    return true;
  }

  /** Milliseconds until this key may be tried again (0 when ready). */
  remainingMs(key: string): number {
    const last = this.lastAllowed.get(key);
    if (last === undefined) return 0;
    const remaining = this.options.cooldownMs - (this.options.now() - last);
    return remaining > 0 ? remaining : 0;
  }

  /** Live key count — same reason as TitleResourceCache.size: bounded memory. */
  get size(): number {
    return this.lastAllowed.size;
  }

  /** Drop a key's stamp (e.g. after a successful action that should not be throttled). */
  reset(key: string): void {
    this.lastAllowed.delete(key);
  }
}

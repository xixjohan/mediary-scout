/**
 * TTL cache for the user-triggered resource search (W2, `POST /api/titles/resources`).
 *
 * The search hits indexers and (for a real drive) possibly drive APIs, so it is
 * rate-limited to manual, detail-page-only triggers. The 30-minute TTL is the
 * acceptance criterion: 「30 分钟内命中缓存、超 30 分钟 candidateId 失效」.
 *
 * "candidateId 失效" is the half that is easy to get wrong. A cache that merely
 * *stops returning* old ids leaves them valid: batch 3's manual import will take a
 * candidateId, and if an expired id still resolves, a user could import a candidate
 * that no longer exists in the snapshot. So expiry EVICTS, and
 * `hasFreshCandidate` is the single question the import path asks — an expired
 * entry answers false for every id it ever held.
 *
 * The clock is injected so the TTL is tested without sleeping, and so the real
 * endpoint can share one cache across requests.
 */
export interface TitleResourceCacheOptions<T> {
  /** Injectable clock (ms since epoch). Tests drive it; prod passes Date.now. */
  now: () => number;
  ttlMs: number;
  /**
   * How to read an entry's id. Generic over the stored value so the same cache
   * serves both halves of the criterion: `get` returns what the response body
   * needs (the candidate views), while `hasFreshCandidate` answers whether a
   * held candidateId is still valid — one source, not two.
   */
  idOf: (value: T) => string;
}

export class TitleResourceCache<T = unknown> {
  private readonly entries = new Map<
    string,
    { values: readonly T[]; storedAtMs: number; snapshotId?: string | undefined }
  >();

  constructor(private readonly options: TitleResourceCacheOptions<T>) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("TitleResourceCache: ttlMs must be a positive number");
    }
  }

  /**
   * Cache key. Callers MUST include the scope (accountId / connected storage) — a
   * cache shared across scopes would leak one account's candidate ids to another.
   */
  static key(scopeId: string, titleId: string): string {
    return `${scopeId}::${titleId}`;
  }

  /** Fresh values, or null when absent/expired. Expired entries are evicted. */
  get(key: string): readonly T[] | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      return null;
    }
    return entry.values;
  }

  /** Read the authoritative persisted snapshotId associated with a fresh cache entry. */
  getSnapshotId(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.snapshotId;
  }

  put(key: string, values: readonly T[], snapshotId?: string): void {
    this.entries.set(key, {
      values: [...values],
      storedAtMs: this.options.now(),
      ...(snapshotId === undefined ? {} : { snapshotId }),
    });
  }

  /**
   * The single question batch 3's manual import asks. False for an unknown key, an
   * expired key, or an id the fresh entry never held.
   */
  hasFreshCandidate(key: string, candidateId: string): boolean {
    const fresh = this.get(key);
    return fresh !== null && fresh.some((value) => this.options.idOf(value) === candidateId);
  }

  /**
   * Live entry count. Exposed so expiry is observable: an expired entry that is
   * merely "not returned" would stay in the map forever, and this cache lives for
   * the lifetime of a long-running server (every title ever searched).
   */
  get size(): number {
    return this.entries.size;
  }

  private isExpired(entry: { storedAtMs: number }): boolean {
    return this.options.now() - entry.storedAtMs >= this.options.ttlMs;
  }
}

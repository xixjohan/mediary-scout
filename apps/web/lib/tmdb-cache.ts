import "server-only";
import type {
  DurableJsonCache,
  SearchInterpretationCache,
  SearchQueryInterpretation,
} from "@media-track/workflow";

/**
 * TMDB 搜索 / 剧集目标的缓存分层。
 *
 * 持久层（L2）现由 `SqliteJsonCache`（@media-track/workflow，纯 SQLite）承载，
 * Docker 与桌面端共用；历史上的 PostgresMediaSearchCache 已随纯 SQLite 化移除
 * （任务单 S1.4b，见 docs/architecture-optimization-workflow.md）。
 *
 * 本文件只保留不需要盘的两个进程内实现：
 * - `InMemoryJsonCache`：演示 / 无盘路径的 DurableJsonCache。
 * - `SearchInterpretationCacheAdapter`：描述 → 片名记忆，包在任一 DurableJsonCache 上。
 */

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h: TMDB search results barely change

/**
 * In-memory `DurableJsonCache`。NOT durable — the store resets on every process
 * restart — which is fine for the paths that use it: a cold load then pays one
 * live TMDB round-trip (the same trade-off the L1 map already makes). Expired
 * entries are evicted lazily on read.
 */
export class InMemoryJsonCache implements DurableJsonCache {
  private readonly ttlMs: number;
  private readonly values = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(options?: { ttlMs?: number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const entry = this.values.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    // Return a fresh clone so a caller mutating the result can't corrupt the cached
    // object (the SQLite-backed cache rehydrates from JSON on every read — match it).
    return structuredClone(entry.value) as T;
  }

  async setJson(key: string, value: unknown, ttlMs?: number): Promise<void> {
    // Snapshot on write too, so a caller mutating the object AFTER setJson doesn't
    // retroactively change what's cached.
    this.values.set(key, { value: structuredClone(value), expiresAt: Date.now() + (ttlMs ?? this.ttlMs) });
  }
}

/**
 * Description → title memory, over the same durable JSON store.
 *
 * This exists because the search page re-renders server-side every five seconds
 * while an acquisition runs (AcquiringPoller). Without it, one typed description
 * would buy a web search AND a model call on every poll for the whole run. A
 * resolved-to-nothing answer is stored too, so a dead description is not retried
 * either. TTL is short: a brand-new show must become findable within the hour.
 */
export class SearchInterpretationCacheAdapter implements SearchInterpretationCache {
  private static readonly TTL_MS = 60 * 60 * 1000; // 1h

  constructor(private readonly store: DurableJsonCache) {}

  async get(query: string): Promise<SearchQueryInterpretation | null> {
    return this.store.getJson<SearchQueryInterpretation>(this.key(query));
  }

  async set(query: string, value: SearchQueryInterpretation): Promise<void> {
    await this.store.setJson(this.key(query), value, SearchInterpretationCacheAdapter.TTL_MS);
  }

  private key(query: string): string {
    return `search-meaning:${query.trim().toLowerCase()}`;
  }
}

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

/**
 * node:fs / node:path **调用时**才 require（复用下方 better-sqlite3 的同一
 * requireNative）：本模块经 workflow barrel 被客户端可达链 import，静态
 * node:fs 会炸 Turbopack 客户端 chunk（S4.3 实测回归；node_modules 内的包
 * 不受 server-only 标记保护，只有让打包器静态分析不到才安全）。
 */
type FsLike = typeof import("node:fs");
type PathLike = typeof import("node:path");
function fs(): FsLike {
  return requireNative("node:fs") as FsLike;
}
function nodePath(): PathLike {
  return requireNative("node:path") as PathLike;
}
import type Database from "better-sqlite3";
import type { DurableJsonCache, MediaSearchCache, MediaSearchCandidate } from "./search-view.js";

/**
 * 纯 SQLite 持久化 JSON 缓存（任务单 S1.4b）：替代 PostgresMediaSearchCache，
 * 让 TMDB 搜索缓存 / 剧集目标缓存在 Docker 与桌面端共用同一套 SQLite 仓储。
 *
 * 语义与 PG 版逐条对齐（迁移不能悄悄改行为）：
 * - KEY：MediaSearchCache 走 trim+lowercase 归一化；DurableJsonCache 键原样存储。
 * - FRESHNESS：默认 6h TTL，过期条目读时懒删并返回 null。
 * - EVICTION：懒删 + 时间片防护的定期清扫（默认 10 分钟一次，不在每次写时扫）。
 * - 克隆：读写都返回/存储克隆，调用方改对象不污染缓存（PG 版经 jsonb 天然重建）。
 */

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h: TMDB 搜索结果极少变化
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 清扫频率上限：每 10 分钟最多一次

function normalizeKey(query: string): string {
  return query.trim().toLowerCase();
}

export class SqliteJsonCache implements DurableJsonCache, MediaSearchCache {
  private readonly ttlMs: number;
  private lastSweepAt = 0;

  constructor(
    private readonly db: Database.Database,
    options?: { ttlMs?: number },
  ) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tmdb_search_cache (
        cache_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tmdb_search_cache_expires_at_idx
        ON tmdb_search_cache (expires_at);
    `);
  }

  // ---- MediaSearchCache ----

  async get(query: string): Promise<MediaSearchCandidate[] | null> {
    return this.getJson<MediaSearchCandidate[]>(normalizeKey(query));
  }

  async set(query: string, candidates: MediaSearchCandidate[]): Promise<void> {
    await this.setJson(normalizeKey(query), candidates);
  }

  // ---- DurableJsonCache ----

  async getJson<T>(key: string): Promise<T | null> {
    const row = this.db
      .prepare("SELECT payload, expires_at FROM tmdb_search_cache WHERE cache_key = ?")
      .get(key) as { payload: string; expires_at: number } | undefined;
    if (!row) {
      return null; // cold miss
    }
    if (row.expires_at <= Date.now()) {
      // Stale — 懒删后报未命中，让调用方回源 TMDB。
      this.db
        .prepare("DELETE FROM tmdb_search_cache WHERE cache_key = ? AND expires_at <= ?")
        .run(key, Date.now());
      return null;
    }
    return structuredClone(JSON.parse(row.payload)) as T;
  }

  async setJson(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const expiresAt = Date.now() + (ttlMs ?? this.ttlMs);
    this.db
      .prepare(
        `INSERT INTO tmdb_search_cache (cache_key, payload, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT (cache_key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
      )
      .run(key, JSON.stringify(value), expiresAt);
    this.sweepExpiredOccasionally();
  }

  close(): void {
    this.db.close();
  }

  // Active eviction: 清掉再也不会有人读的过期行。时间片防护——一次有界 DELETE，
  // 不是每次写都扫。
  private sweepExpiredOccasionally(): void {
    const now = Date.now();
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweepAt = now;
    this.db.prepare("DELETE FROM tmdb_search_cache WHERE expires_at < ?").run(now);
  }
}

// 与 sqlite.ts 同一策略：调用时才 require 原生模块，模块加载期不碰 better-sqlite3。
const requireNative = createRequire(import.meta.url);

/**
 * 默认 SQLite 路径（纯字符串，无 node 内置导入——客户端可达的模块链上
 * 禁止出现 node:fs/node:path，否则 Turbopack 客户端 chunk 构建失败，
 * 见 S4.3 的构建回归）。
 */
export const DEFAULT_SQLITE_DB_PATH = "data/mediary.db";

export function sqliteDbPathFromEnv(env: Record<string, string | undefined>): string {
  return env.MEDIA_TRACK_SQLITE_PATH?.trim() || DEFAULT_SQLITE_DB_PATH;
}

/** 打开（或新建）一个落盘的 SQLite JSON 缓存；父目录不存在时自动创建。 */
export function openSqliteJsonCache(dbPath: string, options?: { ttlMs?: number }): SqliteJsonCache {
  let DatabaseCtor: typeof import("better-sqlite3");
  try {
    DatabaseCtor = requireNative("better-sqlite3") as typeof import("better-sqlite3");
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      "SQLite mode is enabled (MEDIA_TRACK_SQLITE_PATH is set) but the optional native " +
        "dependency 'better-sqlite3' could not be loaded. Install it (e.g. `npm install` " +
        "without --no-optional) and ensure it is built for this platform's Node/Electron ABI " +
        `(desktop builds: @electron/rebuild). Original error: ${cause}`,
      { cause: error },
    );
  }
  // 父目录不存在（docker 首启挂空卷 / 本机新部署）时先建，否则 better-sqlite3 以
  // ENOENT 失败。文件系统操作集中在本包——调用方（含客户端可达链上的模块）
  // 不需要 import node:fs。
  fs().mkdirSync(nodePath().dirname(nodePath().resolve(dbPath)), { recursive: true });
  return new SqliteJsonCache(new DatabaseCtor(dbPath), options);
}

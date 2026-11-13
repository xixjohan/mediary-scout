import type Database from "better-sqlite3";
import { BaseSqliteModule, type SqliteDbContext } from "../sqlite-context.js";
import type {
  MediaLibrary,
  LibraryPathBinding,
  LibraryMediaItem,
  LibrarySeason,
  LibraryEpisode,
  LibraryScanSnapshot,
  MediaLibraryType,
  LibraryDeliveryMode,
  BindingDeliveryMode,
  LibraryScanMode,
  MediaReviewStatus,
  SubtitleTrackInfo,
} from "@media-track/contracts";

export interface CreateMediaLibraryInput {
  accountId: string;
  name: string;
  libraryType?: MediaLibraryType;
  posterStyle?: "poster" | "backdrop";
  isPinned?: boolean;
  sortOrder?: number;
  defaultDeliveryMode?: LibraryDeliveryMode;
}

export interface UpdateMediaLibraryInput {
  name?: string;
  posterStyle?: "poster" | "backdrop";
  isPinned?: boolean;
  sortOrder?: number;
  defaultDeliveryMode?: LibraryDeliveryMode;
  libraryType?: never;
}

export interface CreateLibraryPathBindingInput {
  libraryId: string;
  storageId: string;
  remoteFolderId: string;
  remotePath: string;
  scheduledScanEnabled?: boolean;
  scanIntervalMinutes?: number;
  scanCron?: string | null;
  scanMode?: LibraryScanMode;
  minFileSizeMb?: number;
  excludeKeywords?: string[];
  deliveryMode?: BindingDeliveryMode;
}

export interface UpdateLibraryPathBindingInput {
  remoteFolderId?: string;
  remotePath?: string;
  scheduledScanEnabled?: boolean;
  scanIntervalMinutes?: number;
  scanCron?: string | null;
  scanMode?: LibraryScanMode;
  minFileSizeMb?: number;
  excludeKeywords?: string[];
  deliveryMode?: BindingDeliveryMode;
  lastScanAt?: string | null;
  lastScanStatus?: "idle" | "running" | "success" | "failed" | null;
}

export interface UpsertLibraryMediaItemInput {
  id: string;
  libraryId: string;
  tmdbId?: number | null | undefined;
  doubanId?: string | null | undefined;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle?: string | null | undefined;
  releaseYear?: number | null | undefined;
  overview?: string | null | undefined;
  posterPath?: string | null | undefined;
  backdropPath?: string | null | undefined;
  rating?: number | null | undefined;
  genres?: string[] | undefined;
  isMetadataLocked?: boolean | undefined;
  reviewStatus?: MediaReviewStatus | undefined;
}

export interface UpsertLibrarySeasonInput {
  id: string;
  mediaItemId: string;
  seasonNumber: number;
  name?: string;
  totalEpisodes?: number | undefined;
  posterPath?: string | null | undefined;
  airDate?: string | null | undefined;
}

export interface UpsertLibraryEpisodeInput {
  id: string;
  seasonId: string;
  bindingId?: string | undefined;
  episodeNumber: number;
  episodeName?: string | null | undefined;
  storageId: string;
  fileId: string;
  fileName: string;
  versionTag?: string | null | undefined;
  isDefaultVersion?: boolean | undefined;
  pickCode?: string | null | undefined;
  sizeBytes: number;
  videoCodec?: string | null | undefined;
  resolution?: string | null | undefined;
  durationSeconds?: number | null | undefined;
  subtitles?: SubtitleTrackInfo[] | undefined;
  relativePath?: string | null | undefined;
}

export interface MediaItemListQuery {
  libraryId?: string | undefined;
  mediaType?: "movie" | "tv" | undefined;
  query?: string | undefined;
  reviewStatus?: MediaReviewStatus | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

function parseGenres(val: unknown): string[] {
  try {
    return JSON.parse(String(val || "[]")) as string[];
  } catch {
    return [];
  }
}

function parseOptNum(val: unknown): number | undefined {
  return val !== undefined && val !== null ? Number(val) : undefined;
}

function parseNullableStr(val: unknown): string | null {
  return val ? String(val) : null;
}

function parseNullableNum(val: unknown): number | null {
  return val ? Number(val) : null;
}

function fallbackVal<T>(val: T | undefined | null, def: T): T {
  if (val !== undefined && val !== null) return val;
  return def;
}

export class SqliteMediaLibraryRepository extends BaseSqliteModule {
  constructor(ctxOrDb: SqliteDbContext | Database.Database) {
    if ("db" in ctxOrDb) {
      super(ctxOrDb);
    } else {
      super({
        db: ctxOrDb,
        now: () => new Date().toISOString(),
        transaction: <T>(fn: () => T) => ctxOrDb.transaction(fn),
      });
    }
  }

  // ==================== 影视库 MediaLibrary ====================

  listLibraries(accountId: string): MediaLibrary[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM media_libraries
         WHERE account_id = ?
         ORDER BY is_pinned DESC, sort_order ASC, created_at ASC`,
      )
      .all(accountId) as Array<Record<string, unknown>>;

    return rows.map(this.mapLibraryRow);
  }

  getLibrary(id: string): MediaLibrary | null {
    const row = this.db.prepare(`SELECT * FROM media_libraries WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapLibraryRow(row) : null;
  }

  createLibrary(input: CreateMediaLibraryInput): MediaLibrary {
    const id = `lib_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const now = this.now();
    const item: MediaLibrary = {
      id,
      accountId: input.accountId,
      name: input.name,
      libraryType: input.libraryType ?? "other",
      posterStyle: input.posterStyle ?? "poster",
      isPinned: input.isPinned ?? false,
      sortOrder: input.sortOrder ?? 0,
      defaultDeliveryMode: input.defaultDeliveryMode ?? "redirect",
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO media_libraries (
           id, account_id, name, library_type, poster_style,
           is_pinned, sort_order, default_delivery_mode, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.accountId,
        item.name,
        item.libraryType,
        item.posterStyle,
        item.isPinned ? 1 : 0,
        item.sortOrder,
        item.defaultDeliveryMode,
        item.createdAt,
        item.updatedAt,
      );

    return item;
  }

  updateLibrary(id: string, patch: UpdateMediaLibraryInput): MediaLibrary | null {
    const existing = this.getLibrary(id);
    if (!existing) return null;

    // 严格防篡改：影视库类型 (libraryType) 创建后绝对禁止修改，避免元数据拓扑冲突
    const { libraryType: _ignored, ...safePatch } = patch;

    const updated: MediaLibrary = {
      ...existing,
      ...safePatch,
      libraryType: existing.libraryType,
      updatedAt: this.now(),
    };

    this.db
      .prepare(
        `UPDATE media_libraries SET
           name = ?, poster_style = ?,
           is_pinned = ?, sort_order = ?, default_delivery_mode = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.posterStyle,
        updated.isPinned ? 1 : 0,
        updated.sortOrder,
        updated.defaultDeliveryMode,
        updated.updatedAt,
        id,
      );

    return updated;
  }

  deleteLibrary(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM media_libraries WHERE id = ?`).run(id);
    if (res.changes > 0) {
      // 级联清理绑定与媒体项
      this.db.prepare(`DELETE FROM library_path_bindings WHERE library_id = ?`).run(id);
      const items = this.db
        .prepare(`SELECT id FROM library_media_items WHERE library_id = ?`)
        .all(id) as Array<{ id: string }>;
      for (const item of items) {
        this.deleteMediaItem(item.id);
      }
      return true;
    }
    return false;
  }

  // ==================== 路径绑定 LibraryPathBinding ====================

  listPathBindings(libraryId: string): LibraryPathBinding[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM library_path_bindings WHERE library_id = ? ORDER BY created_at ASC`,
      )
      .all(libraryId) as Array<Record<string, unknown>>;
    return rows.map(this.mapBindingRow);
  }

  getAllPathBindings(): LibraryPathBinding[] {
    const rows = this.db
      .prepare(`SELECT * FROM library_path_bindings ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(this.mapBindingRow);
  }

  getPathBinding(id: string): LibraryPathBinding | null {
    const row = this.db
      .prepare(`SELECT * FROM library_path_bindings WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapBindingRow(row) : null;
  }

  createPathBinding(input: CreateLibraryPathBindingInput): LibraryPathBinding {
    const id = `bind_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const now = this.now();
    const item: LibraryPathBinding = {
      id,
      libraryId: input.libraryId,
      storageId: input.storageId,
      remoteFolderId: input.remoteFolderId,
      remotePath: input.remotePath,
      scheduledScanEnabled: input.scheduledScanEnabled ?? false,
      scanIntervalMinutes: input.scanIntervalMinutes ?? 360,
      scanCron: input.scanCron ?? null,
      scanMode: input.scanMode ?? "incremental_missing",
      minFileSizeMb: input.minFileSizeMb ?? 100,
      excludeKeywords: input.excludeKeywords ?? [],
      deliveryMode: input.deliveryMode ?? "inherit",
      lastScanAt: null,
      lastScanStatus: "idle",
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO library_path_bindings (
           id, library_id, storage_id, remote_folder_id, remote_path,
           scheduled_scan_enabled, scan_interval_minutes, scan_cron, scan_mode,
           min_file_size_mb, exclude_keywords, delivery_mode,
           last_scan_at, last_scan_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.libraryId,
        item.storageId,
        item.remoteFolderId,
        item.remotePath,
        item.scheduledScanEnabled ? 1 : 0,
        item.scanIntervalMinutes,
        item.scanCron,
        item.scanMode,
        item.minFileSizeMb,
        JSON.stringify(item.excludeKeywords),
        item.deliveryMode,
        item.lastScanAt,
        item.lastScanStatus,
        item.createdAt,
        item.updatedAt,
      );

    return item;
  }

  updatePathBinding(id: string, patch: UpdateLibraryPathBindingInput): LibraryPathBinding | null {
    const existing = this.getPathBinding(id);
    if (!existing) return null;

    const updated: LibraryPathBinding = {
      ...existing,
      ...patch,
      updatedAt: this.now(),
    };

    this.db
      .prepare(
        `UPDATE library_path_bindings SET
           remote_folder_id = ?, remote_path = ?, scheduled_scan_enabled = ?,
           scan_interval_minutes = ?, scan_cron = ?, scan_mode = ?,
           min_file_size_mb = ?, exclude_keywords = ?, delivery_mode = ?,
           last_scan_at = ?, last_scan_status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.remoteFolderId,
        updated.remotePath,
        updated.scheduledScanEnabled ? 1 : 0,
        updated.scanIntervalMinutes,
        updated.scanCron,
        updated.scanMode,
        updated.minFileSizeMb,
        JSON.stringify(updated.excludeKeywords),
        updated.deliveryMode,
        updated.lastScanAt,
        updated.lastScanStatus,
        updated.updatedAt,
        id,
      );

    return updated;
  }

  deletePathBinding(id: string): { success: boolean; deletedEpisodes: number; deletedItems: number } {
    return this.db.transaction(() => {
      const binding = this.getPathBinding(id);
      const libraryId = binding?.libraryId;

      // 1. 查找受到影响的主条目 ID
      const affectedItems = this.db
        .prepare(
          `SELECT DISTINCT s.media_item_id
           FROM library_episodes e
           JOIN library_seasons s ON e.season_id = s.id
           WHERE e.binding_id = ?`,
        )
        .all(id) as Array<{ media_item_id: string }>;

      // 2. 仅在本地 SQLite 数据库中级联删除该 binding_id 的所有分集条目 (绝对不触碰网盘物理文件)
      const epRes = this.db.prepare(`DELETE FROM library_episodes WHERE binding_id = ?`).run(id);

      // 3. 清理历史增量扫描快照与绑定记录本身
      this.db.prepare(`DELETE FROM library_scan_snapshots WHERE binding_id = ?`).run(id);
      const res = this.db.prepare(`DELETE FROM library_path_bindings WHERE id = ?`).run(id);

      // 4. 级联清理失去所有分集的孤儿季度
      this.db.prepare(`
        DELETE FROM library_seasons
        WHERE id NOT IN (SELECT DISTINCT season_id FROM library_episodes)
      `).run();

      // 5. 级联清理失去所有季度的孤儿影视主条目 (防止残留空白海报卡片)
      let deletedItemsCount = 0;
      for (const { media_item_id } of affectedItems) {
        const remaining = this.db
          .prepare(`SELECT COUNT(*) as count FROM library_seasons WHERE media_item_id = ?`)
          .get(media_item_id) as { count: number };
        if (remaining.count === 0) {
          this.db.prepare(`DELETE FROM library_media_items WHERE id = ?`).run(media_item_id);
          deletedItemsCount++;
        }
      }

      // 6. 若所属影视库已无任何剩余有效路径绑定，执行该库的全量垃圾回收 (Purge on Last Binding Removed)
      if (libraryId) {
        const remainingBindings = this.listPathBindings(libraryId);
        if (remainingBindings.length === 0) {
          const purged = this.purgeOrphanedLibraryItems(libraryId);
          deletedItemsCount += purged.deletedItems;
        }
      }

      return {
        success: res.changes > 0,
        deletedEpisodes: epRes.changes,
        deletedItems: deletedItemsCount,
      };
    })();
  }

  /**
   * 影视库孤儿数据与无源残留深度清理 (Garbage Collection / Purge)
   * 1. 若指定 libraryId 且该库无任何活跃路径绑定，清空该库全部媒体数据
   * 2. 全局层面：清理悬空分集、悬空季度与悬空主条目
   */
  purgeOrphanedLibraryItems(libraryId?: string): { deletedEpisodes: number; deletedSeasons: number; deletedItems: number } {
    return this.db.transaction(() => {
      let deletedEpisodes = 0;
      let deletedSeasons = 0;
      let deletedItems = 0;

      if (libraryId) {
        const bindings = this.listPathBindings(libraryId);
        if (bindings.length === 0) {
          const epRes = this.db
            .prepare(
              `DELETE FROM library_episodes
               WHERE season_id IN (
                 SELECT s.id FROM library_seasons s
                 JOIN library_media_items m ON s.media_item_id = m.id
                 WHERE m.library_id = ?
               )`,
            )
            .run(libraryId);
          deletedEpisodes += epRes.changes;

          const sRes = this.db
            .prepare(
              `DELETE FROM library_seasons
               WHERE media_item_id IN (
                 SELECT id FROM library_media_items WHERE library_id = ?
               )`,
            )
            .run(libraryId);
          deletedSeasons += sRes.changes;

          const mRes = this.db.prepare(`DELETE FROM library_media_items WHERE library_id = ?`).run(libraryId);
          deletedItems += mRes.changes;

          return { deletedEpisodes, deletedSeasons, deletedItems };
        }
      }

      // 全局无源孤儿清理
      const epClean = this.db
        .prepare(
          `DELETE FROM library_episodes
           WHERE binding_id != '' AND binding_id NOT IN (SELECT id FROM library_path_bindings)`,
        )
        .run();
      deletedEpisodes += epClean.changes;

      const sClean = this.db
        .prepare(
          `DELETE FROM library_seasons
           WHERE id NOT IN (SELECT DISTINCT season_id FROM library_episodes)`,
        )
        .run();
      deletedSeasons += sClean.changes;

      const mClean = this.db
        .prepare(
          `DELETE FROM library_media_items
           WHERE id NOT IN (SELECT DISTINCT media_item_id FROM library_seasons)`,
        )
        .run();
      deletedItems += mClean.changes;

      return { deletedEpisodes, deletedSeasons, deletedItems };
    })();
  }

  // ==================== 影视条目 LibraryMediaItem ====================

  listMediaItems(query: MediaItemListQuery): { items: LibraryMediaItem[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.libraryId) {
      conditions.push("library_id = ?");
      params.push(query.libraryId);
    }
    if (query.mediaType) {
      conditions.push("media_type = ?");
      params.push(query.mediaType);
    }
    if (query.reviewStatus) {
      conditions.push("review_status = ?");
      params.push(query.reviewStatus);
    }
    if (query.query && query.query.trim()) {
      conditions.push("(title LIKE ? OR original_title LIKE ?)");
      const term = `%${query.query.trim()}%`;
      params.push(term, term);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM library_media_items ${whereClause}`)
      .get(...params) as { count: number };

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT m.*,
           (SELECT COUNT(e.id) FROM library_episodes e JOIN library_seasons s ON e.season_id = s.id WHERE s.media_item_id = m.id) as version_count,
           (SELECT COUNT(DISTINCT (e.season_id || '_' || e.episode_number)) FROM library_episodes e JOIN library_seasons s ON e.season_id = s.id WHERE s.media_item_id = m.id) as total_episodes,
           (SELECT COUNT(DISTINCT s.id) FROM library_seasons s WHERE s.media_item_id = m.id) as season_count,
           (SELECT (COUNT(e.id) > COUNT(DISTINCT (e.season_id || '_' || e.episode_number))) FROM library_episodes e JOIN library_seasons s ON e.season_id = s.id WHERE s.media_item_id = m.id) as has_multi_version
         FROM library_media_items m ${whereClause.replace(/\blibrary_id\b/g, "m.library_id").replace(/\bmedia_type\b/g, "m.media_type").replace(/\breview_status\b/g, "m.review_status").replace(/\btitle\b/g, "m.title").replace(/\boriginal_title\b/g, "m.original_title")}
         ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      items: rows.map((r) => this.mapMediaItemRow(r)),
      total: totalRow.count,
    };
  }

  batchUpdateReviewStatus(itemIds: string[], status: MediaReviewStatus): number {
    if (itemIds.length === 0) return 0;
    const placeholders = itemIds.map(() => "?").join(",");
    const res = this.db
      .prepare(`UPDATE library_media_items SET review_status = ?, updated_at = ? WHERE id IN (${placeholders})`)
      .run(status, this.now(), ...itemIds);
    return res.changes;
  }

  batchDeleteMediaItems(itemIds: string[]): number {
    if (itemIds.length === 0) return 0;
    return this.db.transaction(() => {
      let count = 0;
      for (const id of itemIds) {
        if (this.deleteMediaItem(id)) {
          count++;
        }
      }
      return count;
    })();
  }

  getMediaItem(id: string): LibraryMediaItem | null {
    const row = this.db
      .prepare(`SELECT * FROM library_media_items WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapMediaItemRow(row) : null;
  }

  findMediaItemByTmdb(libraryId: string, tmdbId: number): LibraryMediaItem | null {
    const row = this.db
      .prepare(`SELECT * FROM library_media_items WHERE library_id = ? AND tmdb_id = ?`)
      .get(libraryId, tmdbId) as Record<string, unknown> | undefined;
    return row ? this.mapMediaItemRow(row) : null;
  }

  findMediaItemByTitleYear(libraryId: string, title: string, year?: number | null): LibraryMediaItem | null {
    if (year) {
      const row = this.db
        .prepare(`SELECT * FROM library_media_items WHERE library_id = ? AND title = ? AND release_year = ?`)
        .get(libraryId, title, year) as Record<string, unknown> | undefined;
      if (row) return this.mapMediaItemRow(row);
    }
    const fallback = this.db
      .prepare(`SELECT * FROM library_media_items WHERE library_id = ? AND title = ?`)
      .get(libraryId, title) as Record<string, unknown> | undefined;
    return fallback ? this.mapMediaItemRow(fallback) : null;
  }

  upsertMediaItem(input: UpsertLibraryMediaItemInput): LibraryMediaItem {
    const existing = this.getMediaItem(input.id);
    const now = this.now();

    // 若已锁定元数据，保护关键字段不被自动扫描覆盖
    if (existing && existing.isMetadataLocked) {
      const preserved: LibraryMediaItem = {
        ...existing,
        libraryId: input.libraryId,
        updatedAt: now,
      };
      this.db
        .prepare(`UPDATE library_media_items SET library_id = ?, updated_at = ? WHERE id = ?`)
        .run(preserved.libraryId, preserved.updatedAt, existing.id);
      return preserved;
    }

    const item: LibraryMediaItem = {
      id: input.id,
      libraryId: input.libraryId,
      tmdbId: fallbackVal(input.tmdbId, null),
      doubanId: fallbackVal(input.doubanId, null),
      mediaType: input.mediaType,
      title: input.title,
      originalTitle: fallbackVal(input.originalTitle, null),
      releaseYear: fallbackVal(input.releaseYear, null),
      overview: fallbackVal(input.overview, null),
      posterPath: fallbackVal(input.posterPath, null),
      backdropPath: fallbackVal(input.backdropPath, null),
      rating: fallbackVal(input.rating, 0),
      genres: fallbackVal(input.genres, []),
      isMetadataLocked: fallbackVal(input.isMetadataLocked, false),
      reviewStatus: fallbackVal(input.reviewStatus, "auto_accepted"),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO library_media_items (
           id, library_id, tmdb_id, douban_id, media_type, title,
           original_title, release_year, overview, poster_path, backdrop_path,
           rating, genres, is_metadata_locked, review_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           library_id = excluded.library_id,
           tmdb_id = excluded.tmdb_id,
           douban_id = excluded.douban_id,
           media_type = excluded.media_type,
           title = excluded.title,
           original_title = excluded.original_title,
           release_year = excluded.release_year,
           overview = excluded.overview,
           poster_path = excluded.poster_path,
           backdrop_path = excluded.backdrop_path,
           rating = excluded.rating,
           genres = excluded.genres,
           is_metadata_locked = excluded.is_metadata_locked,
           review_status = excluded.review_status,
           updated_at = excluded.updated_at`,
      )
      .run(
        item.id,
        item.libraryId,
        item.tmdbId,
        item.doubanId,
        item.mediaType,
        item.title,
        item.originalTitle,
        item.releaseYear,
        item.overview,
        item.posterPath,
        item.backdropPath,
        item.rating,
        JSON.stringify(item.genres),
        item.isMetadataLocked ? 1 : 0,
        item.reviewStatus,
        item.createdAt,
        item.updatedAt,
      );

    return item;
  }

  deleteMediaItem(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM library_media_items WHERE id = ?`).run(id);
    if (res.changes > 0) {
      const seasons = this.db
        .prepare(`SELECT id FROM library_seasons WHERE media_item_id = ?`)
        .all(id) as Array<{ id: string }>;
      for (const season of seasons) {
        this.db.prepare(`DELETE FROM library_episodes WHERE season_id = ?`).run(season.id);
      }
      this.db.prepare(`DELETE FROM library_seasons WHERE media_item_id = ?`).run(id);
      return true;
    }
    return false;
  }

  // ==================== 季度与集数 Seasons & Episodes ====================

  listSeasons(mediaItemId: string): LibrarySeason[] {
    const rows = this.db
      .prepare(`SELECT * FROM library_seasons WHERE media_item_id = ? ORDER BY season_number ASC`)
      .all(mediaItemId) as Array<Record<string, unknown>>;
    return rows.map(this.mapSeasonRow);
  }

  upsertSeason(input: UpsertLibrarySeasonInput): LibrarySeason {
    const item: LibrarySeason = {
      id: input.id,
      mediaItemId: input.mediaItemId,
      seasonNumber: input.seasonNumber,
      name: input.name || (input.seasonNumber === 0 ? "特别篇" : `第 ${input.seasonNumber} 季`),
      totalEpisodes: fallbackVal(input.totalEpisodes, 0),
      posterPath: fallbackVal(input.posterPath, null),
      airDate: fallbackVal(input.airDate, null),
    };

    this.db
      .prepare(
        `INSERT INTO library_seasons (
           id, media_item_id, season_number, name, total_episodes, poster_path, air_date
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           total_episodes = excluded.total_episodes,
           poster_path = excluded.poster_path,
           air_date = excluded.air_date`,
      )
      .run(
        item.id,
        item.mediaItemId,
        item.seasonNumber,
        item.name,
        item.totalEpisodes,
        item.posterPath,
        item.airDate,
      );

    return item;
  }

  listEpisodes(seasonId: string): LibraryEpisode[] {
    const rows = this.db
      .prepare(`SELECT * FROM library_episodes WHERE season_id = ? ORDER BY episode_number ASC`)
      .all(seasonId) as Array<Record<string, unknown>>;
    return rows.map(this.mapEpisodeRow);
  }

  getEpisode(id: string): LibraryEpisode | null {
    const row = this.db
      .prepare(`SELECT * FROM library_episodes WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapEpisodeRow(row) : null;
  }

  findEpisodeByStorageFile(storageId: string, fileId: string): LibraryEpisode | null {
    const row = this.db
      .prepare(`SELECT * FROM library_episodes WHERE storage_id = ? AND file_id = ?`)
      .get(storageId, fileId) as Record<string, unknown> | undefined;
    return row ? this.mapEpisodeRow(row) : null;
  }

  upsertEpisode(input: UpsertLibraryEpisodeInput): LibraryEpisode {
    const existing = this.getEpisode(input.id);
    const now = this.now();
    const item: LibraryEpisode = {
      id: input.id,
      seasonId: input.seasonId,
      bindingId: fallbackVal(input.bindingId, fallbackVal(existing?.bindingId, "")),
      episodeNumber: input.episodeNumber,
      episodeName: fallbackVal(input.episodeName, null),
      storageId: input.storageId,
      fileId: input.fileId,
      fileName: input.fileName,
      versionTag: fallbackVal(input.versionTag, fallbackVal(existing?.versionTag, null)),
      isDefaultVersion: fallbackVal(input.isDefaultVersion, fallbackVal(existing?.isDefaultVersion, false)),
      pickCode: fallbackVal(input.pickCode, null),
      sizeBytes: input.sizeBytes,
      videoCodec: fallbackVal(input.videoCodec, null),
      resolution: fallbackVal(input.resolution, null),
      durationSeconds: fallbackVal(input.durationSeconds, null),
      subtitles: fallbackVal(input.subtitles, []),
      relativePath: fallbackVal(input.relativePath, null),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO library_episodes (
           id, season_id, binding_id, episode_number, episode_name, storage_id, file_id,
           file_name, version_tag, is_default_version, pick_code, size_bytes, video_codec,
           resolution, duration_seconds, subtitles_json, relative_path, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           binding_id = CASE WHEN excluded.binding_id != '' THEN excluded.binding_id ELSE library_episodes.binding_id END,
           episode_number = excluded.episode_number,
           episode_name = excluded.episode_name,
           file_name = excluded.file_name,
           version_tag = excluded.version_tag,
           is_default_version = excluded.is_default_version,
           pick_code = excluded.pick_code,
           size_bytes = excluded.size_bytes,
           video_codec = excluded.video_codec,
           resolution = excluded.resolution,
           duration_seconds = excluded.duration_seconds,
           subtitles_json = excluded.subtitles_json,
           relative_path = excluded.relative_path,
           updated_at = excluded.updated_at`,
      )
      .run(
        item.id,
        item.seasonId,
        item.bindingId ?? "",
        item.episodeNumber,
        item.episodeName,
        item.storageId,
        item.fileId,
        item.fileName,
        item.versionTag ?? "",
        item.isDefaultVersion ? 1 : 0,
        item.pickCode,
        item.sizeBytes,
        item.videoCodec,
        item.resolution,
        item.durationSeconds,
        JSON.stringify(item.subtitles),
        item.relativePath,
        item.createdAt,
        item.updatedAt,
      );

    return item;
  }

  updateEpisodeFileName(id: string, newFileName: string): void {
    this.db
      .prepare(`UPDATE library_episodes SET file_name = ?, updated_at = ? WHERE id = ?`)
      .run(newFileName, this.now(), id);
  }

  // ==================== 增量快照 LibraryScanSnapshot ====================

  getScanSnapshot(bindingId: string, dirId: string): LibraryScanSnapshot | null {
    const row = this.db
      .prepare(`SELECT * FROM library_scan_snapshots WHERE binding_id = ? AND dir_id = ?`)
      .get(bindingId, dirId) as Record<string, unknown> | undefined;
    return row ? this.mapSnapshotRow(row) : null;
  }

  saveScanSnapshot(snapshot: LibraryScanSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO library_scan_snapshots (
           id, binding_id, dir_id, dir_name, dir_path, file_count, last_modified_hash, checked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           file_count = excluded.file_count,
           last_modified_hash = excluded.last_modified_hash,
           checked_at = excluded.checked_at`,
      )
      .run(
        snapshot.id,
        snapshot.bindingId,
        snapshot.dirId,
        snapshot.dirName,
        snapshot.dirPath,
        snapshot.fileCount,
        snapshot.lastModifiedHash,
        snapshot.checkedAt,
      );
  }

  // ==================== 行映射辅助函数 ====================

  private mapLibraryRow(row: Record<string, unknown>): MediaLibrary {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      name: String(row.name),
      libraryType: (row.library_type as MediaLibraryType) || "other",
      posterStyle: (row.poster_style as "poster" | "backdrop") || "poster",
      isPinned: Boolean(row.is_pinned),
      sortOrder: Number(row.sort_order ?? 0),
      defaultDeliveryMode: (row.default_delivery_mode as LibraryDeliveryMode) || "redirect",
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapBindingRow(row: Record<string, unknown>): LibraryPathBinding {
    let excludeKeywords: string[] = [];
    try {
      excludeKeywords = JSON.parse(String(row.exclude_keywords || "[]")) as string[];
    } catch {
      excludeKeywords = [];
    }

    return {
      id: String(row.id),
      libraryId: String(row.library_id),
      storageId: String(row.storage_id),
      remoteFolderId: String(row.remote_folder_id),
      remotePath: String(row.remote_path),
      scheduledScanEnabled: Boolean(row.scheduled_scan_enabled),
      scanIntervalMinutes: Number(row.scan_interval_minutes ?? 360),
      scanCron: row.scan_cron ? String(row.scan_cron) : null,
      scanMode: (row.scan_mode as LibraryScanMode) || "incremental_missing",
      minFileSizeMb: Number(row.min_file_size_mb ?? 100),
      excludeKeywords,
      deliveryMode: (row.delivery_mode as BindingDeliveryMode) || "inherit",
      lastScanAt: row.last_scan_at ? String(row.last_scan_at) : null,
      lastScanStatus: (row.last_scan_status as LibraryPathBinding["lastScanStatus"]) || "idle",
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapMediaItemRow(row: Record<string, unknown>): LibraryMediaItem {
    return {
      id: String(row.id),
      libraryId: String(row.library_id),
      tmdbId: parseNullableNum(row.tmdb_id),
      doubanId: parseNullableStr(row.douban_id),
      mediaType: (row.media_type as "movie" | "tv") || "movie",
      title: String(row.title),
      originalTitle: parseNullableStr(row.original_title),
      releaseYear: parseNullableNum(row.release_year),
      overview: parseNullableStr(row.overview),
      posterPath: parseNullableStr(row.poster_path),
      backdropPath: parseNullableStr(row.backdrop_path),
      rating: Number(row.rating || 0),
      genres: parseGenres(row.genres),
      isMetadataLocked: Boolean(row.is_metadata_locked),
      reviewStatus: (row.review_status as MediaReviewStatus) || "auto_accepted",
      versionCount: parseOptNum(row.version_count),
      totalEpisodes: parseOptNum(row.total_episodes),
      seasonCount: parseOptNum(row.season_count),
      hasMultiVersion: Boolean(row.has_multi_version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapSeasonRow(row: Record<string, unknown>): LibrarySeason {
    return {
      id: String(row.id),
      mediaItemId: String(row.media_item_id),
      seasonNumber: Number(row.season_number),
      name: String(row.name),
      totalEpisodes: Number(row.total_episodes ?? 0),
      posterPath: row.poster_path ? String(row.poster_path) : null,
      airDate: row.air_date ? String(row.air_date) : null,
    };
  }

  private mapEpisodeRow(row: Record<string, unknown>): LibraryEpisode {
    let subtitles: SubtitleTrackInfo[] = [];
    try {
      subtitles = JSON.parse(String(row.subtitles_json || "[]")) as SubtitleTrackInfo[];
    } catch {
      subtitles = [];
    }

    return {
      id: String(row.id),
      seasonId: String(row.season_id),
      bindingId: row.binding_id ? String(row.binding_id) : undefined,
      episodeNumber: Number(row.episode_number),
      episodeName: row.episode_name ? String(row.episode_name) : null,
      storageId: String(row.storage_id),
      fileId: String(row.file_id),
      fileName: String(row.file_name),
      versionTag: row.version_tag ? String(row.version_tag) : null,
      isDefaultVersion: Boolean(row.is_default_version),
      pickCode: row.pick_code ? String(row.pick_code) : null,
      sizeBytes: Number(row.size_bytes ?? 0),
      videoCodec: row.video_codec ? String(row.video_codec) : null,
      resolution: row.resolution ? String(row.resolution) : null,
      durationSeconds: row.duration_seconds ? Number(row.duration_seconds) : null,
      subtitles,
      relativePath: row.relative_path ? String(row.relative_path) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapSnapshotRow(row: Record<string, unknown>): LibraryScanSnapshot {
    return {
      id: String(row.id),
      bindingId: String(row.binding_id),
      dirId: String(row.dir_id),
      dirName: String(row.dir_name),
      dirPath: String(row.dir_path),
      fileCount: Number(row.file_count ?? 0),
      lastModifiedHash: String(row.last_modified_hash),
      checkedAt: String(row.checked_at),
    };
  }
}

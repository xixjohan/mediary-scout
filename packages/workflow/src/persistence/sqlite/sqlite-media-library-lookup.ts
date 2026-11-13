import type Database from "better-sqlite3";
import { BaseSqliteModule } from "../sqlite-context.js";

/**
 * 影视库跨表定位查询（独立成文件，避免撑大受棘轮约束的 sqlite-media-library.ts）。
 *
 * 背景：播放路由只拿到 episodeId，需要由 `seasonId` 反查所属影视库，
 * 才能读到 `media_libraries.default_delivery_mode`。旧实现误把
 * `listSeasons(mediaItemId)` 当成按 seasonId 查询并传入空串，导致
 * 库级投送策略永远读不到（详见 docs/research 2026-11-13 调研文档 §1.2）。
 */
export interface LibraryContextBySeason {
  seasonId: string;
  mediaItemId: string;
  libraryId: string;
}

export function findLibraryContextBySeasonId(
  host: BaseSqliteModule,
  seasonId: string,
): LibraryContextBySeason | null {
  const db = (host as unknown as { db: Database.Database }).db;
  const row = db
    .prepare(
      `SELECT s.id AS season_id, m.id AS media_item_id, l.id AS library_id
         FROM library_seasons s
         JOIN library_media_items m ON m.id = s.media_item_id
         JOIN media_libraries l ON l.id = m.library_id
        WHERE s.id = ?
        LIMIT 1`,
    )
    .get(seasonId) as
    | { season_id: string; media_item_id: string; library_id: string }
    | undefined;

  if (!row) return null;
  return {
    seasonId: String(row.season_id),
    mediaItemId: String(row.media_item_id),
    libraryId: String(row.library_id),
  };
}

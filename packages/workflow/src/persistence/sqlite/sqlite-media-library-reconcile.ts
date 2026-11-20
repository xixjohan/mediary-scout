import type { SqliteDbContext } from "../sqlite-context.js";

export interface ReconcileBindingEpisodesInput {
  bindingId: string;
  libraryId: string;
  discoveredFileIds: string[];
  strategy?: "soft_delete" | "strict_purge" | undefined;
  maxDeleteRate?: number | undefined;
  forceAllowEmptyCleanup?: boolean | undefined;
}

export interface ReconcileBindingEpisodesResult {
  status: "reconciled" | "circuit_broken" | "skipped";
  reason?: string | undefined;
  totalInDb: number;
  discoveredCount: number;
  orphanCount: number;
  markedMissingCount: number;
  purgedEpisodesCount: number;
  purgedSeasonsCount: number;
  purgedItemsCount: number;
  restoredCount: number;
}

export class SqliteMediaLibraryReconciler {
  constructor(private readonly ctx: SqliteDbContext) {}

  private get db() {
    return this.ctx.db;
  }

  private now(): string {
    return this.ctx.now();
  }

  /**
   * 影视库孤儿数据与无源残留深度清理 (Garbage Collection / Purge)
   * 1. 若指定 libraryId 且该库无任何活跃路径绑定，清空该库全部媒体数据
   * 2. 全局层面：清理悬空分集、悬空季度与悬空主条目
   */
  purgeOrphanedLibraryItems(libraryId?: string): {
    deletedEpisodes: number;
    deletedSeasons: number;
    deletedItems: number;
  } {
    return this.ctx.transaction(() => {
      let deletedEpisodes = 0;
      let deletedSeasons = 0;
      let deletedItems = 0;

      if (libraryId) {
        const bindingCount = (
          this.db
            .prepare("SELECT COUNT(*) AS count FROM library_path_bindings WHERE library_id = ?")
            .get(libraryId) as { count: number }
        ).count;

        if (bindingCount === 0) {
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

          const mRes = this.db
            .prepare(`DELETE FROM library_media_items WHERE library_id = ?`)
            .run(libraryId);
          deletedItems += mRes.changes;

          return { deletedEpisodes, deletedSeasons, deletedItems };
        }

        // 该库仍有绑定，仅级联清理该库内无分集的空季与无季度的空剧
        const sClean = this.db
          .prepare(
            `DELETE FROM library_seasons
             WHERE id NOT IN (SELECT DISTINCT season_id FROM library_episodes)
               AND media_item_id IN (SELECT id FROM library_media_items WHERE library_id = ?)`,
          )
          .run(libraryId);
        deletedSeasons += sClean.changes;

        const mClean = this.db
          .prepare(
            `DELETE FROM library_media_items
             WHERE id NOT IN (SELECT DISTINCT media_item_id FROM library_seasons)
               AND library_id = ?`,
          )
          .run(libraryId);
        deletedItems += mClean.changes;

        return { deletedEpisodes, deletedSeasons, deletedItems };
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

  /**
   * 基于内存临时表与差集运算的影视库孤儿分集比对与清理引擎
   */
  reconcileBindingEpisodes(input: ReconcileBindingEpisodesInput): ReconcileBindingEpisodesResult {
    const {
      bindingId,
      libraryId,
      discoveredFileIds,
      strategy = "strict_purge",
      maxDeleteRate = 0.3,
      forceAllowEmptyCleanup = false,
    } = input;

    return this.ctx.transaction((): ReconcileBindingEpisodesResult => {
      // 1. 创建事务级内存临时表并装载本次扫描到的全部有效 file_id
      this.db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS temp_discovered_files (
          file_id TEXT PRIMARY KEY
        );
        DELETE FROM temp_discovered_files;
      `);

      const insertStmt = this.db.prepare("INSERT OR IGNORE INTO temp_discovered_files (file_id) VALUES (?)");
      for (const fid of discoveredFileIds) {
        if (fid) insertStmt.run(fid);
      }

      // 2. 统计当前 binding 下的数据库现有有效分集总量
      const totalInDb = (
        this.db.prepare("SELECT COUNT(*) AS count FROM library_episodes WHERE binding_id = ?").get(bindingId) as {
          count: number;
        }
      ).count;

      // 3. 筛选出网盘已缺失的孤儿分集
      const orphanRows = this.db
        .prepare(
          `SELECT e.id, e.season_id, e.file_id, e.file_name, e.relative_path, e.status
           FROM library_episodes e
           LEFT JOIN temp_discovered_files t ON e.file_id = t.file_id
           WHERE e.binding_id = ? AND t.file_id IS NULL`,
        )
        .all(bindingId) as Array<{
          id: string;
          season_id: string;
          file_id: string;
          file_name: string;
          relative_path: string | null;
          status: string;
        }>;

      const orphanCount = orphanRows.length;
      const discoveredCount = discoveredFileIds.length;

      // 4. 三重安全熔断评估
      if (discoveredCount === 0 && totalInDb > 0 && !forceAllowEmptyCleanup) {
        this.db.exec("DELETE FROM temp_discovered_files;");
        return {
          status: "circuit_broken" as const,
          reason: "EMPTY_DISCOVERY_BLOCKED: 远端遍历结果为 0，触发空盘防清空熔断保护",
          totalInDb,
          discoveredCount,
          orphanCount,
          markedMissingCount: 0,
          purgedEpisodesCount: 0,
          purgedSeasonsCount: 0,
          purgedItemsCount: 0,
          restoredCount: 0,
        };
      }

      if (totalInDb >= 10 && !forceAllowEmptyCleanup) {
        const deleteRate = orphanCount / totalInDb;
        if (deleteRate > maxDeleteRate) {
          this.db.exec("DELETE FROM temp_discovered_files;");
          return {
            status: "circuit_broken" as const,
            reason: `HIGH_PRUNE_RATE_BLOCKED: 待清理比例 ${(deleteRate * 100).toFixed(1)}% 超过安全阈值 ${(maxDeleteRate * 100).toFixed(1)}% (${orphanCount}/${totalInDb})`,
            totalInDb,
            discoveredCount,
            orphanCount,
            markedMissingCount: 0,
            purgedEpisodesCount: 0,
            purgedSeasonsCount: 0,
            purgedItemsCount: 0,
            restoredCount: 0,
          };
        }
      }

      const now = this.now();

      // 5. 自动恢复重新出现的有效分集（若之前被标记为 missing）
      const restoreRes = this.db
        .prepare(
          `UPDATE library_episodes
           SET status = 'active', missing_since = NULL, last_seen_at = ?, updated_at = ?
           WHERE binding_id = ?
             AND file_id IN (SELECT file_id FROM temp_discovered_files)
             AND status != 'active'`,
        )
        .run(now, now, bindingId);
      const restoredCount = restoreRes.changes;

      // 同时更新当前依然有效的活跃分集的 last_seen_at
      this.db
        .prepare(
          `UPDATE library_episodes
           SET last_seen_at = ?
           WHERE binding_id = ? AND file_id IN (SELECT file_id FROM temp_discovered_files)`,
        )
        .run(now, bindingId);

      let markedMissingCount = 0;
      let purgedEpisodesCount = 0;
      let purgedSeasonsCount = 0;
      let purgedItemsCount = 0;

      // 6. 执行清理策略
      if (orphanCount > 0) {
        if (strategy === "soft_delete") {
          const softRes = this.db
            .prepare(
              `UPDATE library_episodes
               SET status = 'missing', missing_since = COALESCE(missing_since, ?), updated_at = ?
               WHERE binding_id = ? AND file_id NOT IN (SELECT file_id FROM temp_discovered_files)`,
            )
            .run(now, now, bindingId);
          markedMissingCount = softRes.changes;
        } else {
          // strict_purge: 物理清除孤儿分集并级联修剪空季与空剧
          const delRes = this.db
            .prepare(
              `DELETE FROM library_episodes
               WHERE binding_id = ? AND file_id NOT IN (SELECT file_id FROM temp_discovered_files)`,
            )
            .run(bindingId);
          purgedEpisodesCount = delRes.changes;

          // 级联修剪孤儿季度与孤儿主条目
          const cascadeRes = this.purgeOrphanedLibraryItems(libraryId);
          purgedSeasonsCount = cascadeRes.deletedSeasons;
          purgedItemsCount = cascadeRes.deletedItems;
        }
      }

      this.db.exec("DELETE FROM temp_discovered_files;");

      return {
        status: "reconciled" as const,
        totalInDb,
        discoveredCount,
        orphanCount,
        markedMissingCount,
        purgedEpisodesCount,
        purgedSeasonsCount,
        purgedItemsCount,
        restoredCount,
      };
    })();
  }
}

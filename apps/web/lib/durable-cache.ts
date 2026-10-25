import {
  openSqliteJsonCache,
  sqliteDbPathFromEnv,
  type SqliteJsonCache,
} from "@media-track/workflow";

/**
 * 纯 SQLite 单引擎的共享落盘点（任务单 S1.4b）。
 *
 * 刻意**不 import 任何 node: 内置**（fs/path）：本模块在客户端组件的
 * 服务端动作链上可达（update-actions.tsx → app/update-actions.ts →
 * update-view-server → workflow-runtime → 此处），node: 内置会把 Turbopack
 * 的客户端 chunk 构建炸掉（S4.3 实测回归）。文件系统操作已收进
 * @media-track/workflow 的 openSqliteJsonCache。
 */

export { DEFAULT_SQLITE_DB_PATH, sqliteDbPathFromEnv } from "@media-track/workflow";

/** 进程实际使用的 SQLite 路径（env 优先，默认 data/mediary.db）。 */
export function sqliteDbPath(): string {
  return sqliteDbPathFromEnv(process.env);
}

let cache: SqliteJsonCache | null = null;

/** 进程内单例的持久化 JSON 缓存（TMDB 搜索 + 剧集目标 L2）。 */
export function getDurableJsonCache(): SqliteJsonCache {
  if (!cache) {
    cache = openSqliteJsonCache(sqliteDbPathFromEnv(process.env));
  }
  return cache;
}

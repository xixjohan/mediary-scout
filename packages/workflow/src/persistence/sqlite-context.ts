import type Database from "better-sqlite3";

/**
 * SQLite 共享数据库上下文
 *
 * 保证所有领域模块仓储共享同一个底层 better-sqlite3 句柄与事务隔离边界。
 */
export interface SqliteDbContext {
  readonly db: Database.Database;
  readonly now: () => string;
  transaction<T>(fn: () => T): () => T;
}

export abstract class BaseSqliteModule {
  constructor(protected readonly ctx: SqliteDbContext) {}

  protected get db(): Database.Database {
    return this.ctx.db;
  }

  protected get now(): () => string {
    return this.ctx.now;
  }
}

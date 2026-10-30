import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteWorkflowRepository } from "../../src/persistence/sqlite.js";

/**
 * 黄金 PRAGMA 四件套（任务单 S1.3，规约见
 * docs/architecture-remediation-and-governance.md §1.3）：
 * journal_mode=WAL / synchronous=NORMAL / busy_timeout=5000 /
 * temp_store=MEMORY / cache_size=-64000(64MB) / foreign_keys=ON。
 * 任一项缺失都会让高并发抓取/转存遭遇 SQLITE_BUSY 或拖慢写路径。
 */
describe("SqliteWorkflowRepository PRAGMA 规约", () => {
  it("连接初始化即强制黄金参数", () => {
    const db = new Database(":memory:");
    new SqliteWorkflowRepository(db);

    expect(db.pragma("synchronous", { simple: true })).toBe(1); // 1 = NORMAL
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.pragma("temp_store", { simple: true })).toBe(2); // 2 = MEMORY
    expect(db.pragma("cache_size", { simple: true })).toBe(-64000); // 64MB
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

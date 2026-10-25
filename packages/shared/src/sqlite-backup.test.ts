import { mkdtempSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupSqliteDatabase,
  verifySqliteBackup,
  compareSqliteBackup,
  restoreSqliteBackup,
} from "./sqlite-backup.js";

/**
 * 备份/恢复演练（任务单 S4.4，P20：缺乏生产级容灾备份）。
 * 核心属性：**WAL 模式下备份必须包含已提交但还在 -wal 里的数据**——
 * 这正是 VACUUM INTO（而非裸拷贝）存在的理由，也是本测试钉死的东西。
 */
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sqlite-backup-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(path: string, rows: number): void {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
  const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
  for (let i = 0; i < rows; i += 1) insert.run(`row-${i}`);
  // 不 close：让数据留在 WAL 里，模拟运行中的服务
}

describe("sqlite-backup", () => {
  it("备份包含 WAL 里未合并的已提交数据（一致性快照）", () => {
    const dir = tmp();
    const src = join(dir, "live.db");
    const dst = join(dir, "backup.db");
    seed(src, 500);

    backupSqliteDatabase(src, dst);
    // 源库还开着（WAL 未 checkpoint），备份必须仍有全部 500 行
    const backup = new Database(dst, { readonly: true });
    expect(backup.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 500 });
    backup.close();
  });

  it("verifySqliteBackup：integrity ok + 每表行数", () => {
    const dir = tmp();
    const src = join(dir, "live.db");
    const dst = join(dir, "backup.db");
    seed(src, 42);
    backupSqliteDatabase(src, dst);

    const report = verifySqliteBackup(dst);
    expect(report.integrity).toBe("ok");
    expect(report.tables).toBeGreaterThanOrEqual(1);
    expect(report.rowCounts.t).toBe(42);
  });

  it("compareSqliteBackup：行数一致为 true，缺表/少行为 false", () => {
    const dir = tmp();
    const src = join(dir, "live.db");
    const dst = join(dir, "backup.db");
    seed(src, 10);
    backupSqliteDatabase(src, dst);
    expect(compareSqliteBackup(src, dst)).toBe(true);

    // 备份后再往源库插数据 → 不一致
    const db = new Database(src);
    db.prepare("INSERT INTO t (v) VALUES ('extra')").run();
    db.close();
    expect(compareSqliteBackup(src, dst)).toBe(false);
  });

  it("restoreSqliteBackup：恢复到新路径后可正常打开查询", () => {
    const dir = tmp();
    const src = join(dir, "live.db");
    const dst = join(dir, "backup.db");
    const restored = join(dir, "restored.db");
    seed(src, 7);
    backupSqliteDatabase(src, dst);

    restoreSqliteBackup(dst, restored);
    expect(existsSync(restored)).toBe(true);
    const db = new Database(restored, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 7 });
    db.close();
  });

  it("备份目标已存在时明确报错（VACUUM INTO 语义，防静默跳过）", () => {
    const dir = tmp();
    const src = join(dir, "live.db");
    const dst = join(dir, "backup.db");
    seed(src, 1);
    copyFileSync(src, dst); // 预占目标
    expect(() => backupSqliteDatabase(src, dst)).toThrow();
  });

  it("损坏的备份被 verify 识别（integrity 不为 ok）", () => {
    const dir = tmp();
    const dst = join(dir, "corrupt.db");
    // 造一个能打开但损坏的库：建表后往文件中间写垃圾
    const db = new Database(dst);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO t (v) VALUES ('x')").run();
    db.close();
    const buf = require("node:fs").readFileSync(dst);
    buf.write("GARBAGE", 100);
    require("node:fs").writeFileSync(dst, buf);
    const report = verifySqliteBackup(dst);
    expect(report.integrity).not.toBe("ok");
  });
});

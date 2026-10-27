/**
 * SQLite 备份 / 恢复 / 演练（任务单 S4.4，P20：生产级容灾备份）。
 *
 * 为什么用 VACUUM INTO 而不是拷贝文件：WAL 模式下已提交的数据可能还在
 * `-wal` 里没合并进主库，裸拷贝会丢最近提交。VACUUM INTO 由 SQLite 引擎
 * 生成一致性快照，等价于 Postgres 的 pg_dump 语义。
 */
import { createNativeRequire } from "./native-require.js";
// node:fs 同样不静态 import：本模块经 shared barrel 被客户端可达链 import，静态
// node:fs 会把 Turbopack 客户端 chunk 炸掉（与 credential-crypto 的 S4.3 同一条）。
type FsLike = typeof import("node:fs");
function fs(): FsLike {
  return requireNative("node:fs") as FsLike;
}

/** 调用时 require better-sqlite3（与 credential-crypto 同模式）：不让原生模块
 *  进入静态模块图——客户端可达链上一旦静态引入 node: 内置就会炸 Turbopack。 */
// createRequire 不静态 import：见 native-require.ts。静态 import 会让 node:module 进入
// 客户端可达的 chunk，Turbopack 直接拒掉整个生产构建。
const requireNative = createNativeRequire(import.meta.url);
type BetterSqlite3 = typeof import("better-sqlite3");
function loadDatabase(): BetterSqlite3 {
  return requireNative("better-sqlite3") as BetterSqlite3;
}

export interface BackupVerification {
  /** PRAGMA integrity_check 结果；"ok" = 完好 */
  integrity: string;
  /** 备份里的表数 */
  tables: number;
  /** 每表行数（备份内容的可读证据） */
  rowCounts: Record<string, number>;
  bytes: number;
}

/** 生成一致性备份。目标已存在则报错（VACUUM INTO 语义，防静默跳过）。 */
export function backupSqliteDatabase(sourcePath: string, targetPath: string): void {
  if (fs().existsSync(targetPath)) {
    throw new Error(`backup target already exists: ${targetPath} (VACUUM INTO refuses to overwrite)`);
  }
  const Database = loadDatabase();
  const db = new Database(sourcePath, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/**
 * 校验备份完好且列出内容规模（恢复演练的读数）。
 * 打不开/损坏的备份**报告**而非崩溃——演练的价值就在于把坏备份指出来。
 */
export function verifySqliteBackup(backupPath: string): BackupVerification {
  let db: InstanceType<ReturnType<typeof loadDatabase>>;
  try {
    const Database = loadDatabase();
    db = new Database(backupPath, { readonly: true });
  } catch (error) {
    return {
      integrity: `unopenable: ${error instanceof Error ? error.message : String(error)}`,
      tables: 0,
      rowCounts: {},
      bytes: fs().existsSync(backupPath) ? fs().statSync(backupPath).size : 0,
    };
  }
  try {
    const integrity = (db.pragma("quick_check", { simple: true }) as string) ?? "unknown";
    const tables = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get() as { n: number };
    const rowCounts: Record<string, number> = {};
    for (const row of db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>) {
      rowCounts[row.name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${row.name}"`).get() as { n: number }).n;
    }
    return { integrity, tables: tables.n, rowCounts, bytes: fs().statSync(backupPath).size };
  } catch (error) {
    // 能打开但已损坏（quick_check/行数查询抛错）——报告，不崩溃。
    return {
      integrity: `corrupt: ${error instanceof Error ? error.message : String(error)}`,
      tables: 0,
      rowCounts: {},
      bytes: fs().statSync(backupPath).size,
    };
  } finally {
    db.close();
  }
}

/** 备份与源库逐表行数比对（恢复演练的断言核心）。 */
export function compareSqliteBackup(sourcePath: string, backupPath: string): boolean {
  const source = verifySqliteBackup(sourcePath);
  const backup = verifySqliteBackup(backupPath);
  const sourceKeys = Object.keys(source.rowCounts).sort();
  const backupKeys = Object.keys(backup.rowCounts).sort();
  if (sourceKeys.join(",") !== backupKeys.join(",")) return false;
  return sourceKeys.every((key) => source.rowCounts[key] === backup.rowCounts[key]);
}

/** 把备份恢复到一个新路径（调用方负责停机/替换原库）。 */
export function restoreSqliteBackup(backupPath: string, targetPath: string): void {
  fs().copyFileSync(backupPath, targetPath);
}

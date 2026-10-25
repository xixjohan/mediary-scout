#!/usr/bin/env node
/**
 * 恢复演练（任务单 S4.4，P20）：证明备份真的能恢复。
 * 用法（仓库根）：
 *   node scripts/sqlite-restore-drill.mjs <backup.db|backup.db.gz> [--source <live.db>]
 *
 * 做三件事：解压（.gz）→ 校验（integrity + 每表行数）→ 与源库逐表比对
 * （给了 --source 时）。任一环节不过即退出码 1——备份不可恢复必须大声失败。
 */
import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifySqliteBackup,
  compareSqliteBackup,
} from "@media-track/shared";

const args = process.argv.slice(2);
const backupArg = args.find((a) => !a.startsWith("--"));
const sourceIdx = args.indexOf("--source");
const sourcePath = sourceIdx === -1 ? null : args[sourceIdx + 1];

if (!backupArg) {
  console.error("usage: node scripts/sqlite-restore-drill.mjs <backup.db[.gz]> [--source <live.db>]");
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), "restore-drill-"));
try {
  // 1) 解压
  let dbPath = backupArg;
  if (backupArg.endsWith(".gz")) {
    dbPath = join(tmp, "drill.db");
    writeFileSync(dbPath, gunzipSync(readFileSync(backupArg)));
    console.log(`解压 → ${dbPath}`);
  }

  // 2) 校验
  const report = verifySqliteBackup(dbPath);
  console.log(`integrity: ${report.integrity}`);
  console.log(`tables: ${report.tables}, bytes: ${report.bytes}`);
  for (const [table, rows] of Object.entries(report.rowCounts)) {
    console.log(`  ${table}: ${rows} rows`);
  }
  if (report.integrity !== "ok") {
    console.error("✗ 备份损坏，不可恢复");
    process.exit(1);
  }

  // 3) 与源库比对（可选）
  if (sourcePath) {
    const same = compareSqliteBackup(sourcePath, dbPath);
    console.log(same ? "✓ 与源库行数一致" : "✗ 与源库行数不一致（源库在备份后有写入？）");
    if (!same) process.exit(1);
  }

  console.log("✓ 恢复演练通过：备份完好且可读");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

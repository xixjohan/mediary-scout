#!/usr/bin/env node
/**
 * 巡影 · SQLite 数据库持久化单源性与测试内存隔离质量门禁 (tools/gates/check-db-persistence-parity.mjs)
 *
 * 守护契约：
 *   1. [Canonical-Default-Db-Path] packages/workflow 中的默认数据库路径必须统一指向 data/mediary.db；
 *   2. [Vitest-Test-Db-Memory-Isolation] vitest.config.ts 必须在 test.env 中显式注入 MEDIA_TRACK_SQLITE_PATH=":memory:"，
 *      杜绝任何单元测试在中途回退或穿透写入宿主机真实数据文件；
 *   3. [Dev-Runner-Db-Path-Parity] tools/runner/dev-server.mjs 必须支持从环境变量读取路径并优先对齐标准 data/mediary.db，
 *      消除 run/mediary.db 与 data/mediary.db 之间的“裂脑”数据库与网盘/订阅假丢失现象；
 *   4. [Dockerfile-Volume-Alignment] Dockerfile.dev / Dockerfile 中的容器数据库路径必须统一声明为 /app/data/mediary.db。
 *
 * 退出码: 0 = 通过, 1 = 发现违规
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");

export function analyzeDbPersistenceParity() {
  const violations = [];

  // 1. 检查 packages/workflow/src/persistence/sqlite-json-cache.ts 中的默认路径
  const cachePath = join(root, "packages/workflow/src/persistence/sqlite-json-cache.ts");
  if (existsSync(cachePath)) {
    const src = readFileSync(cachePath, "utf8");
    if (!src.includes('DEFAULT_SQLITE_DB_PATH = "data/mediary.db"')) {
      violations.push({
        file: "packages/workflow/src/persistence/sqlite-json-cache.ts",
        rule: "Canonical-Default-Db-Path",
        message: 'DEFAULT_SQLITE_DB_PATH 必须严格等于 "data/mediary.db"，保持全栈单一真相来源。',
      });
    }
  }

  // 2. 检查 vitest.config.ts 中的测试环境内存隔离
  const vitestConfigPath = join(root, "vitest.config.ts");
  if (existsSync(vitestConfigPath)) {
    const src = readFileSync(vitestConfigPath, "utf8");
    const hasMemoryEnv =
      src.includes('MEDIA_TRACK_SQLITE_PATH: ":memory:"') ||
      src.includes("MEDIA_TRACK_SQLITE_PATH: ':memory:'");
    if (!hasMemoryEnv) {
      violations.push({
        file: "vitest.config.ts",
        rule: "Vitest-Test-Db-Memory-Isolation",
        message:
          'vitest.config.ts 必须在 test.env 中配置 MEDIA_TRACK_SQLITE_PATH: ":memory:"，确保测试套件严禁触碰或清空真实磁盘数据库。',
      });
    }
  }

  // 3. 检查 tools/runner/dev-server.mjs 数据库路径解析
  const devServerPath = join(root, "tools/runner/dev-server.mjs");
  if (existsSync(devServerPath)) {
    const src = readFileSync(devServerPath, "utf8");
    if (!src.includes("data/mediary.db")) {
      violations.push({
        file: "tools/runner/dev-server.mjs",
        rule: "Dev-Runner-Db-Path-Parity",
        message: "tools/runner/dev-server.mjs 必须优先检测并支持标准 data/mediary.db 路径，杜绝本地裂脑数据库。",
      });
    }
  }

  // 4. 检查 Dockerfile.dev 环境变量
  const dockerDevPath = join(root, "Dockerfile.dev");
  if (existsSync(dockerDevPath)) {
    const src = readFileSync(dockerDevPath, "utf8");
    if (!src.includes("MEDIA_TRACK_SQLITE_PATH=/app/data/mediary.db")) {
      violations.push({
        file: "Dockerfile.dev",
        rule: "Dockerfile-Volume-Alignment",
        message: "Dockerfile.dev 必须设置 ENV MEDIA_TRACK_SQLITE_PATH=/app/data/mediary.db，与生产卷结构保持一致。",
      });
    }
  }

  // 5. 检查 credential.key 密钥一致性与防裂脑防解密失败
  const dataKeyPath = join(root, "data/credential.key");
  const runKeyPath = join(root, "run/credential.key");
  let activeKeyHex = "";
  if (existsSync(dataKeyPath)) {
    const dataKeyContent = readFileSync(dataKeyPath, "utf8").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(dataKeyContent)) {
      violations.push({
        file: "data/credential.key",
        rule: "Credential-Key-Format",
        message: "data/credential.key 必须为标准的 64 位十六进制 AES-256 密钥。",
      });
    } else {
      activeKeyHex = dataKeyContent.toLowerCase();
    }
  }
  if (existsSync(runKeyPath) && activeKeyHex) {
    const runKeyContent = readFileSync(runKeyPath, "utf8").trim().toLowerCase();
    if (runKeyContent !== activeKeyHex) {
      violations.push({
        file: "run/credential.key",
        rule: "Credential-Key-Parity",
        message: "run/credential.key 与 data/credential.key 发生裂脑漂移！必须保持完全一致，防止网盘凭证与加密设置解密失败。",
      });
    }
  }

  return violations;
}

export function runCheck() {
  console.log(`\n🔍 [gate:db-parity] 开始检查 SQLite 数据库持久化单源性与测试环境隔离契约...`);
  const violations = analyzeDbPersistenceParity();
  if (violations.length > 0) {
    console.error(`💥 [gate:db-parity] 检查失败：发现 ${violations.length} 处数据库配置漂移违规！`);
    for (const v of violations) {
      console.error(`  ❌ [${v.rule}] ${v.file}`);
      console.error(`     ${v.message}\n`);
    }
    return 1;
  }

  console.log(`✅ [gate:db-parity] 检查通过：数据库路径单源性规范一致，测试环境已严格实行内存隔离！\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runCheck());
}

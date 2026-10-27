#!/usr/bin/env node
/**
 * L0 物理所有权门禁（任务单 S4.1，治理文档 §6.2）：
 *   1. packages/* 与 apps/* 下的每个目录都是已声明 workspace（有 package.json）
 *      ——抓住裸奔目录（建了文件夹忘了登记，或复制粘贴的残留）；
 *   2. 每个 workspace 包都有 package.json + tsconfig.json；
 *   3. 仓库根目录只允许已知配置文件存在——抓住误提交到根的孤儿文件。
 *
 * 退出码 0 = 通过；1 = 有违规（逐条打印）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 根目录允许出现的文件（配置/文档/锁文件）。其余一律视为孤儿。 */
const ROOT_ALLOWLIST = new Set([
  ".dockerignore", ".env.example", ".eslintignore", ".gitignore", ".gitattributes",
  ".dependency-cruiser.cjs", ".dependency-cruiser-known-violations.json",
  "eslint-suppressions.json",
  "Dockerfile", "LICENSE", "README.md", "README.en.md", "SKILL.md",
  "package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts",
  "eslint.config.mjs", "docker-compose.yml", "requirements.txt",
]);
const ROOT_DIR_ALLOWLIST = new Set([
  ".git", ".github", ".claude", ".next", ".venv", "node_modules", "dist",
  "apps", "packages", "workers", "scripts", "docs", "site", "updater",
  "deploy", "references", "release-notes", "skills", "tests", "data", "backups",
  "e2e", // Playwright E2E（S4.3）
  "e2e-run", "test-results", "playwright-report", // E2E 运行时产物（gitignored）
  "tools", // 构建/门禁工具脚本（S5.4 的 eslint 本地规则与其单测）
]);

const problems = [];

// 1a) packages/* 与 apps/*：npm workspace——必须有 package.json（+ name），
//     有 TS 源码的必须有 tsconfig.json。
for (const group of ["packages", "apps"]) {
  const groupDir = join(root, group);
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      problems.push(`${group}/${entry.name}: 顶层出现裸文件（workspace 目录只放包）`);
      continue;
    }
    const pkgDir = join(groupDir, entry.name);
    if (!existsSync(join(pkgDir, "package.json"))) {
      problems.push(`${group}/${entry.name}: 缺少 package.json——未登记的 workspace 目录`);
      continue;
    }
    const hasTs = existsSync(join(pkgDir, "tsconfig.json"));
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    if (!pkg.name) problems.push(`${group}/${entry.name}: package.json 缺少 name`);
    if (!hasTs && existsSync(join(pkgDir, "src"))) {
      problems.push(`${group}/${entry.name}: 有 src/ 但缺 tsconfig.json`);
    }
  }
}

// 1b) workers/*：Cloudflare Worker——故意不是 npm workspace（各自部署），
//     所有权标记是 wrangler.jsonc。
{
  const groupDir = join(root, "workers");
  if (existsSync(groupDir)) {
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        problems.push(`workers/${entry.name}: 顶层出现裸文件（只放 Worker）`);
        continue;
      }
      if (!existsSync(join(groupDir, entry.name, "wrangler.jsonc"))) {
        problems.push(`workers/${entry.name}: 缺少 wrangler.jsonc——未登记的 Cloudflare Worker`);
      }
    }
  }
}

// 2) 根目录孤儿文件
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    if (!ROOT_DIR_ALLOWLIST.has(entry.name)) {
      problems.push(`根目录出现未登记目录: ${entry.name}/`);
    }
  } else if (!ROOT_ALLOWLIST.has(entry.name)) {
    problems.push(`根目录出现孤儿文件: ${entry.name}`);
  }
}

// 3) 根 package.json 的 workspaces 与实际目录一致
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = new Set(rootPkg.workspaces ?? []);
for (const group of ["packages", "apps"]) {
  const groupDir = join(root, group);
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!declared.has(`${group}/*`)) {
      problems.push(`package.json workspaces 未覆盖 ${group}/*`);
    }
  }
}

if (problems.length > 0) {
  console.error(`L0 布局违规 ${problems.length} 处:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("L0 布局检查通过");

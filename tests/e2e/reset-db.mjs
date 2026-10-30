#!/usr/bin/env node
/**
 * E2E 前置：清掉上一次运行留下的 SQLite（含 WAL/SHM）。由 playwright.config.ts
 * 的 webServer.command 在 `next start` 之前调用——不能放 globalSetup：Playwright
 * 的任务顺序是「plugin setup（webServer 启动）→ globalSetup」，那时服务已经
 * 打开并按 demo seed 写完库了，再删会让运行中的服务对着一个被删的 inode 工作
 * （2026-10-27 实测：两轮全红）。
 *
 * 为什么必须清：e2e-run/mediary-e2e.db 跨运行存活，而「获取回路」spec 断言
 * 搜索「翘楚」后出现「获取」按钮——上一轮跑完该片名已进 tracked_seasons，
 * 按钮变成「已追踪」，下一轮无改动也必红。配置注释本就宣称「全确定性 fake
 * 栈」，持久化 DB 与这句话矛盾。
 *
 * 只删 DB 三件套，不碰 credential.key（app_settings 的加密密钥）。
 */
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 相对本文件定位仓库根：playwright 的 webServer.command 以配置目录（e2e/）为
// cwd 执行，用 process.cwd() 会拼出 e2e/e2e/... 这种幽灵路径（实测踩过）。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dbPath = resolve(repoRoot, process.env.E2E_SQLITE_PATH ?? "./e2e-run/mediary-e2e.db");
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}

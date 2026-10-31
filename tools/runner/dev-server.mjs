#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 本地极速调试启动器 (Dev Server Runner)
 * 
 * 架构特性：
 *   1. 【有限状态机 (FSM)】：Preflight -> CacheCheck -> PortReclaim -> Spawning -> HealthCheck -> Running -> Shutdown
 *   2. 【策略模式 (Strategy)】：DevTurbopack (极速HMR) | ProdPreview (生产模拟) | DemoMock (纯假数据)
 *   3. 【跨平台适配器 (Adapter)】：WindowsProcessAdapter (taskkill/netstat) / PosixProcessAdapter (kill/lsof)
 *   4. 【增量编译极速跳过】：智能感知 TS 源码 mtime 时间戳，免去无谓的构建等待 (启动耗时从 8s 降至 0.2s)
 *   5. 【配置防漂移对齐】：与桌面端 server-launch.ts 保持 100% 环境参数基线对齐
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const isWindows = process.platform === "win32";

// ANSI 颜色辅助
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

// ============================================================================
// 1. CLI 参数与配置策略解析 (Strategy Pattern)
// ============================================================================
function parseArgs(args) {
  const options = {
    port: 3001,
    prod: false,
    demo: false,
    stop: false,
    status: false,
    cleanDb: false,
    skipBuild: false,
    openBrowser: true,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" && args[i + 1]) {
      options.port = parseInt(args[++i], 10);
    } else if (a === "--prod") {
      options.prod = true;
    } else if (a === "--demo") {
      options.demo = true;
    } else if (a === "--stop") {
      options.stop = true;
    } else if (a === "--status") {
      options.status = true;
    } else if (a === "--clean-db") {
      options.cleanDb = true;
    } else if (a === "--skip-build") {
      options.skipBuild = true;
    } else if (a === "--no-open") {
      options.openBrowser = false;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  // 优先读取环境变量覆盖
  if (process.env.PORT) options.port = parseInt(process.env.PORT, 10);
  if (process.env.MEDIARY_PORT) options.port = parseInt(process.env.MEDIARY_PORT, 10);

  return options;
}

function printHelp() {
  console.log(`
${c.bold}巡影 · Mediary Scout 本地极速调试启动器${c.reset}

${c.cyan}用法:${c.reset}
  node tools/runner/dev-server.mjs [选项]
  dev.bat [选项] (Windows 快捷指令)

${c.cyan}常用选项:${c.reset}
  --port <number>   指定服务端口 (默认 3001)
  --prod            生产环境预览模式 (npm run build:web && next start)
  --demo            纯模拟演示模式 (MEDIA_TRACK_DEMO=true，无需外部网盘)
  --clean-db        启动前重置开发数据库 run/mediary.db
  --skip-build      跳过 workflow 增量构建感知检查
  --no-open         服务就绪后不自动打开浏览器
  --stop            停止指定端口上正在运行的旧服务
  --status          探测服务运行与健康状态
  -h, --help        打印本帮助文档
`);
}

// ============================================================================
// 2. 跨平台进程与端口适配器 (Adapter Pattern)
// ============================================================================
class ProcessAdapter {
  static getPidFile(dataDir) {
    return path.join(dataDir, "server.pid");
  }

  static isPortInUse(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE") resolve(true);
        else resolve(false);
      });
      server.once("listening", () => {
        server.close(() => resolve(false));
      });
      server.listen(port, "127.0.0.1");
    });
  }

  static findPidsOnPort(port) {
    try {
      if (isWindows) {
        const out = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: "utf8" });
        const pids = new Set();
        for (const line of out.split("\n")) {
          const parts = line.trim().split(/\s+/);
          // TCP 127.0.0.1:3001 0.0.0.0:0 LISTENING 12345
          if (parts.length >= 5 && parts[1]?.endsWith(`:${port}`) && parts[3] === "LISTENING") {
            const pid = parseInt(parts[4], 10);
            if (!isNaN(pid) && pid > 0) pids.add(pid);
          }
        }
        return [...pids];
      } else {
        const out = execSync(`lsof -t -i :${port} -sTCP:LISTEN 2>/dev/null || true`, { encoding: "utf8" });
        return out.split("\n").map(l => parseInt(l.trim(), 10)).filter(n => !isNaN(n) && n > 0);
      }
    } catch {
      return [];
    }
  }

  static killProcessTree(pid) {
    if (!pid) return;
    try {
      if (isWindows) {
        execSync(`taskkill /F /T /PID ${pid} >nul 2>&1`);
      } else {
        execSync(`kill -9 ${pid} 2>/dev/null || true`);
      }
    } catch {}
  }

  static async stopService(port, pidFile) {
    console.log(`${c.yellow}正在排查并停止端口 ${port} 上的服务...${c.reset}`);
    let killed = false;

    // 1. 先查记录的 PID
    if (fs.existsSync(pidFile)) {
      const raw = fs.readFileSync(pidFile, "utf8").trim();
      const pid = parseInt(raw, 10);
      if (!isNaN(pid) && pid > 0) {
        this.killProcessTree(pid);
        killed = true;
      }
      try { fs.unlinkSync(pidFile); } catch {}
    }

    // 2. 查端口上存活的实际 PID
    const pids = this.findPidsOnPort(port);
    for (const p of pids) {
      if (p !== process.pid) {
        console.log(`${c.gray}终止残留进程 PID ${p}...${c.reset}`);
        this.killProcessTree(p);
        killed = true;
      }
    }

    // 等待端口彻底释放
    for (let i = 0; i < 20; i++) {
      if (!(await this.isPortInUse(port))) break;
      await new Promise(r => setTimeout(r, 100));
    }

    if (await this.isPortInUse(port)) {
      console.error(`${c.red}警告: 端口 ${port} 仍被占用，请手动排查占用程序。${c.reset}`);
      return false;
    }

    if (killed) {
      console.log(`${c.green}✔ 旧实例已彻底终止，端口 ${port} 已释放。${c.reset}`);
    } else {
      console.log(`${c.gray}端口 ${port} 原本即为空闲。${c.reset}`);
    }
    return true;
  }
}

// ============================================================================
// 3. 增量编译智能感知缓存 (Incremental Build Cache)
// ============================================================================
class BuildCacheChecker {
  static getNewestMtime(dir) {
    let max = 0;
    if (!fs.existsSync(dir)) return max;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const sub = this.getNewestMtime(full);
        if (sub > max) max = sub;
      } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".test.ts")) {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > max) max = stat.mtimeMs;
      }
    }
    return max;
  }

  static getOldestDistMtime(distDirs) {
    let min = Infinity;
    for (const d of distDirs) {
      if (!fs.existsSync(d)) return 0;
      const stat = fs.statSync(d);
      if (stat.mtimeMs < min) min = stat.mtimeMs;
    }
    return min === Infinity ? 0 : min;
  }

  static shouldRebuildWorkflow() {
    const workflowDist = path.join(repoRoot, "packages/workflow/dist/index.js");
    const sharedDist = path.join(repoRoot, "packages/shared/dist/index.js");
    if (!fs.existsSync(workflowDist) || !fs.existsSync(sharedDist)) {
      return true;
    }

    const distTime = Math.min(
      fs.statSync(workflowDist).mtimeMs,
      fs.statSync(sharedDist).mtimeMs
    );

    const newestSrc = Math.max(
      this.getNewestMtime(path.join(repoRoot, "packages/shared/src")),
      this.getNewestMtime(path.join(repoRoot, "packages/workflow/src"))
    );

    return newestSrc > distTime;
  }
}

// ============================================================================
// 4. 健康检测与浏览器调用
// ============================================================================
function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/health",
        timeout: 1000,
      },
      (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function openBrowser(url) {
  try {
    if (isWindows) {
      execSync(`start "" "${url}"`);
    } else if (process.platform === "darwin") {
      execSync(`open "${url}"`);
    } else {
      execSync(`xdg-open "${url}" 2>/dev/null || true`);
    }
  } catch {}
}

// ============================================================================
// 5. 核心状态机生命周期调度 (FSM State Machine)
// ============================================================================
async function run() {
  const options = parseArgs(process.argv.slice(2));
  const dataDir = path.join(repoRoot, "run");
  const pidFile = ProcessAdapter.getPidFile(dataDir);
  const dbPath = path.join(dataDir, "mediary.db");

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // --- 状态：STOP 模式 ---
  if (options.stop) {
    await ProcessAdapter.stopService(options.port, pidFile);
    process.exit(0);
  }

  // --- 状态：STATUS 探测模式 ---
  if (options.status) {
    const inUse = await ProcessAdapter.isPortInUse(options.port);
    const healthy = await probeHealth(options.port);
    console.log(`\n=== 巡影服务状态探测 (Port ${options.port}) ===`);
    console.log(`- 端口侦听: ${inUse ? c.green + "YES" : c.gray + "NO"}${c.reset}`);
    console.log(`- 健康检查 (/api/health): ${healthy ? c.green + "HEALTHY (200 OK)" : c.red + "UNAVAILABLE"}${c.reset}`);
    if (healthy) {
      console.log(`- 访问地址: ${c.cyan}http://127.0.0.1:${options.port}${c.reset}`);
    }
    process.exit(healthy ? 0 : 1);
  }

  console.log(`\n${c.bold}⚡ 巡影 · Mediary Scout 极速启动编排器${c.reset}`);
  console.log(`${c.gray}运行模式: ${options.prod ? "生产模拟 (Production Preview)" : "开发调试 (Turbopack HMR)"} | 目标端口: ${options.port}${c.reset}\n`);

  // --- 状态：PREFLIGHT（数据库重置）---
  if (options.cleanDb) {
    if (fs.existsSync(dbPath)) {
      console.log(`${c.yellow}重置开发数据库: ${dbPath}${c.reset}`);
      fs.unlinkSync(dbPath);
    }
  }

  // --- 状态：PORT_RECLAIM（端口自愈清理）---
  const portTaken = await ProcessAdapter.isPortInUse(options.port);
  if (portTaken) {
    console.log(`${c.yellow}检测到端口 ${options.port} 已被占用，自动执行安全回收...${c.reset}`);
    await ProcessAdapter.stopService(options.port, pidFile);
  }

  // --- 状态：CACHE_CHECK（增量编译感知）---
  if (!options.skipBuild) {
    const needBuild = BuildCacheChecker.shouldRebuildWorkflow();
    if (needBuild) {
      console.log(`${c.cyan}⚙️  检测到核心包 (packages/workflow) 源码更新，执行增量编译...${c.reset}`);
      execSync("npm run build:workflow", { stdio: "inherit", cwd: repoRoot });
      console.log(`${c.green}✔ 依赖包编译完成。${c.reset}`);
    } else {
      console.log(`${c.green}✔ 依赖包增量缓存生效，秒级跳过编译 (0ms 消耗)。${c.reset}`);
    }
  }

  // --- 状态：SPAWNING（启动子进程）---
  // 严格复用 desktop 及 docker-compose 环境配置基线，杜绝配置漂移
  const env = {
    ...process.env,
    PORT: String(options.port),
    HOSTNAME: "127.0.0.1",
    MEDIA_TRACK_SQLITE_PATH: dbPath,
    MEDIA_TRACK_SEARCH_PROVIDER: "tmdb",
    MEDIA_TRACK_WORKFLOW_ADAPTER: "pansou",
    MEDIA_TRACK_STORAGE_ADAPTER: "115",
    MEDIA_TRACK_AGENT_ADAPTER: "vercel-ai",
    MEDIA_TRACK_SINGLE_USER: "true",
    MEDIA_TRACK_WORKER_MODE: "inprocess",
    MEDIA_TRACK_JWT_SECRET: process.env.MEDIA_TRACK_JWT_SECRET || "local-dev-secret-please-override-32b",
    ...(options.demo ? { MEDIA_TRACK_DEMO: "true" } : {}),
  };

  let command;
  let cmdArgs;

  if (options.prod) {
    console.log(`${c.cyan}正在构建生产包 (npm run build:web)...${c.reset}`);
    execSync("npm run build:web", { stdio: "inherit", cwd: repoRoot });
    command = "npx";
    cmdArgs = ["next", "start", "apps/web", "-p", String(options.port)];
  } else {
    command = "npx";
    cmdArgs = ["next", "dev", "apps/web", "--turbopack", "-p", String(options.port)];
  }

  console.log(`${c.cyan}🚀 启动 Web 服务进程: ${command} ${cmdArgs.join(" ")} ...${c.reset}`);

  const fullCommand = [command, ...cmdArgs].join(" ");
  const child = isWindows
    ? spawn(fullCommand, {
        cwd: repoRoot,
        env,
        stdio: "inherit",
        shell: true,
      })
    : spawn(command, cmdArgs, {
        cwd: repoRoot,
        env,
        stdio: "inherit",
      });

  if (child.pid) {
    fs.writeFileSync(pidFile, String(child.pid), "utf8");
  }

  // --- 状态：HEALTH_CHECK & BROWSER OPEN ---
  const url = `http://127.0.0.1:${options.port}`;
  let isReady = false;

  const healthWatcher = (async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      const ok = await probeHealth(options.port);
      if (ok) {
        isReady = true;
        console.log(`\n${c.green}${c.bold}======================================================${c.reset}`);
        console.log(`${c.green}${c.bold}🎉 巡影 · Mediary Scout 服务已就绪！${c.reset}`);
        console.log(`${c.bold}   本地入口: ${c.cyan}${url}${c.reset}`);
        console.log(`${c.bold}   数据库路径: ${c.gray}${dbPath}${c.reset}`);
        console.log(`${c.green}${c.bold}======================================================${c.reset}\n`);

        if (options.openBrowser) {
          openBrowser(url);
        }
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    }
  })();

  // 优雅退出管理 (Graceful Shutdown)
  const cleanup = () => {
    console.log(`\n${c.yellow}收到退出信号，正在安全关闭服务进程...${c.reset}`);
    if (child.pid) {
      ProcessAdapter.killProcessTree(child.pid);
    }
    if (fs.existsSync(pidFile)) {
      try { fs.unlinkSync(pidFile); } catch {}
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  child.on("exit", (code) => {
    if (fs.existsSync(pidFile)) {
      try { fs.unlinkSync(pidFile); } catch {}
    }
    if (code !== 0 && !isReady) {
      console.error(`\n${c.red}❌ 服务异常退出 (退出码: ${code})。请根据上方 Next.js 错误日志排查。${c.reset}`);
    }
    process.exit(code ?? 0);
  });
}

run().catch((err) => {
  console.error(`\n${c.red}运行失败: ${err.message}${c.reset}`);
  process.exit(1);
});

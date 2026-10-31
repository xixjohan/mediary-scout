#!/usr/bin/env node
/**
 * 巡影 (Mediary Scout) 端对端核心冒烟测试器 (tools/runner/smoke-tester.mjs)
 *
 * 核心目标：
 *   真实发起 HTTP 请求预热 Next.js Turbopack 懒加载核心路由，
 *   实时拦截打包器编译错误 (如 'Export xxx doesn't exist'、'Module not found'、'Only async functions are allowed' 等)
 *   与 HTTP 500 异常，确保核心页面与 API 交付即健康。
 *
 * 设计模式应用：
 *   - 状态机模式 (FSM): INIT -> DETECT -> ATTACH_OR_SPAWN -> HEALTH_WAIT -> MATRIX_PROBE -> LOG_AUDIT -> TEARDOWN
 *   - 适配器模式 (Adapter): LiveServerAdapter (复用现有 3001 服务) / EphemeralServerAdapter (拉起 3009 临时沙箱)
 *   - 策略模式 (Strategy): SsrPageStrategy, RestApiStrategy, CompilerLogTrapStrategy
 *
 * 退出码: 0 = 全部冒烟通过, 1 = 发现编译异常或路由失败
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";
import http from "node:http";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const isWindows = process.platform === "win32";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

// ============================================================================
// 1. 跨平台进程与网络基础设施适配器 (ProcessAdapter)
// ============================================================================
export class ProcessAdapter {
  static findPidsOnPort(port) {
    try {
      if (isWindows) {
        const out = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: "utf8" });
        const pids = new Set();
        for (const line of out.split("\n")) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5 && parts[1]?.endsWith(`:${port}`) && parts[3] === "LISTENING") {
            const pid = parseInt(parts[4], 10);
            if (!isNaN(pid) && pid > 0) pids.add(pid);
          }
        }
        return [...pids];
      } else {
        const out = execSync(`lsof -t -i :${port} -sTCP:LISTEN 2>/dev/null || true`, { encoding: "utf8" });
        return out.split("\n").map((l) => parseInt(l.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
      }
    } catch {
      return [];
    }
  }

  static async isPortInUse(port) {
    if (isWindows) {
      try {
        const out = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: "utf8" });
        for (const line of out.split("\n")) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5 && parts[1]?.endsWith(`:${port}`) && parts[3] === "LISTENING") {
            return true;
          }
        }
      } catch {}
    }
    return new Promise((resolve) => {
      const server = http.createServer();
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE") resolve(true);
        else resolve(false);
      });
      server.once("listening", () => {
        server.close();
        resolve(false);
      });
      server.listen(port, "0.0.0.0");
    });
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
}

// ============================================================================
// 2. HTTP 探针与健康检查
// ============================================================================
export function requestHttp(port, path, options = {}) {
  const method = options.method || "GET";
  const timeoutMs = options.timeoutMs || 8000;
  const headers = options.headers || {};

  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "User-Agent": "MediaryScoutSmokeRunner/1.0",
          ...headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            headers: res.headers,
            body,
            latencyMs: Date.now() - start,
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({
        ok: false,
        status: 0,
        headers: {},
        body: "TIMEOUT",
        latencyMs: Date.now() - start,
        error: "Request timed out",
      });
    });

    req.on("error", (err) => {
      resolve({
        ok: false,
        status: 0,
        headers: {},
        body: "",
        latencyMs: Date.now() - start,
        error: err.message,
      });
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

export async function probeHealth(port, retries = 1, delayMs = 300) {
  for (let i = 0; i < retries; i++) {
    const res = await requestHttp(port, "/api/health", { timeoutMs: 1500 });
    if (res.status === 200) return true;
    if (i < retries - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

// ============================================================================
// 3. 核心路由探测策略矩阵 (Core Route Matrix)
// ============================================================================
export const CORE_SMOKE_ROUTES = [
  {
    name: "服务健康探针",
    path: "/api/health",
    strategy: "api",
    expectedStatus: [200],
    validate: (res) => {
      try {
        const json = JSON.parse(res.body);
        return json.status === "ok" || json.ok === true || typeof json === "object";
      } catch {
        return false;
      }
    },
  },
  {
    name: "主工作台 SSR 骨架",
    path: "/",
    strategy: "ssr",
    expectedStatus: [200],
    validate: (res) => res.body.includes("<!DOCTYPE html>") || res.body.includes("<html"),
  },
  {
    name: "系统偏好设置页",
    path: "/settings",
    strategy: "ssr",
    expectedStatus: [200, 302, 307],
    validate: (res) => res.status === 200 ? (res.body.includes("html") || res.body.length > 50) : true,
  },
  {
    name: "系统提醒与待办状态 API",
    path: "/api/settings/attention",
    strategy: "api",
    expectedStatus: [200, 401], // 允许未授权，但严禁 500 编译失败
    validate: (res) => res.status !== 500,
  },
  {
    name: "消息通知元数据 API",
    path: "/api/notifications/meta",
    strategy: "api",
    expectedStatus: [200, 401],
    validate: (res) => res.status !== 500,
  },
  {
    name: "实时动态活动流水 API",
    path: "/api/activity",
    strategy: "api",
    expectedStatus: [200, 401],
    validate: (res) => res.status !== 500,
  },
  {
    name: "系统引导引导状态 API",
    path: "/api/auth/bootstrap",
    strategy: "api",
    expectedStatus: [200],
    validate: (res) => {
      try {
        const json = JSON.parse(res.body);
        return typeof json === "object";
      } catch {
        return false;
      }
    },
  },
  {
    name: "作品详情页 SSR 动态路由",
    path: "/show/100",
    strategy: "ssr",
    expectedStatus: [200, 302, 307, 404],
    validate: (res) => res.status !== 500,
  },
  {
    name: "动漫全量发现流 (全部题材·全部年份)",
    path: "/?type=anime&genre=all&year=all",
    strategy: "ssr",
    expectedStatus: [200],
    validate: (res) => res.status === 200 && (res.body.includes("trending-card") || res.body.includes("candidate-card")),
  },
  {
    name: "动漫深度分页流 (第 2 页防截断)",
    path: "/?type=anime&page=2",
    strategy: "ssr",
    expectedStatus: [200],
    validate: (res) => res.status === 200 && !res.body.includes("未找到符合筛选条件的作品"),
  },
  {
    name: "多维复合分类筛选流 (科幻电影 2024)",
    path: "/?type=movie&genre=scifi&year=2024",
    strategy: "ssr",
    expectedStatus: [200],
    validate: (res) => res.status === 200 && res.body.includes("media-filter-bar"),
  },
];

// ============================================================================
// 4. Turbopack 打包器错误拦截器 (Compiler Trap)
// ============================================================================
const COMPILER_ERROR_PATTERNS = [
  /Ecmascript file had an error/i,
  /Export (.*) doesn't exist in target module/i,
  /Module not found: Can't resolve/i,
  /Only async functions are allowed to be exported in a "use server" file/i,
  /A Node\.js module is loaded .* which is not supported in the Edge Runtime/i,
  /A Node\.js API is used .* which is not supported in the Edge Runtime/i,
];

export function auditCompilerLogs(logBuffer) {
  const issues = [];
  for (const line of logBuffer.split("\n")) {
    for (const pattern of COMPILER_ERROR_PATTERNS) {
      if (pattern.test(line)) {
        issues.push(line.trim());
        break;
      }
    }
  }
  return issues;
}

// ============================================================================
// 5. 状态机调度生命周期 (FSM State Machine)
// ============================================================================
export async function runSmokeTest(cliArgs = []) {
  const targetPort = cliArgs.includes("--port")
    ? parseInt(cliArgs[cliArgs.indexOf("--port") + 1], 10)
    : 3001;

  const standaloneOnly = cliArgs.includes("--standalone");
  const attachOnly = cliArgs.includes("--attach");

  console.log(`\n${c.bold}🧪 巡影 · Mediary Scout 端对端核心冒烟测试器${c.reset}`);
  console.log(`${c.gray}正在评估测试目标与服务状态机 (目标端口: ${targetPort})...${c.reset}`);

  let serverMode = "unknown";
  let activePort = targetPort;
  let childProcess = null;
  let logBuffer = "";

  // 1. 状态探测：检查是否已有活跃服务可直接挂载
  const isTargetInUse = await ProcessAdapter.isPortInUse(targetPort);
  const isTargetHealthy = isTargetInUse ? await probeHealth(targetPort, 1) : false;

  if (isTargetHealthy && !standaloneOnly) {
    serverMode = "attached";
    console.log(`${c.green}✔ 检测到端口 ${targetPort} 上已有健康服务，执行实时热挂载测试 (Live Attach Mode)${c.reset}`);
  } else {
    if (attachOnly) {
      console.error(`${c.red}❌ 未在端口 ${targetPort} 上探测到活跃服务，且开启了 --attach 限制。测试中止。${c.reset}`);
      return { ok: false, violations: ["Target server not alive in attach-only mode"] };
    }

    serverMode = "ephemeral";
    activePort = targetPort;

    // 自愈清理：如果目标端口被僵死/不健康进程占用，主动释放，避免 Next.js 单实例锁冲突
    if (isTargetInUse) {
      console.log(`${c.yellow}检测到端口 ${targetPort} 上的旧实例处于异常状态，执行自动自愈清理...${c.reset}`);
      const pids = ProcessAdapter.findPidsOnPort(targetPort);
      pids.forEach((p) => ProcessAdapter.killProcessTree(p));
      await new Promise((r) => setTimeout(r, 800));
    }

    console.log(`${c.cyan}⚙️  启动临时测试进程 (Port ${activePort})...${c.reset}`);

    const smokeDbDir = join(repoRoot, "run");
    if (!existsSync(smokeDbDir)) mkdirSync(smokeDbDir, { recursive: true });
    const smokeDbPath = join(smokeDbDir, "smoke-test.db");

    const env = {
      ...process.env,
      PORT: String(activePort),
      HOSTNAME: "127.0.0.1",
      MEDIA_TRACK_SQLITE_PATH: smokeDbPath,
      MEDIA_TRACK_SEARCH_PROVIDER: "tmdb",
      MEDIA_TRACK_WORKFLOW_ADAPTER: "pansou",
      MEDIA_TRACK_STORAGE_ADAPTER: "115",
      MEDIA_TRACK_AGENT_ADAPTER: "vercel-ai",
      MEDIA_TRACK_SINGLE_USER: "true",
      MEDIA_TRACK_WORKER_MODE: "inprocess",
      MEDIA_TRACK_JWT_SECRET: "smoke-test-secret-key-32b-length-padded",
    };

    const cmdString = `npx next dev apps/web --turbopack -p ${activePort}`;
    childProcess = isWindows
      ? spawn(cmdString, { cwd: repoRoot, env, shell: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn("npx", ["next", "dev", "apps/web", "--turbopack", "-p", String(activePort)], {
          cwd: repoRoot,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

    childProcess.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      logBuffer += text;
    });

    childProcess.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      logBuffer += text;
    });

    // 轮询等待健康就绪 (最长等待 20s)
    let ready = false;
    process.stdout.write(`${c.gray}等待临时服务就绪 `);
    for (let i = 0; i < 40; i++) {
      process.stdout.write(".");
      if (await probeHealth(activePort, 1, 200)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`${c.reset}`);

    if (!ready) {
      if (childProcess.pid) ProcessAdapter.killProcessTree(childProcess.pid);
      console.error(`\n${c.red}❌ 临时服务启动超时未能就绪。日志预览:${c.reset}`);
      console.error(logBuffer.slice(-1500));
      return { ok: false, violations: ["Server failed to boot within timeout"] };
    }
    console.log(`${c.green}✔ 临时服务已在端口 ${activePort} 就绪。${c.reset}`);
  }

  // 2. 状态：核心路由矩阵并发/流水线探测 (Matrix Probing)
  console.log(`\n${c.bold}🚀 开始执行核心路由真实 HTTP 冒烟矩阵...${c.reset}`);
  const results = [];
  let hasFailure = false;

  for (const route of CORE_SMOKE_ROUTES) {
    const res = await requestHttp(activePort, route.path);
    const statusMatch = route.expectedStatus.includes(res.status);
    const valid = statusMatch && (!route.validate || route.validate(res));

    const statusBadge = valid
      ? `${c.green}${res.status} OK${c.reset}`
      : `${c.red}${res.status} FAIL${c.reset}`;

    console.log(
      `  - [${route.strategy.toUpperCase()}] ${route.name.padEnd(22, " ")} ${c.gray}${route.path.padEnd(26, " ")}${c.reset} → ${statusBadge} (${res.latencyMs}ms)`,
    );

    if (!valid) {
      hasFailure = true;
      results.push({ route, res, reason: `HTTP 状态异常: 期望 [${route.expectedStatus.join(", ")}], 实际 ${res.status}` });
    }
  }

  // 3. 状态：分析打包器日志是否捕获到 Turbopack 编译/引用异常
  const compilerIssues = auditCompilerLogs(logBuffer);

  // 4. 状态：安全收尾 (Teardown)
  if (serverMode === "ephemeral" && childProcess?.pid) {
    console.log(`\n${c.gray}正在安全回收临时测试进程 (PID: ${childProcess.pid})...${c.reset}`);
    ProcessAdapter.killProcessTree(childProcess.pid);
  }

  // 5. 状态：生成报告 (Report)
  console.log(`\n${c.bold}=== 冒烟测试诊断总结 ===${c.reset}`);
  console.log(`- 服务模式: ${serverMode === "attached" ? "热挂载现有服务" : "沙箱瞬时冷启动"}`);
  console.log(`- 核心路由覆盖: ${CORE_SMOKE_ROUTES.length} 个`);
  console.log(`- 路由异常数: ${hasFailure ? c.red + results.length : c.green + "0"}${c.reset}`);
  console.log(`- 打包器编译错误: ${compilerIssues.length > 0 ? c.red + compilerIssues.length : c.green + "0"}${c.reset}`);

  if (compilerIssues.length > 0) {
    console.error(`\n${c.red}❌ 拦截到打包器编译级违规信息:${c.reset}`);
    compilerIssues.forEach((issue) => console.error(`  - ${c.yellow}${issue}${c.reset}`));
  }

  if (hasFailure) {
    console.error(`\n${c.red}❌ 探测到路由失败详情:${c.reset}`);
    results.forEach(({ route, res, reason }) => {
      console.error(`  - ${route.name} (${route.path}): ${reason}`);
      if (res.body && res.status === 500) {
        console.error(`    响应内容截断: ${res.body.slice(0, 300).replace(/\n/g, " ")}`);
      }
    });
  }

  const passed = !hasFailure && compilerIssues.length === 0;
  if (passed) {
    console.log(`\n${c.green}${c.bold}🎉 恭喜！端对端真实核心冒烟测试 100% 通过！所有核心路由与编译契约均处于健康就绪状态！${c.reset}\n`);
  } else {
    console.error(`\n${c.red}${c.bold}💥 冒烟测试未通过，请根据上方失败路由与编译器报错进行修复。${c.reset}\n`);
  }

  return { ok: passed, results, compilerIssues };
}

// 直接作为 CLI 执行
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runSmokeTest(process.argv.slice(2)).then(({ ok }) => {
    process.exit(ok ? 0 : 1);
  });
}

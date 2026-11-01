import { nativeFs as fs, nativePath as path } from "../domain/native-require.js";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SandboxExecutionResult } from "./extension-types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveHarnessPath(): string {
  const local = path.resolve(__dirname, "sandbox-harness.cjs");
  if (fs.existsSync(local)) return local;
  const srcFallback = path.resolve(__dirname, "../../src/extensions/sandbox-harness.cjs");
  if (fs.existsSync(srcFallback)) return srcFallback;
  return local;
}

const HARNESS_PATH = resolveHarnessPath();

export interface ForkSandboxOptions {
  timeoutMs?: number; // default 8000
  memoryLimitMb?: number; // default 128
}

export class ForkSandboxRunner {
  /**
   * 在硬隔离子进程中安全执行扩展方法
   */
  public static async executeMethod<T = unknown>(
    entryFile: string,
    method: string,
    payload: unknown,
    options: ForkSandboxOptions = {}
  ): Promise<SandboxExecutionResult<T>> {
    const timeoutMs = options.timeoutMs ?? 8000;
    const memoryLimit = options.memoryLimitMb ?? 128;
    const startTime = Date.now();

    // 净化环境变量（剔除所有敏感数据库路径、JWT 密钥与网盘 Cookie）
    const sanitizedEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH || "",
      NODE_ENV: "production",
      HOME: process.env.HOME || process.env.USERPROFILE || "",
    };

    return new Promise<SandboxExecutionResult<T>>((resolve) => {
      let isSettled = false;
      const child = fork(HARNESS_PATH, [entryFile], {
        execArgv: [`--max-old-space-size=${memoryLimit}`],
        env: sanitizedEnv,
        silent: true,
      });

      const cleanup = () => {
        if (!isSettled) {
          isSettled = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      };

      const timer = setTimeout(() => {
        const durationMs = Date.now() - startTime;
        cleanup();
        resolve({
          success: false,
          error: `[SandboxTimeout] 扩展执行超时（超过 ${timeoutMs}ms 硬限制），已被进程信号强制终止`,
          durationMs,
        });
      }, timeoutMs);

      child.on("message", (msg: any) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        cleanup();

        if (msg && msg.success) {
          resolve({
            success: true,
            data: msg.data as T,
            durationMs,
          });
        } else {
          resolve({
            success: false,
            error: msg?.error || "未知扩展执行错误",
            durationMs,
          });
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        cleanup();
        resolve({
          success: false,
          error: `[ProcessError] 子进程异常: ${err.message}`,
          durationMs,
        });
      });

      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        if (!isSettled) {
          isSettled = true;
          resolve({
            success: false,
            error: `子进程意外退出 (code: ${code}, signal: ${signal})`,
            durationMs,
          });
        }
      });

      // 发送执行指令
      child.send({ id: "req_1", method, payload });
    });
  }
}

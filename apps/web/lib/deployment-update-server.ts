import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeCommit } from "./deployment-update";

let cachedCommit: string | null | undefined = undefined;

export function _resetBuildCommitCacheForTest(): void {
  cachedCommit = undefined;
}

/**
 * 策略 1：从环境变量中读取（最高优先级，0 I/O）
 */
function readCommitFromEnv(): string | null {
  const envVal = process.env.GIT_SHA ?? process.env.BUILD_COMMIT ?? process.env.NEXT_PUBLIC_GIT_SHA;
  return normalizeCommit(envVal);
}

/**
 * 策略 2：从文件系统中探查（Docker 镜像 / 部署根目录 / Monorepo 根目录）
 */
async function readCommitFromFile(): Promise<string | null> {
  const cwd = process.cwd();
  const candidates = [
    "/app/BUILD_COMMIT",
    join(/*turbopackIgnore: true*/ cwd, "BUILD_COMMIT"),
    join(/*turbopackIgnore: true*/ cwd, "..", "..", "BUILD_COMMIT"),
    join(/*turbopackIgnore: true*/ cwd, "apps", "web", "BUILD_COMMIT"),
  ];

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, "utf8");
      const normalized = normalizeCommit(content);
      if (normalized) return normalized;
    } catch {
      // 探查失败继续尝试下一个候选路径
    }
  }
  return null;
}

/**
 * 策略 3：在 Git 仓库环境下通过 Git CLI 获取当前 HEAD Commit
 */
async function readCommitFromGit(): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
      timeout: 1500,
      encoding: "utf8",
    });
    return normalizeCommit(stdout);
  } catch {
    return null;
  }
}

/**
 * 责任链模式解析当前运行环境的 Commit：
 * 环境变量 -> 文件系统探查 -> Git CLI 探查 -> 回退 updater daemon
 */
export async function readBuildCommit(): Promise<string | null> {
  if (cachedCommit !== undefined) return cachedCommit;

  const fromEnv = readCommitFromEnv();
  if (fromEnv) {
    cachedCommit = fromEnv;
    return cachedCommit;
  }

  const fromFile = await readCommitFromFile();
  if (fromFile) {
    cachedCommit = fromFile;
    return cachedCommit;
  }

  const fromGit = await readCommitFromGit();
  if (fromGit) {
    cachedCommit = fromGit;
    return cachedCommit;
  }

  cachedCommit = null;
  return null;
}

import { NextResponse, type NextRequest } from "next/server";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import os from "node:os";
import { isDemoMode } from "../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { resolveStrmOutputPath, toStrmOutputConfigPath } from "@media-track/workflow";

/**
 * 获取跨平台允许浏览的根路径列表
 */
async function getAvailableRoots(): Promise<{ name: string; fullPath: string }[]> {
  const isWin = os.platform() === "win32";
  const roots: { name: string; fullPath: string }[] = [];

  if (isWin) {
    const letters = ["C", "D", "E", "F", "G", "H", "Z"];
    for (const letter of letters) {
      const rootPath = `${letter}:\\`;
      try {
        await fs.access(rootPath);
        roots.push({ name: `本地磁盘 (${letter}:)`, fullPath: rootPath });
      } catch {
        // 不存在的盘符
      }
    }
  } else {
    const candidates = [
      { name: "数据根目录 (/data)", fullPath: "/data" },
      { name: "媒体根目录 (/media)", fullPath: "/media" },
      { name: "挂载根目录 (/mnt)", fullPath: "/mnt" },
      { name: "STRM 输出根目录 (/strm)", fullPath: "/strm" },
      { name: "群晖共享卷 (/volume1)", fullPath: "/volume1" },
    ];
    for (const cand of candidates) {
      try {
        await fs.access(cand.fullPath);
        roots.push(cand);
      } catch {
        // 不存在的挂载点
      }
    }
  }

  // 始终将当前工作目录与 ./data 作为可选根目录
  const cwd = process.cwd();
  if (!roots.some((r) => path.resolve(r.fullPath) === path.resolve(cwd))) {
    roots.push({ name: `项目工作区 (${path.basename(cwd)})`, fullPath: cwd });
  }

  return roots;
}

/**
 * 校验请求路径是否在允许的安全白名单范围内
 */
async function isPathAllowed(targetPath: string, roots: { fullPath: string }[]): Promise<boolean> {
  const resolved = path.resolve(targetPath);
  return roots.some((r) => {
    const resolvedRoot = path.resolve(r.fullPath);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep);
  });
}

const FORBIDDEN_DIRS = new Set([
  "$recycle.bin",
  "system volume information",
  "node_modules",
  ".git",
  ".next",
  "windows",
  "boot",
  "proc",
  "sys",
  "etc",
]);

function rootListingResponse(roots: { name: string; fullPath: string }[]): NextResponse {
  return NextResponse.json({
    currentPath: "",
    parentPath: null,
    isRoot: true,
    canWrite: false,
    directories: roots.map((root) => ({
      name: root.name,
      fullPath: root.fullPath,
      isDriveRoot: true,
    })),
  });
}

function getVisibleDirectories(
  resolved: string,
  entries: Dirent<string>[],
): { name: string; fullPath: string; configPath?: string }[] {
  const programData = path.join(process.cwd(), "data");
  const isUnderProgramData =
    resolved === programData || resolved.startsWith(`${programData}${path.sep}`);
  return entries
    .filter((entry) => entry.isDirectory() &&
      !FORBIDDEN_DIRS.has(entry.name.toLowerCase()) &&
      !entry.name.startsWith("."))
    .map((entry) => {
      const fullPath = path.join(resolved, entry.name);
      const configPath = isUnderProgramData ? toStrmOutputConfigPath(fullPath) : undefined;
      return { name: entry.name, fullPath, ...(configPath ? { configPath } : {}) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

async function resolveRequestedPath(
  requestedPath: string,
  roots: { fullPath: string }[],
): Promise<string | NextResponse> {
  let resolved: string;
  try {
    const normalized = requestedPath.replace(/\\/g, "/").startsWith("data/")
      ? resolveStrmOutputPath(requestedPath)
      : path.normalize(requestedPath);
    resolved = path.resolve(normalized);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "STRM 路径无效" },
      { status: 400 },
    );
  }

  if (requestedPath.replace(/\\/g, "/").startsWith("data/")) {
    const isDirectory = await fs.stat(resolved).then((stat) => stat.isDirectory()).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (!isDirectory) {
      return NextResponse.json({
        code: "DIRECTORY_NOT_FOUND",
        error: "目录尚不存在，可通过选择目标操作创建后使用",
        currentPath: resolved,
        canCreate: true,
      }, { status: 404 });
    }
  }

  if (!(await isPathAllowed(resolved, roots))) {
    return NextResponse.json(
      { error: "安全拦截：所请求的路径超出系统允许的安全浏览范围" },
      { status: 403 },
    );
  }
  return resolved;
}

async function readDirectoryResponse(
  resolved: string,
  roots: { fullPath: string }[],
): Promise<NextResponse> {
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "目标路径不是文件夹" }, { status: 400 });
    }

    const canWrite = await fs.access(resolved, fs.constants.W_OK).then(
      () => true,
      () => false,
    );
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const directories = getVisibleDirectories(resolved, entries);
    const parent = path.dirname(resolved);
    const hasParent = parent !== resolved && await isPathAllowed(parent, roots);
    return NextResponse.json({
      currentPath: resolved,
      parentPath: hasParent ? parent : null,
      isRoot: !hasParent,
      canWrite,
      directories,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取目录失败" },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  const { searchParams } = new URL(request.url);
  const requestedPath = searchParams.get("path")?.trim();
  const roots = await getAvailableRoots();
  if (!requestedPath) return rootListingResponse(roots);

  const resolved = await resolveRequestedPath(requestedPath, roots);
  if (resolved instanceof Response) return resolved;
  return readDirectoryResponse(resolved, roots);
}

function ensureOutputErrorResponse(error: unknown): NextResponse {
  const code = (error as NodeJS.ErrnoException).code;
  const isUnavailable = code === "EACCES" || code === "EROFS";
  const status = isUnavailable ? 403 : code === "ENOENT" ? 404 : 400;
  const errorCode = isUnavailable
    ? "OUTPUT_ROOT_NOT_WRITABLE"
    : code === "ENOENT"
      ? "OUTPUT_ROOT_UNAVAILABLE"
      : "OUTPUT_PATH_INVALID";
  return NextResponse.json({
    code: errorCode,
    error: error instanceof Error ? error.message : "STRM 目录不可用",
  }, { status });
}

async function ensureOutputResponse(outputConfigPath?: string): Promise<NextResponse> {
  if (!outputConfigPath) {
    return NextResponse.json({ code: "INVALID_PATH", error: "outputPath 必填" }, { status: 400 });
  }
  try {
    const outputPath = resolveStrmOutputPath(outputConfigPath);
    const dataRoot = path.join(process.cwd(), "data");
    await fs.mkdir(outputPath, { recursive: true });
    const [realRoot, realOutput, stat] = await Promise.all([
      fs.realpath(dataRoot), fs.realpath(outputPath), fs.stat(outputPath),
    ]);
    if (realOutput !== realRoot && !realOutput.startsWith(`${realRoot}${path.sep}`)) {
      return NextResponse.json({ code: "PATH_OUTSIDE_ROOT", error: "STRM 目录超出允许范围" }, { status: 403 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ code: "NOT_DIRECTORY", error: "目标路径不是文件夹" }, { status: 400 });
    }
    await fs.access(outputPath, fs.constants.W_OK);
    return NextResponse.json({
      ok: true,
      configPath: outputConfigPath,
      resolvedPath: outputPath,
      exists: true,
      canWrite: true,
    });
  } catch (error) {
    return ensureOutputErrorResponse(error);
  }
}

async function createChildDirectoryResponse(parentPath: string, folderName: string): Promise<NextResponse> {
  const cleanName = folderName.trim().replace(/[\\/:*?"<>|]/g, "_");
  let resolvedParent: string;
  try {
    resolvedParent = parentPath.replace(/\\/g, "/").startsWith("data/")
      ? resolveStrmOutputPath(parentPath)
      : parentPath;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "STRM 路径无效" },
      { status: 400 },
    );
  }

  const targetDir = path.resolve(resolvedParent, cleanName);
  const roots = await getAvailableRoots();
  if (!(await isPathAllowed(targetDir, roots))) {
    return NextResponse.json({ error: "安全拦截：所创建的路径超出允许范围" }, { status: 403 });
  }
  try {
    await fs.mkdir(targetDir, { recursive: true });
    return NextResponse.json({ ok: true, createdPath: targetDir });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建目录失败" },
      { status: 500 },
    );
  }
}

/**
 * 支持在当前目录下快捷创建新文件夹
 */
export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    parentPath?: string;
    folderName?: string;
    mode?: "mkdir" | "ensure-output";
    outputPath?: string;
  } | null;
  if (body?.mode === "ensure-output") return ensureOutputResponse(body.outputPath);
  if (!body?.parentPath || !body.folderName?.trim()) {
    return NextResponse.json({ error: "parentPath 与 folderName 必填" }, { status: 400 });
  }
  return createChildDirectoryResponse(body.parentPath, body.folderName);
}

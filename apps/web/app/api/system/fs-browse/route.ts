import { NextResponse, type NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isDemoMode } from "../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../lib/auth-chain";

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

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  const { searchParams } = new URL(request.url);
  const requestedPath = searchParams.get("path")?.trim();
  const roots = await getAvailableRoots();

  // 若未指定路径，直接返回可用的顶层根目录/盘符
  if (!requestedPath) {
    return NextResponse.json({
      currentPath: "",
      parentPath: null,
      isRoot: true,
      canWrite: false,
      directories: roots.map((r) => ({
        name: r.name,
        fullPath: r.fullPath,
        isDriveRoot: true,
      })),
    });
  }

  const normalized = path.normalize(requestedPath);
  const resolved = path.resolve(normalized);

  // 安全检查：防止 Path Traversal 逃逸出白名单根
  const allowed = await isPathAllowed(resolved, roots);
  if (!allowed) {
    return NextResponse.json(
      { error: "安全拦截：所请求的路径超出系统允许的安全浏览范围" },
      { status: 403 },
    );
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "目标路径不是文件夹" }, { status: 400 });
    }

    let canWrite = false;
    try {
      await fs.access(resolved, fs.constants.W_OK);
      canWrite = true;
    } catch {
      canWrite = false;
    }

    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const directories: { name: string; fullPath: string }[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nameLower = entry.name.toLowerCase();
        if (FORBIDDEN_DIRS.has(nameLower) || entry.name.startsWith(".")) {
          continue;
        }
        directories.push({
          name: entry.name,
          fullPath: path.join(resolved, entry.name),
        });
      }
    }

    // 排序：按字母排序
    directories.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

    const parent = path.dirname(resolved);
    const hasParent = parent !== resolved && (await isPathAllowed(parent, roots));

    return NextResponse.json({
      currentPath: resolved,
      parentPath: hasParent ? parent : null,
      isRoot: !hasParent,
      canWrite,
      directories,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "读取目录失败" },
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
  } | null;

  if (!body?.parentPath || !body?.folderName?.trim()) {
    return NextResponse.json({ error: "parentPath 与 folderName 必填" }, { status: 400 });
  }

  const cleanName = body.folderName.trim().replace(/[\\/:*?"<>|]/g, "_");
  const targetDir = path.resolve(body.parentPath, cleanName);
  const roots = await getAvailableRoots();

  const allowed = await isPathAllowed(targetDir, roots);
  if (!allowed) {
    return NextResponse.json({ error: "安全拦截：所创建的路径超出允许范围" }, { status: 403 });
  }

  try {
    await fs.mkdir(targetDir, { recursive: true });
    return NextResponse.json({ ok: true, createdPath: targetDir });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "创建目录失败" },
      { status: 500 },
    );
  }
}

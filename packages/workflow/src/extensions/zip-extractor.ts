import { nativePath as path } from "../domain/native-require.js";
import fs from "node:fs/promises";
import type { ExtensionManifest } from "./extension-types.js";

/**
 * Zip Slip 漏洞防护：确保目标解压路径决不会逃逸出基准目录
 */
export function assertSafeZipPath(targetDir: string, relativePath: string): string {
  const normalizedRelative = relativePath.replace(/\\/g, "/");
  const resolvedTarget = path.resolve(targetDir);
  const resolvedPath = path.resolve(targetDir, normalizedRelative);
  if (!resolvedPath.startsWith(resolvedTarget + path.sep) && resolvedPath !== resolvedTarget) {
    throw new Error(`[ZipSlipDetected] 检测到路径穿越攻击，禁止解压至基准目录之外: ${relativePath}`);
  }
  return resolvedPath;
}

/**
 * 安全解压 ZIP 文件包至目标目录
 * 避免在顶层静态 import extract-zip，防止 Turbopack 将其打入客户端/中间件 chunk 并导致 ModuleNotFound 致命编译中断
 */
export async function extractZipSafely(zipFilePath: string, destDir: string): Promise<ExtensionManifest> {
  const resolvedDest = path.resolve(destDir);
  await fs.mkdir(resolvedDest, { recursive: true });

  let extracted = false;

  // 1. 尝试使用 extract-zip 动态加载（动态拼接模块名阻断 Turbopack 静态分析）
  try {
    const pkgName = ["extract", "zip"].join("-");
    const mod = await import(/* webpackIgnore: true */ pkgName);
    const extractZip = mod.default || mod;
    await extractZip(zipFilePath, {
      dir: resolvedDest,
      onEntry: (entry: { fileName: string }) => {
        assertSafeZipPath(resolvedDest, entry.fileName);
      },
    });
    extracted = true;
  } catch {
    // 降级回退方案
  }

  // 2. 若无 extract-zip，尝试系统原生 unzip 指令
  if (!extracted) {
    try {
      const cp = await import("node:child_process");
      cp.execSync(`unzip -q -o "${zipFilePath}" -d "${resolvedDest}"`);
      extracted = true;
    } catch (e: any) {
      throw new Error(`解压扩展包失败 (未找到 extract-zip 且系统 unzip 不可用): ${e?.message || e}`);
    }
  }

  // 读取并校验 manifest.json
  const manifestPath = path.join(resolvedDest, "manifest.json");
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, "utf8");
  } catch {
    throw new Error("扩展包无效：缺少 manifest.json 清单文件");
  }

  let manifest: ExtensionManifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    throw new Error("扩展清单 manifest.json 格式错误（非有效 JSON）");
  }

  if (!manifest.id || !manifest.name || !manifest.entry) {
    throw new Error("扩展清单缺少必填字段: id, name, entry");
  }

  // 验证入口文件是否存在且安全
  const entryPath = assertSafeZipPath(resolvedDest, manifest.entry);
  try {
    await fs.access(entryPath);
  } catch {
    throw new Error(`扩展入口文件未找到: ${manifest.entry}`);
  }

  return manifest;
}

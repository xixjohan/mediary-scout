import { nativeFs as fs, nativePath as path } from "../domain/native-require.js";
import type { StrmDeliveryMode } from "./strm-types.js";

/**
 * STRM 文件生成器与路径工具
 *
 * 借鉴 LitePan-main 的 STRM 命名安全化、URL 生成与极简写入策略。
 * 1. 严格过滤非法文件名字符，原生保留中文字符；
 * 2. 保证写入为单行合法 URL 且结尾带标准换行符；
 * 3. 自动递归创建多级目录，支持幂等写入与清理。
 */

const ILLEGAL_PATH_CHARS = /[\/\\:*?"<>|]/g;

/**
 * 安全化文件名/目录名，替换非法字符为下划线，空字符串兜底为 "_"。
 */
export function safeStem(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return "_";
  }
  const sanitized = trimmed.replace(ILLEGAL_PATH_CHARS, "_").trim();
  return sanitized || "_";
}

/**
 * 安全化相对目录路径段。
 */
export function safeDirSegments(rawPath: string): string[] {
  const normalized = rawPath.replace(/\\/g, "/").trim();
  const parts = normalized.split("/").map((p) => p.trim()).filter(Boolean);
  const safeParts: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "..") continue;
    safeParts.push(safeStem(p));
  }
  return safeParts;
}

/**
 * 构造流媒体播放相对路径。
 *
 * 遵循严格 RESTful 资源定位规范：
 * /api/strm/play/{taskId}/{fileId}?name=...
 * 彻底废除 mode=proxy 等运行时参数污染，交由服务端任务配置字典自主决策。
 */
export function buildPlayPath(
  taskId: string,
  fileId: string,
  fileName?: string,
): string {
  const base = `/api/strm/play/${encodeURIComponent(taskId)}/${encodeURIComponent(fileId)}`;
  return fileName ? `${base}?name=${encodeURIComponent(fileName)}` : base;
}

/**
 * 构造完整的流媒体播放绝对 URL。
 */
export function buildPlayUrl(
  baseUrl: string,
  taskId: string,
  fileId: string,
  fileName?: string,
): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/, "");
  const playPath = buildPlayPath(taskId, fileId, fileName);
  return `${cleanBase}${playPath}`;
}

export interface WriteStrmFileInput {
  targetFilePath: string;
  playUrl: string;
}

/**
 * 写入单个 .strm 文件。
 */
export async function writeStrmFile(input: WriteStrmFileInput): Promise<void> {
  const dir = path.dirname(input.targetFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 保证单行 URL 写入并带标准换行符
  const content = `${input.playUrl.trim()}\n`;
  await fs.promises.writeFile(input.targetFilePath, content, "utf8");
}

/**
 * 安全删除指定 .strm 文件，若其所在父目录为空则递归清理空目录。
 */
export async function removeStrmFile(targetFilePath: string, cleanupEmptyDir = true): Promise<boolean> {
  if (!fs.existsSync(targetFilePath)) {
    return false;
  }
  await fs.promises.unlink(targetFilePath);

  if (cleanupEmptyDir) {
    let dir = path.dirname(targetFilePath);
    try {
      while (dir && dir !== path.dirname(dir)) {
        const files = await fs.promises.readdir(dir);
        if (files.length === 0) {
          await fs.promises.rmdir(dir);
          dir = path.dirname(dir);
        } else {
          break;
        }
      }
    } catch {
      // 容错空目录清理
    }
  }
  return true;
}

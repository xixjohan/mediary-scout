import { nativeFs as fs, nativePath as path } from "../domain/native-require.js";
import { STRM_BASE_URL_SETTING_KEY } from "./strm-types.js";

/**
 * 快速访问路径基址秒级替换引擎
 *
 * 借鉴 LitePan-main 的 ReplaceBaseURLInFiles 算法。
 * 当用户变更 NAS 局域网 IP、外网域名或反代端口时，无需耗费数小时重扫网盘，
 * 纯本地毫秒级重写目录下全部 .strm 文件的 URL 前缀。
 */

export interface ReplaceBaseUrlResult {
  total: number;
  updated: number;
  errors: Array<{ path: string; error: string }>;
}

const BASE_URL_REGEX = /^https?:\/\/[^\/]+/i;

/**
 * 规范化并校验新 Base URL（如 http://192.168.1.100:3000 或 https://media.example.com）。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("新访问基址不能为空");
  }
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new Error("访问基址必须以 http:// 或 https:// 开头");
  }
  return trimmed.replace(/\/+$/, "");
}

/**
 * 替换单行 URL 中的 Host/Port 前缀。
 */
export function replaceBaseUrlInLine(line: string, newBaseUrl: string): { replaced: string; changed: boolean } {
  const trimmed = line.trim();
  if (!trimmed || (!trimmed.startsWith("http://") && !trimmed.startsWith("https://"))) {
    return { replaced: line, changed: false };
  }
  const replaced = trimmed.replace(BASE_URL_REGEX, newBaseUrl);
  return { replaced: `${replaced}\n`, changed: replaced !== trimmed };
}

/**
 * 批量秒级替换指定目录下所有 .strm 文件的基址。
 */
export async function replaceBaseUrlInFiles(
  strmRootDir: string,
  newBaseUrl: string,
): Promise<ReplaceBaseUrlResult> {
  const normalizedBase = normalizeBaseUrl(newBaseUrl);
  const result: ReplaceBaseUrlResult = {
    total: 0,
    updated: 0,
    errors: [],
  };

  if (!fs.existsSync(strmRootDir)) {
    return result;
  }

  async function walkDir(currentDir: string): Promise<void> {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".strm")) {
        result.total++;
        try {
          const content = await fs.promises.readFile(fullPath, "utf8");
          const firstLineEnd = content.indexOf("\n");
          const firstLine = firstLineEnd !== -1 ? content.slice(0, firstLineEnd) : content;
          const rest = firstLineEnd !== -1 ? content.slice(firstLineEnd + 1) : "";

          const { replaced, changed } = replaceBaseUrlInLine(firstLine, normalizedBase);
          if (changed) {
            const newContent = `${replaced.trim()}\n${rest ? rest.trim() + "\n" : ""}`;
            await fs.promises.writeFile(fullPath, newContent, "utf8");
            result.updated++;
          }
        } catch (err) {
          result.errors.push({
            path: fullPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  await walkDir(strmRootDir);
  return result;
}

/**
 * 批量秒级替换多个目录下所有 .strm 文件的基址（自动去重目录并汇总统计）。
 */
export async function replaceBaseUrlInDirectories(
  directories: string[],
  newBaseUrl: string,
): Promise<ReplaceBaseUrlResult & { directories: string[] }> {
  const normalizedBase = normalizeBaseUrl(newBaseUrl);
  const uniqueDirs = Array.from(
    new Set(directories.map((d) => d.trim()).filter(Boolean)),
  );

  const aggregateResult: ReplaceBaseUrlResult & { directories: string[] } = {
    total: 0,
    updated: 0,
    errors: [],
    directories: uniqueDirs,
  };

  for (const dir of uniqueDirs) {
    if (!fs.existsSync(dir)) continue;
    const res = await replaceBaseUrlInFiles(dir, normalizedBase);
    aggregateResult.total += res.total;
    aggregateResult.updated += res.updated;
    aggregateResult.errors.push(...res.errors);
  }

  return aggregateResult;
}

/**
 * 解析并确定当前生效的 STRM 播放基址（SSOT 单一事实源）。
 *
 * 优先级规范：
 * 1. explicitUrl（本次调用显式指定的基址）
 * 2. 数据库全局设置（STRM_BASE_URL_SETTING_KEY = "strm_base_url"）
 * 3. 环境变量 APP_BASE_URL 或 MEDIARY_URL
 * 4. 本地回环地址兜底 http://127.0.0.1:${PORT || 3000}（附带控制台警告）
 */
export async function resolveEffectiveStrmBaseUrl(
  repo?: { getSetting(key: string): Promise<string | null> } | null,
  explicitUrl?: string,
): Promise<string> {
  if (explicitUrl?.trim()) {
    try {
      return normalizeBaseUrl(explicitUrl.trim());
    } catch {
      // 若显式传入的非法则继续向下尝试
    }
  }

  if (repo) {
    try {
      const dbValue = await repo.getSetting(STRM_BASE_URL_SETTING_KEY);
      if (dbValue?.trim()) {
        return normalizeBaseUrl(dbValue.trim());
      }
    } catch {
      // 容错读取
    }
  }

  const envValue = process.env.APP_BASE_URL || process.env.MEDIARY_URL;
  if (envValue?.trim()) {
    try {
      return normalizeBaseUrl(envValue.trim());
    } catch {
      // 容错非法环境变量
    }
  }

  const fallbackPort = process.env.PORT || "3000";
  console.warn(
    `[STRM] 警告：未在数据库 (${STRM_BASE_URL_SETTING_KEY}) 或环境变量 (APP_BASE_URL) 中配置外部播放基址！当前降级为回环地址 http://127.0.0.1:${fallbackPort}，外部播放设备（如电视/Emby）可能无法播放。`,
  );
  return `http://127.0.0.1:${fallbackPort}`;
}

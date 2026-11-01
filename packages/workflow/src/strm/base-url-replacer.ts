import { nativeFs as fs, nativePath as path } from "../domain/native-require.js";

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

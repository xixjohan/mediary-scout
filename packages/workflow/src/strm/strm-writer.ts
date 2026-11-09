import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_STRM_TTL_SECONDS = 365 * 24 * 3600; // 默认 1 年有效时间

export function resolveStrmSigningSecret(): string {
  return (
    process.env.STRM_SECRET ||
    process.env.APP_SECRET ||
    process.env.JWT_SECRET ||
    process.env.MEDIA_TRACK_CREDENTIAL_KEY ||
    "mediary-scout-strm-signing-secret"
  );
}

export function signStrmPlayUrl(
  taskId: string,
  fileId: string,
  expiresAtEpochSeconds: number,
  secret: string = resolveStrmSigningSecret(),
): string {
  return createHmac("sha256", secret)
    .update(`${taskId}:${fileId}:${expiresAtEpochSeconds}`)
    .digest("hex")
    .slice(0, 32);
}

export function verifyStrmPlayToken(input: {
  taskId: string;
  fileId: string;
  token?: string | null;
  expiresAtEpochSeconds?: number | null;
  secret?: string;
  nowEpochSeconds?: number;
}): { valid: boolean; reason?: string } {
  const { taskId, fileId, token, expiresAtEpochSeconds } = input;
  if (!token || !expiresAtEpochSeconds) {
    return { valid: false, reason: "missing_token_or_expiration" };
  }
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  if (now > expiresAtEpochSeconds) {
    return { valid: false, reason: "token_expired" };
  }
  const expected = signStrmPlayUrl(
    taskId,
    fileId,
    expiresAtEpochSeconds,
    input.secret ?? resolveStrmSigningSecret(),
  );
  const tokenBuf = Buffer.from(token);
  const expBuf = Buffer.from(expected);
  if (tokenBuf.length !== expBuf.length || !timingSafeEqual(tokenBuf, expBuf)) {
    return { valid: false, reason: "invalid_signature" };
  }
  return { valid: true };
}

export interface PlayUrlOptions {
  sign?: boolean;
  ttlSeconds?: number;
  secret?: string;
}
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
  options?: PlayUrlOptions,
): string {
  const base = `/api/strm/play/${encodeURIComponent(taskId)}/${encodeURIComponent(fileId)}`;
  const queryParts: string[] = [];
  if (fileName) {
    queryParts.push(`name=${encodeURIComponent(fileName)}`);
  }
  if (options?.sign) {
    const ttl = options.ttlSeconds ?? DEFAULT_STRM_TTL_SECONDS;
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const secret = options.secret ?? resolveStrmSigningSecret();
    const token = signStrmPlayUrl(taskId, fileId, exp, secret);
    queryParts.push(`token=${encodeURIComponent(token)}`);
    queryParts.push(`exp=${exp}`);
  }
  return queryParts.length > 0 ? `${base}?${queryParts.join("&")}` : base;
}

/**
 * 构造完整的流媒体播放绝对 URL。
 */
export function buildPlayUrl(
  baseUrl: string,
  taskId: string,
  fileId: string,
  fileName?: string,
  options?: PlayUrlOptions,
): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/, "");
  const playPath = buildPlayPath(taskId, fileId, fileName, options);
  return `${cleanBase}${playPath}`;
}

/**
 * 构造带数字防篡改签名与有效期的安全 STRM 播放绝对 URL。
 */
export function buildSignedPlayUrl(
  baseUrl: string,
  taskId: string,
  fileId: string,
  fileName?: string,
  options?: Omit<PlayUrlOptions, "sign">,
): string {
  return buildPlayUrl(baseUrl, taskId, fileId, fileName, { ...options, sign: true });
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

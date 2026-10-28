/**
 * 凭据信封加密（任务单 S1.5，P15：凭据全明文存储的重大安全隐患）。
 *
 * 威胁模型：数据库文件被拖走（备份泄露、卷拷贝、误推送）时，凭据（各网盘 cookie、
 * LLM/TMDB/ASSRT/Jev/Prowlarr API key、推送 sendkey、隧道令牌……）不随之泄露。
 * 单机自托管场景，密钥与数据库同机但分文件；文档明确要求备份时连密钥一起备。
 *
 * 算法：AES-256-GCM（认证加密，防篡改）。
 * 格式：`enc:v1:` + base64( iv(12B) || authTag(16B) || ciphertext )。
 * 旧明文无前缀 → decryptSecret 原样透传（迁移期读写不炸；写入侧即完成加密）。
 *
 * 密钥解析顺序：
 *   1. env MEDIA_TRACK_CREDENTIAL_KEY —— 32 字节（64 位 hex 或 base64）直接用；
 *      其它长度当作口令，scrypt 派生。
 *   2. keyFilePath（默认与数据库同目录的 credential.key）—— 不存在则生成
 *      32 随机字节（hex，0600）；存在但内容非法 → 抛错，绝不静默换钥
 *      （否则历史密文全部解不开，而失败是可见的）。
 *   3. ephemeral（:memory: 测试库）—— 进程内随机密钥，不落盘。
 */
import { createNativeRequire } from "../native-require.js";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
// node:path 同样不静态 import（与 workflow 包的 sqlite-json-cache 一致）。实测
// Turbopack 容忌 node:path（构建是绿的），但这三个函数本来就只在调用时到的
// fs() 旁边用，懒加载不改行为，只是不给打包器留静态边。
type PathLike = typeof import("node:path");
function nodePath(): PathLike {
  return requireNative("node:path") as PathLike;
}

/**
 * node:fs **调用时**才 require（与 workflow 包对 better-sqlite3 的 requireNative
 * 同一模式）：本模块经 shared barrel 被客户端可达链 import，静态 `node:fs`
 * 会把 Turbopack 客户端 chunk 炸掉（S4.3 实测：node_modules 里的包不受
 * server-only 标记保护，只有让打包器静态分析不到才安全）。
 */
// createRequire 不静态 import：见 native-require.ts。静态 import 会让 node:module 进入
// 客户端可达的 chunk，Turbopack 直接拒掉整个生产构建——这正是本文件上方那条 S4.3
// 注释想防的事，而它自己第 1 行正是漏掉的那处。
let nativeRequire: ReturnType<typeof createNativeRequire> | undefined;
/** 懒建：**模块求值时绝不调** createNativeRequire。本文件经 shared barrel 被客户端
 *  可达链 import，顶层调用会让 `process.getBuiltinModule("node:module")` 打进浏览器
 *  chunk 并在求值时抛 TypeError（浏览器没有该 API）——整个客户端包随之死掉，页面只剩
 *  错误边界（实测：首页 /settings 全崩，SSR 却是 200，因为崩在水合/客户端求值阶段）。
 *  native-require.ts 的「不静态 import node:module」只保证构建能过，管不了这一条。 */
const requireNative = (id: string): unknown => {
  nativeRequire ??= createNativeRequire(import.meta.url);
  return nativeRequire(id);
};
type FsLike = typeof import("node:fs");
function fs(): FsLike {
  return requireNative("node:fs") as FsLike;
}

export const ENC_PREFIX = "enc:v1:";
const IV_BYTES = 12; // GCM 推荐 IV 长度
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256
// 口令派生用固定盐：本模块的盐只需区分算法版本，暴力破解成本由 scrypt 参数承担。
const SCRYPT_SALT = "mediary-scout/credential-crypto/v1";

let cachedKey: Buffer | null = null;

function keyFromEnv(raw: string): Buffer {
  const trimmed = raw.trim();
  // 32 字节的 hex / base64 直接当密钥
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const b64 = Buffer.from(trimmed, "base64");
    if (b64.length === KEY_BYTES && b64.toString("base64").replace(/=+$/, "") === trimmed.replace(/=+$/, "")) {
      return b64;
    }
  } catch {
    /* fall through to passphrase derivation */
  }
  return scryptSync(trimmed, SCRYPT_SALT, KEY_BYTES);
}

function keyFromFile(keyFilePath: string): Buffer {
  let raw: string;
  try {
    raw = fs().readFileSync(keyFilePath, "utf8");
  } catch {
    // 首次运行：生成并落盘（owner-only）。
    const key = randomBytes(KEY_BYTES);
    fs().writeFileSync(keyFilePath, `${key.toString("hex")}\n`, { mode: 0o600 });
    fs().chmodSync(keyFilePath, 0o600);
    return key;
  }
  const hex = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `credential.key (${keyFilePath}) 内容非法——期望 64 位 hex。` +
        "若是迁移/误改导致，请用 env MEDIA_TRACK_CREDENTIAL_KEY 指定原密钥，或删除该文件重新生成（旧密文将无法解密）",
    );
  }
  return Buffer.from(hex, "hex");
}

function modeOf(path: string): number {
  try {
    return fs().statSync(path).mode & 0o777;
  } catch {
    return -1;
  }
}

/**
 * 初始化（可重复调用，每次都重新解析密钥——测试靠它换钥）。
 * @param keyFilePath 密钥文件路径；传 ":memory:" 或省略且 ephemeral=true 时用进程内临时密钥
 * @param ephemeral 强制不落盘（:memory: 数据库 / 单元测试）
 */
export function initCredentialCrypto(options?: { keyFilePath?: string; ephemeral?: boolean }): void {
  const envKey = process.env.MEDIA_TRACK_CREDENTIAL_KEY?.trim();
  if (envKey) {
    cachedKey = keyFromEnv(envKey);
    return;
  }
  const keyFilePath = options?.keyFilePath;
  if (options?.ephemeral || !keyFilePath || keyFilePath === ":memory:") {
    cachedKey = randomBytes(KEY_BYTES);
    return;
  }
  cachedKey = keyFromFile(keyFilePath);
}

/** 是否已初始化（进程内）。仓储构造函数用它避免覆盖工厂已解析的密钥。 */
export function isCredentialCryptoInitialized(): boolean {
  return cachedKey !== null;
}

/**
 * 按数据库路径初始化凭据加密（密钥文件与库同目录的 credential.key）。
 * 仓储工厂、迁移脚本、运维工具都走这一条规则——单一事实源。
 * `:memory:` 用进程内临时密钥，不落盘。
 */
export function initCredentialCryptoForDatabase(dbPath: string): void {
  if (dbPath === ":memory:") {
    initCredentialCrypto({ ephemeral: true });
    return;
  }
  const absolute = nodePath().resolve(dbPath);
  fs().mkdirSync(nodePath().dirname(absolute), { recursive: true });
  initCredentialCrypto({ keyFilePath: nodePath().join(nodePath().dirname(absolute), "credential.key") });
}

function requireKey(): Buffer {
  if (!cachedKey) {
    initCredentialCrypto({ ephemeral: true });
  }
  return cachedKey as Buffer;
}

/** 是否已是本模块的密文（旧明文没有前缀）。 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", requireKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) {
    return stored; // 旧明文：迁移兼容
  }
  const blob = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error("credential ciphertext is truncated");
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", requireKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** 测试辅助：当前密钥文件的权限位（-1 表示不存在）。 */
export function credentialKeyFileMode(keyFilePath: string): number {
  return modeOf(keyFilePath);
}

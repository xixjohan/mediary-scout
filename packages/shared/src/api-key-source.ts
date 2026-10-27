/**
 * API Key 解析策略（S5.2，需求 #3）。
 *
 * 优先级：**数据库 > 环境变量 > 未配置**。env 是部署期注入的（docker -e），
 * 页面改的是 DB —— “数据库优先”让设置页的修改立即生效，且能覆盖一个遗留的
 * env 值；env-only 时页面无法撤销（只能改部署），这一点由 origin 字段告知 UI。
 *
 * 模式：策略。两个 ApiKeySource（env / db）由本函数按优先级选路，
 * 与 createBrandPacer、StorageExecutor 工厂同一套路；store 是端口
 * （IApiKeyStore 定义就在本文件），不绑定 SQLite。
 */

import { randomBytes } from "node:crypto";

/** app_settings 里的键名。落盘前由 SQLite 侧的 SECRET_SETTING_KEYS 透明加密。 */
export const API_KEY_SETTING_KEY = "api_key";

export type ApiKeyOrigin = "db" | "env" | "none";

export interface ResolvedApiKey {
  /** 生效的 key；none 时为 null */
  readonly value: string | null;
  /** 来源——UI 据此提示「当前生效来自环境变量，无法在页面撤销」 */
  readonly origin: ApiKeyOrigin;
}

/** 读取 API key 的最小端口：实现方可以是 SQLite、内存（测试）或未来的远端配置。 */
export interface IApiKeyStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 生成一枚新的 API key：32 字节密码学随机 → 64 位十六进制。
 *
 * 设置页「创建/轮换」用；完整值只在创建响应里出现一次（之后只剩掩码）。
 * 随机源用 node:crypto.randomBytes——本包既有 credential-crypto 同样从这里取
 * 熵（shared 只在服务端被 import，不进浏览器 bundle；客户端组件要显示状态就
 * 收 props，别 import 本模块）。
 */
export function generateApiKey(): string {
  return randomBytes(32).toString("hex");
}

/** 只露末 4 位；短于 4 位全打点（不泄露长度）。 */
export function maskApiKey(value: string | null): string {
  if (!value || value.length < 4) return "••••";
  return `••••${value.slice(-4)}`;
}

/**
 * 解析当前生效的 API key。
 *
 * DB 优先的语义细节：DB 里存了空串视为「用户清空了」，回落到 env ——
 * 否则页面一次清空就会把实例锁死（env 还在却不再生效）。
 */
export async function resolveApiKey(
  env: Record<string, string | undefined>,
  store: IApiKeyStore,
): Promise<ResolvedApiKey> {
  const fromDb = nonEmpty(await store.get());
  if (fromDb !== null) return { value: fromDb, origin: "db" };
  const fromEnv = nonEmpty(env.MEDIA_TRACK_API_KEY);
  if (fromEnv !== null) return { value: fromEnv, origin: "env" };
  return { value: null, origin: "none" };
}

import {
  generateApiKey,
  maskApiKey,
  resolveApiKey,
  type ApiKeyOrigin,
  type IApiKeyStore,
} from "@media-track/shared";

/**
 * S5.5（需求 #5）：设置页 API Key 管理状态机。
 *
 * 读三态（db / env / none）直接复用 S5.2 的 resolveApiKey——同一份优先级
 * （DB > env > 未配置），UI 只是它的展示层。写只有两个动作：
 *   · 轮换：生成新 key（或收用户显式粘贴的值）写 DB，返回**一次性完整值**；
 *   · 清除：只清 DB。env 态拒绝——页面改不了部署期注入的值，清也清不掉，
 *     返回 reason 让 UI 说明白，而不是假装成功。
 */

/** 与 IApiKeyStore 同形；单独起名是为了让测试的内存实现不必依赖 shared 的类型导入路径。 */
export type ApiKeyManagementStore = IApiKeyStore;

export interface ApiKeyState {
  readonly origin: ApiKeyOrigin;
  /** 只露末 4 位；未配置为 null */
  readonly masked: string | null;
  readonly configured: boolean;
}

export interface ApiKeyRotation {
  /** 完整值——只在这一次响应里出现，之后服务端只剩掩码 */
  readonly apiKey: string;
  readonly masked: string;
  readonly origin: "db";
}

export type ApiKeyClearResult =
  | { cleared: true; origin: ApiKeyOrigin; masked: string | null }
  | { cleared: false; reason: "env-backed" };

export async function readApiKeyState(
  env: Record<string, string | undefined>,
  store: ApiKeyManagementStore,
): Promise<ApiKeyState> {
  const resolved = await resolveApiKey(env, store);
  return {
    origin: resolved.origin,
    masked: resolved.value === null ? null : maskApiKey(resolved.value),
    configured: resolved.value !== null,
  };
}

/** 显式（用户粘贴）apiKey 的最小长度；生成值固定 64 位十六进制，不受此限。 */
const MIN_EXPLICIT_API_KEY_LENGTH = 16;

export async function rotateApiKey(
  store: ApiKeyManagementStore,
  explicitValue?: string,
): Promise<ApiKeyRotation> {
  const trimmed = explicitValue?.trim();
  // 显式值也要有强度下限：这个 key 是**长期实例凭据**（换 JWT 的钥匙），
  // 允许 1 字符等于把认证交给人手输入。16 位起，低于此直接拒并滚回去。
  if (trimmed !== undefined && trimmed.length > 0 && trimmed.length < MIN_EXPLICIT_API_KEY_LENGTH) {
    throw new Error(`显式 apiKey 长度太短：至少需要 ${MIN_EXPLICIT_API_KEY_LENGTH} 个字符`);
  }
  const apiKey = trimmed && trimmed.length > 0 ? trimmed : generateApiKey();
  await store.set(apiKey);
  // 写库后 origin 必然是 db：resolveApiKey 的 DB 优先语义保证立即生效，
  // 哪怕 env 里还躺着一个旧值（轮换的意义就是盖掉它）。
  return { apiKey, masked: maskApiKey(apiKey), origin: "db" };
}

export async function clearApiKey(
  env: Record<string, string | undefined>,
  store: ApiKeyManagementStore,
): Promise<ApiKeyClearResult> {
  const current = await resolveApiKey(env, store);
  if (current.origin === "env") {
    // DB 本就是空的（否则 origin 会是 db）——不清任何东西，只告知。
    return { cleared: false, reason: "env-backed" };
  }
  await store.clear();
  if (current.origin === "none") {
    return { cleared: true, origin: "none", masked: null };
  }
  // 清掉 DB 后重新解析：env 有值则回落到 env（不锁死实例），否则 none。
  const after = await resolveApiKey(env, store);
  return {
    cleared: true,
    origin: after.origin,
    masked: after.value === null ? null : maskApiKey(after.value),
  };
}

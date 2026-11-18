/**
 * STRM 播放签名的单一 secret 来源。
 *
 * 缺陷原型（2026-11-17 实测）：`apps/updater/...` 之外，`strm-writer.ts` 的
 * `resolveStrmSigningSecret()` 在**没有任何环境变量**时会回退到硬编码常量
 * `"mediary-scout-strm-signing-secret"`。于是：
 *
 *  - 任何读过本仓库源码的人都能离线伪造 `token`（实测：用该常量算出的 HMAC
 *    在 dev 实例上返回 200 并开始推流）；
 *  - `.strm` 文件的有效期默认 **365 天**，一次泄露等于长期授权；
 *  - 生产/开发共用同一个回退值，换个实例不会换密钥。
 *
 * 修法不是「再加一个 env 开关」，而是**让签名 secret 与实例的 JWT secret 同源**：
 * 实例级随机生成、落库（`app_settings.jwt_secret`，已登记为 `SECRET_SETTING_KEYS`
 * 加密存储）、跨重启稳定。这样：
 *  1. 没有硬编码可伪造的常量；
 *  2. 同一个实例签发的 `.strm` 与登录 token 共用一份密钥（少一个要运维的旋钮）；
 *  3. 换实例 = 换密钥，旧 `.strm` 自然失效（重新生成即恢复）。
 *
 * 为什么不做「启动时写进 process.env」：`resolveStrmSigningSecret()` 是同步的，
 * 而读库是异步。把 secret 塞进 env 会让「谁先启动」决定行为（web / host-worker
 * 各自一份），且进程重启后 env 里的值就丢了。改为：**启动时预热一条 env 变量**
 * （`STRM_SECRET` 仍然优先，供外部编排显式覆盖），未预热则退到 JWT secret 的
 * 同步缓存；两者都没有时**显式报错**而不是回退到常量。
 */

const ENV_KEYS = ["STRM_SECRET", "APP_SECRET"] as const;

/**
 * 进程内缓存，**挂在 globalThis 上**而不是模块级变量。
 *
 * 为什么必须这样（真机实测 2026-11-17）：Next 16 的 Turbopack 会把
 * `@media-track/workflow` 复制进多个 server chunk —— 「启动期预热」那段和
 * 「生成 .strm」那段各自持有一份模块实例。模块级 `let cachedSigningSecret`
 * 于是变成两份独立状态：预热打印成功、写文件时仍抛
 * `STRM_SIGNING_SECRET_UNAVAILABLE`，`.strm` 全部生成失败（HTTP 500）。
 * globalThis 是进程级唯一的，跨 chunk 共享。
 */
const CACHE_KEY = "__mediary_strm_signing_secret__";

type SecretCacheHost = { [CACHE_KEY]?: string | null };
const host = globalThis as unknown as SecretCacheHost;

/** 启动期预热（web instrumentation、host-worker 入口各调一次）。 */
export function primeStrmSigningSecret(secret: string): void {
  const trimmed = secret.trim();
  if (trimmed.length < 16) {
    throw new Error("STRM signing secret 过短（至少 16 字符），拒绝使用");
  }
  host[CACHE_KEY] = trimmed;
}

/** 仅供测试：清掉缓存，恢复未预热状态。 */
export function _resetStrmSigningSecretForTests(): void {
  host[CACHE_KEY] = null;
}

/**
 * 取当前生效的签名 secret。顺序：显式 env → 启动预热值 → 抛错。
 *
 * **刻意没有硬编码回退**：缺 secret 时让签名生成失败是安全的（没人能伪造），
 * 静默回退到一个公开常量才是危险的（任何人都能伪造）。
 */
export function resolveStrmSigningSecret(): string {
  for (const key of ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value && value.length >= 16) return value;
  }
  const cached = host[CACHE_KEY];
  if (cached) return cached;
  throw new Error(
    "STRM_SIGNING_SECRET_UNAVAILABLE: 未配置 STRM_SECRET/APP_SECRET，且启动期未预热签名密钥。" +
      "生产路径会自动使用实例 JWT secret（见 apps/web/instrumentation-node.ts 的预热步骤）；" +
      "本错误意味着在无实例上下文的进程中构造了签名 URL。",
  );
}

/** 该 secret 是否可用（不抛错版本，供启动自检/门禁使用）。 */
export function hasStrmSigningSecret(): boolean {
  try {
    resolveStrmSigningSecret();
    return true;
  } catch {
    return false;
  }
}

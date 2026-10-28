import { decryptSecret } from "@media-track/shared";
import {
  FallbackResourceProvider,
  PanSouResourceProvider,
  type PanSouAuth,
  type PanSouFetchJson,
  type ResourceProvider,
  type ResourceType,
} from "@media-track/workflow";

/** 去掉首尾空白与尾随斜杠,使 `https://x` 与 `https://x/` 判为同一个源。 */
export function normalizePanSouBaseUrl(baseURL: string | null | undefined): string {
  return (baseURL ?? "").trim().replace(/\/+$/, "");
}

/** 官方公共 PanSou。用户留空时的默认，也是自建源挂掉时的退路。 */
export const DEFAULT_PANSOU_BASE_URL = "https://so.252035.xyz";

/** 自建搜索源的凭据。三个键都只写库、不走 env —— 凭据下沉到 compose/.env 会让
 *  它出现在 `docker inspect`、进程环境和每一次 compose  diff 里，那是把秘密
 *  交给了错误的保管层。密码与令牌用 shared 的 enc:v1: 信封加密后落库。 */
export const PANSOU_USERNAME_SETTING_KEY = "pansou_username";
export const PANSOU_PASSWORD_SETTING_KEY = "pansou_password";
export const PANSOU_TOKEN_SETTING_KEY = "pansou_token";

/** 解密一个设置值；空/未配返回 undefined。解密失败（密钥换了、密文被截断）时
 *  返回 undefined 而不是抛出：一处坏凭据不该让整个搜索路径崩掉，调用方会把它
 *  当成「没配」处理，用户在下一次保存时自然覆盖它。 */
function readSecret(
  entries: Record<string, string | null>,
  key: string,
): string | undefined {
  const stored = entries[key];
  if (!stored) return undefined;
  try {
    const plain = decryptSecret(stored).trim();
    return plain ? plain : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析自建搜索源的认证形态。与 getPanSouBaseUrl 同层，但**没有 env 兜底**
 * （见键上方注释）。
 *
 * 优先级：token > 用户名+密码 > 无认证。token 优先是规格明确的互斥规则 ——
 * 粘贴的令牌是用户明确指定「用这一个」，不该被一份可能已过期的旧密码覆盖。
 *
 * 「只配了一半」按无认证处理，绝不拿一半配置去登录：一个没有密码的用户名
 * 发出去只会得到 401，而那会被报成「认证失败」，把用户引向错误的排查方向。
 */
export async function getPanSouAuth(repository: {
  getSetting: (key: string) => Promise<string | null>;
}): Promise<PanSouAuth> {
  const entries: Record<string, string | null> = {};
  for (const key of [
    PANSOU_TOKEN_SETTING_KEY,
    PANSOU_USERNAME_SETTING_KEY,
    PANSOU_PASSWORD_SETTING_KEY,
  ]) {
    entries[key] = await repository.getSetting(key);
  }
  const token = readSecret(entries, PANSOU_TOKEN_SETTING_KEY);
  if (token) {
    return { kind: "bearer", token };
  }
  const username = entries[PANSOU_USERNAME_SETTING_KEY]?.trim();
  const password = readSecret(entries, PANSOU_PASSWORD_SETTING_KEY);
  if (username && password) {
    return { kind: "login", username, password };
  }
  return { kind: "none" };
}

/**
 * 解析「用户自己的源」：DB 设置 > env PANSOU_BASE_URL > 空。
 *
 * env 这一层不能省。compose 用 `PANSOU_BASE_URL: http://pansou` 把自带容器注进来，
 * 而 DB 设置是空的；只读 DB 会让每个自部署实例悄悄改用官方公共源 —— 既没了自带
 * 容器，也没了 fallback 兜底，正是本 PR 要消灭的那类静默降级。
 *
 * 注意与 getPanSouBaseUrl 的分工：那个函数把三层压成「最终用哪个地址」，这里要的是
 * 「用户到底配没配」—— 空串与官方地址必须可区分，否则 hasCustom 判不出来。
 */
export function resolveUserPanSouBaseUrl(
  dbValue: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  return dbValue?.trim() || env.PANSOU_BASE_URL?.trim() || "";
}

/**
 * 装配 PanSou 检索链。抽成纯函数是为了让「什么时候该包 fallback」可以被单测
 * —— 这个判断以前埋在 getWorkerResourceProvider 里，测不到。
 *
 * 只有用户配了**自己的**源才需要 fallback：没配（或配的就是官方源）时无处可退，
 * 包一层只会让每次失败白跑两遍。
 */
export function buildPanSouProviderChain(input: {
  userBaseURL: string;
  allowedTypes: ResourceType[];
  /** 这台自建源要不要认证、怎么认证。**只传给 primary**：官方公共源没有认证，
   *  把用户的令牌带到官方源去既无用、又会把凭据泄露给第三方。 */
  auth?: PanSouAuth | undefined;
  /** 测试 seam：与 PanSouResourceProviderOptions.fetchJson 同义，透传下去。
   *  没有它就断言不了「认证头一路带到了最终 provider」。 */
  fetchJson?: PanSouFetchJson | undefined;
  /** 每次搜索后把「自建源这次行不行」记下来。设置页徽章每 8s 轮询,绝不能在那条
   *  路径上真打网络,所以只能由真实搜索顺手回写。
   *
   *  没有这个回调,告警在生产中永远不会触发 —— 保存时探活只会写 "ok",而
   *  **本次事故正是「保存时是好的、之后才挂」**:源工作了一段时间、然后死了
   *  6 天,而没有任何一条路径会把那个失败记下来。Copilot 评审指出了这一点。 */
  onSourceHealth?: (healthy: boolean) => void;
}): ResourceProvider {
  // 归一化后再比:用户把官方地址填成带尾斜杠的 `.../`(很常见)时,字符串直比会
  // 误判成「自建源」,于是白包一层 fallback —— 失败时跑两遍、还把结果标 degraded。
  const user = normalizePanSouBaseUrl(input.userBaseURL);
  const hasCustom = user !== "" && user !== DEFAULT_PANSOU_BASE_URL;
  if (!hasCustom) {
    return new PanSouResourceProvider({
      baseURL: user || DEFAULT_PANSOU_BASE_URL,
      allowedTypes: input.allowedTypes,
    });
  }
  const primary = new PanSouResourceProvider({
    baseURL: user,
    allowedTypes: input.allowedTypes,
    auth: input.auth,
    fetchJson: input.fetchJson,
  });
  return new FallbackResourceProvider({
    primary: {
      name: "自建搜索源",
      provider: input.onSourceHealth
        ? observeHealth(primary, input.onSourceHealth)
        : primary,
    },
    secondary: {
      name: "官方搜索源",
      provider: new PanSouResourceProvider({
        baseURL: DEFAULT_PANSOU_BASE_URL,
        allowedTypes: input.allowedTypes,
      }),
    },
  });
}

/**
 * 包一层只做一件事:把主源这次搜索的健康结论回报出去,不改变任何行为。
 * 导出仅为可测:这是「告警能否在生产触发」的唯一信号来源,必须被直接钉住。
 * 抛出的异常原样重抛(fallback 层需要看到它来分类病因),绝不吞。
 */
export function observeHealth(
  provider: ResourceProvider,
  report: (healthy: boolean) => void,
): ResourceProvider {
  return {
    search: async (searchInput) => {
      try {
        const snapshot = await provider.search(searchInput);
        const status = snapshot.sourceHealth?.status ?? "healthy";
        report(status === "healthy" || status === "degraded");
        return snapshot;
      } catch (error) {
        report(false);
        throw error; // 原样重抛:上层 fallback 要靠它分类 unreachable / protocol_error
      }
    },
  };
}

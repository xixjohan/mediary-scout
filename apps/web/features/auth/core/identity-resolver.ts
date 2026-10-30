import {
  DEFAULT_ACCOUNT_ID,
  UNAUTHENTICATED_ACCOUNT_ID,
  type ExecutionIdentityScope,
  type LoginPasswordState,
} from "../contracts/auth-tokens";

/**
 * 判断请求是否为远程请求（来自 Cloudflare Tunnel / 反向代理）。
 */
export function isRemoteRequest(hdrs: Headers): boolean {
  return hdrs.has("cf-ray") || hdrs.has("cdn-loop") || hdrs.has("cf-connecting-ip");
}

/**
 * 单用户模式下的身份裁决：与 auth-chain（闸机）必须同账号。
 *
 *   · 未设密码 + LAN → 默认账号。
 *   · 设了密码 + LAN → 只有 acct_default 自己的 session 能进。
 *   · 读不出密码状态 ("unknown") → LAN 宽容放行。
 *   · 远程 → 一律需 acct_default 自己的 session。
 */
export function resolveSingleUserAccountId(opts: {
  hasPassword: LoginPasswordState;
  isRemote: boolean;
  sessionAccountId: string | null;
}): string {
  if (!opts.isRemote && opts.hasPassword !== true) return DEFAULT_ACCOUNT_ID;
  if (opts.sessionAccountId === DEFAULT_ACCOUNT_ID) return DEFAULT_ACCOUNT_ID;
  return UNAUTHENTICATED_ACCOUNT_ID;
}

/**
 * 纯函数裁决器：根据传入的身份解析上下文计算出最终 accountId。
 */
export function resolveAccountFromIdentityScope(opts: {
  scope: ExecutionIdentityScope;
  hasPassword: LoginPasswordState;
  isMultiUser: boolean;
  sessionAccountId: string | null;
  bearerAccountId: string | null;
  isRemote: boolean;
}): string {
  if (opts.scope.type === "background-worker") {
    return opts.scope.accountId ?? DEFAULT_ACCOUNT_ID;
  }

  if (!opts.isMultiUser) {
    if (!opts.isRemote) {
      return resolveSingleUserAccountId({
        hasPassword: opts.hasPassword,
        isRemote: false,
        sessionAccountId: opts.sessionAccountId,
      });
    }
    if (opts.bearerAccountId === DEFAULT_ACCOUNT_ID) {
      return opts.bearerAccountId;
    }
    return resolveSingleUserAccountId({
      hasPassword: opts.hasPassword,
      isRemote: true,
      sessionAccountId: opts.sessionAccountId,
    });
  }

  // 多用户模式：session 优先，Bearer 兜底
  if (opts.sessionAccountId) {
    return opts.sessionAccountId;
  }
  return opts.bearerAccountId ?? UNAUTHENTICATED_ACCOUNT_ID;
}

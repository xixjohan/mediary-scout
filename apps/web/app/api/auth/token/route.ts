import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import {
  buildThrottleKey,
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from "../../../../lib/login-throttle";
import {
  isMultiUserEnabled,
  getJwtSecret,
  getJwtTtlSeconds,
} from "../../../../lib/workflow-runtime";
import { DEFAULT_ACCOUNT_ID } from "@media-track/workflow";
import { issueToken, resolveApiKey, API_KEY_SETTING_KEY, maskApiKey } from "@media-track/shared";
import { getApiKeyV2Store } from "../../../../composition/runtime-container";

/** API key 无效的**唯一**对外文案。「未配置」与「key 错」同文案——否则攻击者
 *  能用一个不存在的 key 探出实例有没有开 API 访问（枚举）。 */
const INVALID_KEY_MESSAGE = "api key 无效";
const JWT_DEFAULT_TTL_SECONDS = 12 * 60 * 60;

/**
 * S5.3（需求 #2）：API key 换 JWT。
 *
 * POST /api/auth/token  { apiKey }
 *   → 200 { token, expiresIn, accountId, tokenType, permissions }
 *   → 401 { error:"api key 无效" }         （未配置/错 key/非字符串，统一）
 *   → 429 { error, retryAfterSec }          （限流锁定中）
 *
 * 之后所有接口用 `Authorization: Bearer <token>`（S5.4 接入责任链）。
 * key 本身永不再次出现——它是长期凭据，JWT 才是可轮换的短期凭据。
 */
export async function POST(request: NextRequest) {
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as { apiKey?: unknown } | null;
  const presented = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";

  // 限流身份：多用户按 key 前缀分桶没有意义（key 不是用户名），按 IP + 固定身份，
  // 与登录同一套 throttle（容量/锁定语义复用，不新开一套限流状态）。
  const throttleKey = buildThrottleKey(request.headers, "api-token");
  const verdict = checkLoginAllowed(throttleKey, Date.now());
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: "尝试过于频繁，请稍后再试。", retryAfterSec: verdict.retryAfterSec },
      { status: 429, headers: { "retry-after": String(verdict.retryAfterSec ?? 60) } },
    );
  }

  const accountId = DEFAULT_ACCOUNT_ID;
  const secret = await getJwtSecret();
  const ttl = getJwtTtlSeconds() ?? JWT_DEFAULT_TTL_SECONDS;

  // 1. 优先尝试 V2 API Key 树状钥匙库比对
  try {
    const keyStore = getApiKeyV2Store();
    const keyEntity = await keyStore.findKeyByPlainToken(presented);
    if (keyEntity) {
      recordLoginSuccess(throttleKey);
      await keyStore.touchLastUsed(keyEntity.id);
      const token = await issueToken(
        {
          sub: accountId,
          tokenType: "ApiKey",
          keyId: keyEntity.id,
          permissions: keyEntity.permissions,
        },
        secret,
        ttl
      );

      return NextResponse.json({
        token,
        tokenType: "Bearer",
        expiresIn: ttl,
        accountId,
        masked: keyEntity.maskedKey,
        origin: "db",
        permissions: keyEntity.permissions,
      });
    }
  } catch {
    // 降级继续检查
  }

  // 2. 回落到系统环境变量/旧版单枚 API Key 检查
  const { getWorkflowRepository } = await import("../../../../lib/workflow-runtime");
  const repository = getWorkflowRepository();
  const resolved = await resolveApiKey(process.env, {
    get: () => repository.getSetting(API_KEY_SETTING_KEY),
    set: (value) => repository.setSetting(API_KEY_SETTING_KEY, value),
    clear: () => repository.setSetting(API_KEY_SETTING_KEY, ""),
  });

  const ok =
    resolved.value !== null &&
    presented.length === resolved.value.length &&
    timingSafeEqualStr(presented, resolved.value);

  if (!ok) {
    recordLoginFailure(throttleKey, Date.now());
    return NextResponse.json({ error: INVALID_KEY_MESSAGE }, { status: 401 });
  }

  recordLoginSuccess(throttleKey);
  const token = await issueToken(
    {
      sub: accountId,
      tokenType: "ApiKey",
      keyId: "root_legacy_key",
      permissions: ["*"],
    },
    secret,
    ttl
  );

  return NextResponse.json({
    token,
    tokenType: "Bearer",
    expiresIn: ttl,
    accountId,
    masked: maskApiKey(resolved.value),
    origin: resolved.origin,
    permissions: ["*"],
  });
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

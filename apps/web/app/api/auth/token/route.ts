import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { buildThrottleKey, checkLoginAllowed, recordLoginFailure } from "../../../../lib/login-throttle";
import {
  isMultiUserEnabled,
  getJwtSecret,
  getJwtTtlSeconds,
} from "../../../../lib/workflow-runtime";
import { DEFAULT_ACCOUNT_ID } from "@media-track/workflow";
import { issueToken, resolveApiKey, API_KEY_SETTING_KEY, maskApiKey } from "@media-track/shared";

/** API key 无效的**唯一**对外文案。「未配置」与「key 错」同文案——否则攻击者
 *  能用一个不存在的 key 探出实例有没有开 API 访问（枚举）。 */
const INVALID_KEY_MESSAGE = "api key 无效";
const JWT_DEFAULT_TTL_SECONDS = 12 * 60 * 60;

/**
 * S5.3（需求 #2）：API key 换 JWT。
 *
 * POST /api/auth/token  { apiKey }
 *   → 200 { token, expiresIn, accountId }
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

  const { getWorkflowRepository } = await import("../../../../lib/workflow-runtime");
  const repository = getWorkflowRepository();
  // 端口适配：SQLite 读写在 app_settings（值由 SECRET_SETTING_KEYS 透明加密）。
  const resolved = await resolveApiKey(process.env, {
    get: () => repository.getSetting(API_KEY_SETTING_KEY),
    set: (value) => repository.setSetting(API_KEY_SETTING_KEY, value),
    clear: () => repository.setSetting(API_KEY_SETTING_KEY, ""),
  });

  // 恒定时间比较：key 是长期凭据，时序侧信道能让攻击者逐字符猜出来。
  const ok =
    resolved.value !== null &&
    presented.length === resolved.value.length &&
    timingSafeEqualStr(presented, resolved.value);

  if (!ok) {
    recordLoginFailure(throttleKey, Date.now());
    // 不区分「未配置」与「key 错」；不回显 masked key（那也是信息）。
    return NextResponse.json({ error: INVALID_KEY_MESSAGE }, { status: 401 });
  }

  // API key 是**实例级**凭据（不是 per-account）：单用户与多用户模式都落到
  // 默认账号。将来若要 per-account key，在设置页创建时记录 owner 即可——
  // resolveApiKey 的 IApiKeyStore 端口已为此留好位置。
  const accountId = DEFAULT_ACCOUNT_ID;
  const secret = await getJwtSecret();
  const ttl = getJwtTtlSeconds() ?? JWT_DEFAULT_TTL_SECONDS;
  const token = await issueToken({ sub: accountId }, secret, ttl);

  return NextResponse.json({
    token,
    tokenType: "Bearer",
    expiresIn: ttl,
    accountId,
    // 仅供设置页确认「当前哪个 key 生效」的掩码；完整值只在创建时出现。
    masked: maskApiKey(resolved.value),
    origin: resolved.origin,
  });
}

function timingSafeEqualStr(a: string, b: string): boolean {
  // 长度已在调用前比对；这里逐字符恒定时间比较。
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

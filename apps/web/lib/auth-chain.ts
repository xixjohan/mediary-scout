import { NextResponse, type NextRequest } from "next/server";
import {
  DEFAULT_ACCOUNT_ID,
  SESSION_COOKIE_NAME,
  isMultiUserEnabled,
  isRemoteRequest,
  resolveBearerAccountId,
  resolveSessionAccountId,
} from "./workflow-runtime";

/**
 * S5.4（需求 #2）：/api 认证责任链。每个需鉴权的 route 顶部一行：
 *
 *   const gate = await requireApiAccount(request);
 *   if (gate instanceof Response) return gate;
 *   const accountId = gate;
 *
 * 通道顺序（任一通过即认证）：
 *   1. session cookie（mt_session）—— 浏览器 SSR/客户端 fetch 零改动；
 *   2. Authorization: Bearer <jwt> —— API 客户端（jose/HS256，S5.3 签发）；
 *   3. 单用户 + 局域网 → 默认账号 —— **既有开放语义原样保留**
 *      （resolveSingleUserAccount：LAN 免登录、远程一律需 session）。
 *      去掉它 = 桌面端/脚本/E2E/局域网curl 全断，属于回归。
 *
 * 远程（cf-ray/cdn-loop/cf-connecting-ip）与多用户模式下无凭据一律拒绝
 * （fail-closed）。不放在 middleware：Next 16 + cacheComponents 下 middleware
 * 易踩静态渲染坑（方案文档 §5 S5.4）；漏路由由 ESLint L2 门禁兜底。
 *
 * 为什么不区分为什么失败：过期/篡改/未配 key 对客户端是同一个 401——
 * 防枚举（与 /api/auth/token 的统一文案同一理由）。
 */

/**
 * 解析请求的账号；无法认证返回 null。永不抛异常——调用方决定 401 形态。
 *
 * 通道 2 的 JWT 解码头是 `resolveBearerAccountId`（workflow-runtime）——
 * **刻意与 `getCurrentAccountId()` 共用一份实现**：守卫放行之后，路由仍要
 * 问「这是哪个账号」，两条路各写一份必然漂移（漂移的后果见那个函数的注释：
 * JWT 认证成功但账号作用域是哨兵）。这里的失败同样咽掉：过期/篡改与「没带
 * token」对下游不可区分。
 */
export async function resolveApiAccount(request: NextRequest): Promise<string | null> {
  // 通道 1：session cookie。
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (cookie) {
    const accountId = await resolveSessionAccountId(cookie);
    if (accountId) return accountId;
  }

  // 通道 2：Bearer JWT。验签失败（过期/篡改/错算法/错 secret）视同无凭据，
  // 继续走局域网判定——与「没带 token」不可区分。
  const bearerAccountId = await resolveBearerAccountId(request.headers);
  if (bearerAccountId) return bearerAccountId;

  // 通道 3：单用户实例的局域网直通（既有语义）。
  if (!isMultiUserEnabled() && !isRemoteRequest(request.headers)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return null;
}

/** 401 的统一文案：不区分为什么失败（防枚举），与 /api/auth/token 同一理由。 */
const UNAUTHORIZED_MESSAGE = "未登录，请先登录后再操作。";

/**
 * 路由顶部一行鉴权。成功 → 账号 id；失败 → 401 Response（直接 return 它）。
 * 用 `instanceof Response` 判别，TS 在守卫后窄化为 string。
 *
 * 返回类型刻意写成 `string | NextResponse`（而非宽泛的 Response）：路由普遍标注
 * `Promise<NextResponse>`，宽类型会让 `return gate` 在所有 QR 路由上报 TS2739。
 */
export async function requireApiAccount(request: NextRequest): Promise<string | NextResponse> {
  const accountId = await resolveApiAccount(request);
  if (accountId === null) {
    return NextResponse.json({ error: UNAUTHORIZED_MESSAGE }, { status: 401 });
  }
  return accountId;
}

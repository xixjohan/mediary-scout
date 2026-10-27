import { NextResponse, type NextRequest } from "next/server";
import {
  DEFAULT_ACCOUNT_ID,
  SESSION_COOKIE_NAME,
  hasLoginPassword,
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
  // 通道 1：session cookie。读取失败（DB 抖动）视同「这个通道没说话」——
  // 契约是「永不抛异常」，裸调会让路由 500：单用户 + LAN 带 cookie 的请求本该
  // 落到局域网默认账号，却会被一个 store 异常打死。
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (cookie) {
    try {
      const accountId = await resolveSessionAccountId(cookie);
      if (accountId) {
        if (isMultiUserEnabled()) return accountId;
        // 单用户：与 resolveSingleUserAccount 完全同一裁决（数据层权威），
        // 否则闸机认的账号与数据层作用域会对不上——只认 acct_default 自己的
        // session，别账号的残留 cookie 在此放行 = 「认证通过的陌生人」
        // （数据层随后会 fail-closed）。
        // S5.7：这里**不再要求 isRemote**。此前 LAN 忽略 session 是因为通道 3
        // 反正会发默认账号；现在通道 3 被「设了密码」挡住，session 必须自己
        // 承住，否则设了密码的实例在局域网里登录了也进不来。
        if (accountId === DEFAULT_ACCOUNT_ID) return accountId;
      }
    } catch {
      // 与通道 2 同一理由：读不到 ≠ 认证失败，继续问别的通道。
    }
  }

  // 通道 2：Bearer JWT。验签失败（过期/篡改/错算法/错 secret）视同无凭据，
  // 继续走局域网判定——与「没带 token」不可区分。
  const bearerAccountId = await resolveBearerAccountId(request.headers);
  if (bearerAccountId) {
    // 单用户模式与 resolveSingleUserAccount 同一裁决：只认默认账号自己的凭据
    // （M6/H3）。当前 /api/auth/token 只签 acct_default，但 per-account key 已在
    // 该路由的规划里，分歧必须先钉死，别等能利用了再补。
    // S5.7：这里**不再要求 isRemote**。此前 LAN 直接落到通道 3 拿默认账号，
    // Bearer 在局域网看不看得见都无所谓；现在通道 3 被「设了密码」挡住了，
    // JWT 必须自己承住——否则设了密码的实例，本地脚本拿 JWT 也进不来。
    if (isMultiUserEnabled()) return bearerAccountId;
    if (bearerAccountId === DEFAULT_ACCOUNT_ID) return bearerAccountId;
  }

  // 通道 3：单用户实例的局域网直通（既有语义）——设了访问密码后收起。
  // S5.7：「要登录」与请求来自哪里无关。此前只有经隧道的远程请求被门禁，
  // 站主在自己家网络上打开也看不到登录页；密码本来就是「这个实例要认证」的
  // 开关，没道理只拦外人。
  // 读不出密码状态（"unknown"）时放行：一次 DB 抖动不该把局域网用户锁在门外，
  // 远程的收紧由 proxy（不看 DB）负责，两侧各自 fail 在正确方向。
  // 数据层 resolveSingleUserAccount 对 LAN 恒返 DEFAULT_ACCOUNT_ID，所以这里
  // 只是闸机单侧收紧，两层仍同账号（不变式）。
  if (!isMultiUserEnabled() && !isRemoteRequest(request.headers)) {
    if ((await hasLoginPassword()) !== true) return DEFAULT_ACCOUNT_ID;
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

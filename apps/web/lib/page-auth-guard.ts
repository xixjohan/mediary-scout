import type { LoginPasswordState } from "./workflow-runtime";

/**
 * proxy 写入的 cookie 名，含义「这个请求经过了 proxy 的页面 matcher」。
 *
 * 为什么不直接用请求头（x-mediary-page-path）：根 layout 顶层 await 守卫才能让
 * redirect() 真正生效（放进 <Suspense> 时 NEXT_REDIRECT 被边界吞掉，页面照常
 * 200 —— S5.7 实测）。而顶层 await 读 headers() 会撞上 cacheComponents（PPR）的
 * 硬规则「请求期读取必须在 Suspense 边界内」，构建期直接失败。cookies() 不在该
 * 规则内（Next 自行按 Suspense 处理），于是改由 proxy 把信号写进 cookie。
 *
 * 关键性质：/login 不在 proxy 的 matcher 里 → 登录页请求拿不到这个 cookie →
 * 守卫自动跳过它。不需要在页面组件里写「别拦我」的特例，也就不可能写成环。
 */
export const PAGE_GUARD_COOKIE = "mt_page_guarded";

/**
 * S5.7：页面级登录守卫的判据（纯函数）。
 *
 * 为什么需要它：auth-chain 的通道 3 管的是 API 的权威判定，而浏览器打开
 * `/`、`/settings` 这些页面时并不经过 requireApiAccount()——页面各自用
 * getCurrentAccountId() 读数据。于是「设了密码」此前只影响了 API：局域网浏览器
 * 照样直进页面，只是数据接口会 401。要的是「打开页面就要登录」，必须在页面侧
 * 也有一个闸机。
 *
 * 放在哪：根 layout。它是服务端组件，能读 DB（拿到真实密码状态），也能读
 * session cookie。proxy 刻意不读 DB（Edge 运行时、无数据访问），所以由 proxy
 * 用请求头把「当前路径」透传进来——/login 不在 proxy 的 matcher 里，因此拿不到
 * 这个头，守卫自然跳过它**，不需要在页面组件里写特例。
 *
 * 三态（hasLoginPassword 的契约，见 workflow-runtime.ts 的注释）：
 *   `true`     设了密码 → 无 session 就送 /login（与来源无关：局域网也要登）
 *   `false`    没设密码 → 放行（既有「局域网零摩擦」语义不回归）
 *   `"unknown"`读不出来 → 放行。「读不到」不是「设了密码」：一次 DB 抖动就
 *               把局域网用户锁在登录页外，是把故障放大成拒绝服务。远程的
 *               收紧由 proxy（不看 DB、只看来源）负责，两侧各自 fail 在正确方向。
 */
export type PageAuthGuardInput = {
  /** proxy 写的 cookie 是否存在；不存在 = 这个请求没经过 proxy 的页面 matcher。 */
  guarded: boolean;
  passwordState: LoginPasswordState;
  hasSession: boolean;
};

export function shouldRedirectToLogin(input: PageAuthGuardInput): boolean {
  // 没有 guarded = 不该被页面守卫管（/login 自身——它不在 proxy 的 matcher 里，
  // 以及静态资源）。若对 /login 也拦，浏览器会陷入 /login → /login 的无限环。
  if (!input.guarded) return false;
  if (input.hasSession) return false;
  return input.passwordState === true;
}

/**
 * 服务端装配：读 cookies + 密码状态，按需 redirect("/login")。
 *
 * 为什么放在这里而不是 app/layout.tsx：layout 是 PPR 静态外壳的一部分，任何请求期
 * 读取（cookies/headers/connection）都会被 Next 以「Uncached data was accessed
 * outside of <Suspense>」拦在构建期；而放进 <Suspense> 后 redirect() 抛出的
 * NEXT_REDIRECT 又被边界吞掉，页面照常 200 渲染（S5.7 两条路都实测过，均不可行）。
 * page 级是动态渲染的，redirect 能正常转成 307。
 *
 * 每个页面入口顶部一行 `await requirePageLogin();` 即可。/login 自己**不要**调
 * 用它——它不在 proxy 的 matcher 里，拿不到 PAGE_GUARD_COOKIE，即便调了也会因
 * `guarded === false` 而直接放行，不可能成环。
 *
 * 读取失败（DB 抖动）一律放行：宁可少拦一次，不可把站主锁在门外。
 */
export async function requirePageLogin(): Promise<void> {
  const { cookies } = await import("next/headers");
  const { redirect } = await import("next/navigation");
  const { hasLoginPassword, SESSION_COOKIE_NAME } = await import("./workflow-runtime");
  let guarded = false;
  let hasSession = false;
  let passwordState: LoginPasswordState = "unknown";
  try {
    const store = await cookies();
    guarded = Boolean(store.get(PAGE_GUARD_COOKIE)?.value);
    // 没有守卫信号（/login 自身、静态资源）就直接放行，连密码状态都不读：
    // /login 是高频页面，每次多一次 DB 查询没有意义。
    if (!guarded) return;
    hasSession = Boolean(store.get(SESSION_COOKIE_NAME)?.value);
    passwordState = await hasLoginPassword();
  } catch {
    return;
  }
  if (shouldRedirectToLogin({ guarded, passwordState, hasSession })) {
    redirect("/login");
  }
}

/**
 * React 组件版守卫：放在页面的 <Suspense> 里（cacheComponents 的硬性要求）。
 *
 * redirect() 在 streaming 下会插一个 meta 标签让客户端跳转（Next 官方语义），
 * 因此 HTTP 状态码仍是 200——但 React 会在该边界抛出异常时中止渲染，原页面的
 * 数据不会进入 HTML（这一点由 e2e/实测确认，不能只信文档）。
 */
export async function PageLoginGuard() {
  await requirePageLogin();
  return null;
}

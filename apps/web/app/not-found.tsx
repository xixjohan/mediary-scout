import Link from "next/link";
import { Suspense } from "react";
import { PageLoginGuard } from "../lib/page-auth-guard";

/**
 * S5.7：未匹配路由（404）也要过页面守卫。
 *
 * 此前这里用 Next 的默认 404——它不在任何 page.tsx 里，「设了访问密码就要登录」
 * 于是在所有拼错的 URL 上静默失效（实测：设了密码的实例访问 /nonexistent 直接
 * 拿到 404 页，没有跳登录）。默认页不带任何用户数据，所以不是数据泄露，但违背
 * 「设了密码就要登录」的字面要求，且暴露的实例信息与 /login 等价。
 *
 * 守卫仍走 <Suspense>：cacheComponents 要求请求期读取在边界内，与 7 个页面入口
 * 同一理由（见 lib/page-auth-guard.ts）。
 */
export default function NotFound() {
  return (
    <>
      <Suspense fallback={null}>
        <PageLoginGuard />
      </Suspense>
      <div className="app-shell">
        <main className="main product-main">
          <h1 className="next-error-h1">404</h1>
          <p>这个页面不存在。</p>
          <p>
            <Link href="/">回到订阅</Link>
          </p>
        </main>
      </div>
    </>
  );
}

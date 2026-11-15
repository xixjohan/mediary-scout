import Link from "next/link";

/**
 * 403 页面（授权失败）。刻意与 404 / login 区分：用户已经登录，只是这个页面不给他看。
 *
 * 不 redirect——redirect 到 /login 会让用户以为自己掉登录了，反复重登还是看不到，
 * 变成无解的死循环。这里明确说出「权限不足」并给出可去的入口。
 */
export function PageAccessDenied({
  required,
  verdict,
}: {
  required: string;
  verdict: "login" | "deny";
}) {
  const isLogin = verdict === "login";
  return (
    <div className="app-shell">
      <main className="main product-main">
        <section className="panel" style={{ maxWidth: 560, margin: "4rem auto", textAlign: "center" }}>
          <div className="panel-header" style={{ justifyContent: "center" }}>
            <span className="panel-title">{isLogin ? "请先登录" : "权限不足"}</span>
          </div>
          <p className="panel-note" style={{ lineHeight: 1.7, color: "var(--text-muted)" }}>
            {isLogin
              ? "当前会话未通过身份校验，请重新登录后再访问此页面。"
              : "当前账号的角色不包含访问此页面所需的权限。如需访问，请联系站长调整角色权限。"}
          </p>
          <p className="panel-note" style={{ marginTop: "0.5rem", fontSize: 11, opacity: 0.7 }}>
            所需权限：{required}
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: "1.5rem" }}>
            <Link className="btn btn-primary" href={isLogin ? "/login" : "/"}>
              {isLogin ? "前往登录" : "回到首页"}
            </Link>
            {!isLogin ? (
              <Link className="btn btn-secondary" href="/activity">
                查看活动
              </Link>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}

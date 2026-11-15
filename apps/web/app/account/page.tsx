import { Suspense } from "react";
import { connection } from "next/server";
import { ClientLoginRedirect } from "../../features/auth/components/client-login-redirect";
import { AppSidebar } from "../../components/layout/app-sidebar";
import { GitHubNameplate } from "../../components/layout/github-nameplate";
import { PasswordChangeForm } from "../../features/settings-system/components/password-change-form";
import { PageLoginGuard } from "../../lib/page-auth-guard";
import { resolveVisibilityFromPermissions } from "../../features/auth/core/nav-visibility";
import {
  getCurrentAccountId,
  getCurrentAccountSummary,
  resolveGlobalWorkspace,
  UNAUTHENTICATED_ACCOUNT_ID,
} from "../../lib/workflow-runtime";
import { resolvePageAccess } from "../../lib/page-permission-guard";
import { KeyRound, ShieldCheck, UserRound } from "lucide-react";

/**
 * 个人账号页（/account）。
 *
 * 存在的理由：`/settings` 是**实例配置面**（TMDB Key、代理、角色、用户），成员不该进去；
 * 但「改自己的密码」是**个人面**，成员必须有。把两者混在一个页面上再用"例外"区分权限，
 * 会让页面守卫长出一堆分区分支；独立路由保持「一个页面 = 一个权限域」这条不变量。
 *
 * 因此本页**不做权限判定**——登录即可访问。真正的改密校验在服务端
 * （`changeOwnPassword` 校验当前密码 + 改后删除本人全部 session + bump 安全版本号）。
 */
export default function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  return (
    <>
      <Suspense fallback={null}>
        <PageLoginGuard />
      </Suspense>
      <Suspense fallback={<AccountShell />}>
        <AccountSurface searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function AccountShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="settings" skeleton />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function AccountSurface({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  await connection();
  const accountId = await getCurrentAccountId();
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) {
    return (
      <>
        <ClientLoginRedirect />
        <AccountShell />
      </>
    );
  }
  const summary = await getCurrentAccountSummary();
  const workspace = await resolveGlobalWorkspace((await searchParams).w);
  const access = await resolvePageAccess();
  // 侧边栏沿用同一份可见性：成员在这里也看不到设置/网盘入口。
  const navVisibility = access.isOwner
    ? resolveVisibilityFromPermissions(new Set(["*"]))
    : resolveVisibilityFromPermissions(access.permissions);

  return (
    <div className="app-shell">
      <AppSidebar
        active="settings"
        basePath={workspace.basePath}
        activeStorageId={workspace.activeStorageId}
        visibility={navVisibility}
      />
      <main className="main product-main">
        <div className="section-heading library-heading">
          <div>
            <h1>我的账号</h1>
            <p>个人资料与登录密码</p>
          </div>
        </div>

        <section className="panel" style={{ maxWidth: 720 }}>
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <UserRound size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
                个人资料
              </h2>
              <p className="panel-note">账号信息由站长创建，如需修改用户名请联系站长</p>
            </div>
          </div>
          <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "10px 20px", fontSize: 13 }}>
            <dt style={{ color: "var(--text-muted)" }}>用户名</dt>
            <dd style={{ margin: 0 }}>{summary?.username ?? "-"}</dd>
            <dt style={{ color: "var(--text-muted)" }}>角色</dt>
            <dd style={{ margin: 0 }}>{summary?.isOwner ? "站长" : "标准成员"}</dd>
          </dl>
        </section>

        <section id="password" className="panel" style={{ maxWidth: 720, marginTop: 20 }}>
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <KeyRound size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
                修改密码
              </h2>
              <p className="panel-note">
                需要验证当前密码。修改成功后本账号的全部登录会话立即失效，需用新密码重新登录；
                已签发的 API Key 也会同步失效。
              </p>
            </div>
          </div>
          <PasswordChangeForm />
        </section>

        <section className="panel" style={{ maxWidth: 720, marginTop: 20 }}>
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <ShieldCheck size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
                安全说明
              </h2>
            </div>
          </div>
          <p className="panel-note" style={{ lineHeight: 1.7 }}>
            密码使用 scrypt 加盐哈希存储，服务端从不落明文。改密会同时提升账号安全版本号，
            使此前签发的 API Key 一并失效——这防止「改了密码但旧 Key 还能用」的假安全感。
          </p>
        </section>

        <GitHubNameplate />
      </main>
    </div>
  );
}

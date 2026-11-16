import { Suspense } from "react";
import { connection } from "next/server";
import { PageLoginGuard } from "../../lib/page-auth-guard";
import { decidePageAccess, hasPermission, resolvePageAccess } from "../../lib/page-permission-guard";
import { PageAccessDenied } from "../../features/auth/components/page-access-denied";
import { resolveVisibilityFromPermissions } from "../../features/auth/core/nav-visibility";
import { ClientLoginRedirect } from "../../features/auth/components/client-login-redirect";
import { AppSidebar } from "../../components/layout/app-sidebar";
import { GitHubNameplate } from "../../components/layout/github-nameplate";
import {
  getAccountConnectedStorages,
  getCurrentAccountId,
  getWorkflowRepository,
  resolveGlobalWorkspace,
  UNAUTHENTICATED_ACCOUNT_ID,
} from "../../lib/workflow-runtime";
import { LibraryView } from "../../features/library/components/library-view";

export default function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  return (
    <>
      <Suspense fallback={null}>
        <PageLoginGuard />
      </Suspense>
      <Suspense fallback={<LibraryShell />}>
        <LibrarySurface searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function LibraryShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="medialib" skeleton />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function LibrarySurface({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  await connection();
  const accountId = await getCurrentAccountId();
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) {
    return (
      <>
        <ClientLoginRedirect />
        <LibraryShell />
      </>
    );
  }

  const { w } = await searchParams;
  // 决策 1 明确「查看影视库内容允许」：页面本身只要 media:detail（站主通配符放行）。
  const verdict = decidePageAccess(await resolvePageAccess(), "media:detail");
  if (verdict !== "allow") {
    return <PageAccessDenied required="media:detail" verdict={verdict} />;
  }
  // 工作区已按存储范围策略解析出归属账号（shared 模式下是站长），库必须用同一个
  // 账号读，否则成员看到的是自己名下那个空库列表。
  const workspace = await resolveGlobalWorkspace(w);
  const storages = await getAccountConnectedStorages(workspace.accountId);

  const repo = getWorkflowRepository();
  const libraries = repo.mediaLibraryStore.listLibraries(workspace.accountId);
  const access = await resolvePageAccess();
  const navVisibility = resolveVisibilityFromPermissions(access.permissions);
  // 决策 1：查看影视库允许，管理面（新建/扫描/路径/批量）要 library:manage。
  // 管理动作的入口在这里按权限下发；API 侧另有断言兜底（藏按钮不是关闭）。
  const canManageLibrary = hasPermission(access, "library:manage");

  return (
    <div className="app-shell">
      <AppSidebar
        active="medialib"
        basePath={workspace.basePath}
        activeStorageId={workspace.activeStorageId}
        visibility={navVisibility}
      />
      <main className="main product-main">
        <div className="section-heading library-heading" style={{ marginBottom: "1rem" }}>
          <div>
            <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: 0 }}>影视库</h1>
            <p style={{ color: "var(--text-muted, #a1a1aa)", fontSize: "0.9rem", margin: "0.25rem 0 0 0" }}>
              聚合多网盘影视资源，智能刮削、多季选集与直链极速免转码播放
            </p>
          </div>
        </div>

        <LibraryView initialLibraries={libraries} storages={storages} canManage={canManageLibrary} />
        <GitHubNameplate />
      </main>
    </div>
  );
}

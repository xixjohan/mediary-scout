import { Suspense } from "react";
import { connection } from "next/server";
import { PageLoginGuard } from "../../../lib/page-auth-guard";
import { ClientLoginRedirect } from "../../../features/auth/components/client-login-redirect";
import { AppSidebar } from "../../../components/layout/app-sidebar";
import { getCurrentAccountId, resolveGlobalWorkspace, UNAUTHENTICATED_ACCOUNT_ID } from "../../../lib/workflow-runtime";
import { decidePageAccess, resolvePageAccess } from "../../../lib/page-permission-guard";
import { PageAccessDenied } from "../../../features/auth/components/page-access-denied";
import { ExtensionManagerView } from "../../../features/extensions/components/extension-manager-view";

export default function ExtensionsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  return (
    <>
      <Suspense fallback={null}>
        <PageLoginGuard />
      </Suspense>
      <Suspense fallback={<ExtensionsSettingsShell />}>
        <ExtensionsSettingsSurface searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function ExtensionsSettingsShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="settings" skeleton />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function ExtensionsSettingsSurface({
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
        <ExtensionsSettingsShell />
      </>
    );
  }
  // 扩展管理属于实例配置面（可加载任意代码）：与 /settings 同一把钥匙，成员 403。
  const verdict = decidePageAccess(await resolvePageAccess(), "system:settings");
  if (verdict !== "allow") {
    return <PageAccessDenied required="system:settings" verdict={verdict} />;
  }
  const { w } = await searchParams;
  const workspace = await resolveGlobalWorkspace(w);

  return (
    <div className="app-shell">
      <AppSidebar
        active="settings"
        basePath={workspace.basePath}
        activeStorageId={workspace.activeStorageId}
      />
      <main className="main product-main">
        <ExtensionManagerView />
      </main>
    </div>
  );
}

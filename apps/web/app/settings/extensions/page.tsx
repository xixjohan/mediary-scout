import { Suspense } from "react";
import { connection } from "next/server";
import { PageLoginGuard } from "../../../lib/page-auth-guard";
import { ClientLoginRedirect } from "../../../features/auth/components/client-login-redirect";
import { AppSidebar } from "../../../components/layout/app-sidebar";
import { getCurrentAccountId, resolveGlobalWorkspace, UNAUTHENTICATED_ACCOUNT_ID } from "../../../lib/workflow-runtime";
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

import { Suspense } from "react";
import { PageLoginGuard } from "../../../lib/page-auth-guard";
import { AppSidebar } from "../../../components/layout/app-sidebar";
import { resolveGlobalWorkspace } from "../../../lib/workflow-runtime";
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
      <AppSidebar active="settings" />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function ExtensionsSettingsSurface({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
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

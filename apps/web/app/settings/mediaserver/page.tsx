import { Suspense } from "react";
import { PageLoginGuard } from "../../../lib/page-auth-guard";
import { AppSidebar } from "../../../components/layout/app-sidebar";
import { resolveGlobalWorkspace } from "../../../lib/workflow-runtime";
import { MediaServerConfigView } from "../../../features/mediaserver/components/mediaserver-config-view";

export default function MediaServerSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  return (
    <>
      <Suspense fallback={null}>
        <PageLoginGuard />
      </Suspense>
      <Suspense fallback={<MediaServerSettingsShell />}>
        <MediaServerSettingsSurface searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function MediaServerSettingsShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="settings" skeleton />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function MediaServerSettingsSurface({
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
        <MediaServerConfigView />
      </main>
    </div>
  );
}

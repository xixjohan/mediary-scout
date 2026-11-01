import { Suspense } from "react";
import { PageLoginGuard } from "../../../lib/page-auth-guard";
import { AppSidebar } from "../../../components/layout/app-sidebar";
import {
  getAccountConnectedStorages,
  resolveGlobalWorkspace,
} from "../../../lib/workflow-runtime";
import { StrmScheduleView } from "../../../features/strm/components/strm-schedule-view";

export default function StrmPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  return (
    <>
      <Suspense fallback={null}>
        <PageLoginGuard />
      </Suspense>
      <Suspense fallback={<StrmShell />}>
        <StrmSurface searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function StrmShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="storage" />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function StrmSurface({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  const { w } = await searchParams;
  const workspace = await resolveGlobalWorkspace(w);
  const storages = await getAccountConnectedStorages();

  return (
    <div className="app-shell">
      <AppSidebar
        active="storage"
        basePath={workspace.basePath}
        activeStorageId={workspace.activeStorageId}
      />
      <main className="main product-main">
        <StrmScheduleView
          storages={storages.map((s) => ({
            id: s.id,
            name: s.label || s.provider,
            provider: s.provider,
          }))}
        />
      </main>
    </div>
  );
}

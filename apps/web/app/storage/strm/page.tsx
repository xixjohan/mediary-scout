import { Suspense } from "react";
import { connection } from "next/server";
import { PageLoginGuard } from "../../../lib/page-auth-guard";
import { ClientLoginRedirect } from "../../../features/auth/components/client-login-redirect";
import { AppSidebar } from "../../../components/layout/app-sidebar";
import {
  getAccountConnectedStorages,
  getCurrentAccountId,
  resolveGlobalWorkspace,
  UNAUTHENTICATED_ACCOUNT_ID,
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
      <AppSidebar active="storage" skeleton />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function StrmSurface({
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
        <StrmShell />
      </>
    );
  }
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

import { Suspense } from "react";
import { connection } from "next/server";
import { PageLoginGuard } from "../../../lib/page-auth-guard";
import {
  decidePageAccess,
  resolvePageAccess,
} from "../../../lib/page-permission-guard";
import { resolveVisibilityFromPermissions } from "../../../features/auth/core/nav-visibility";
import { PageAccessDenied } from "../../../features/auth/components/page-access-denied";
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
  // STRM 任务计划属网盘运维面，与 /storage 同一把钥匙。
  const access = await resolvePageAccess();
  const verdict = decidePageAccess(access, "storage:browse_any");
  if (verdict !== "allow") {
    return <PageAccessDenied required="storage:browse_any" verdict={verdict} />;
  }
  const { w } = await searchParams;
  const workspace = await resolveGlobalWorkspace(w);
  const storages = await getAccountConnectedStorages();
  const navVisibility = resolveVisibilityFromPermissions(access.permissions);

  return (
    <div className="app-shell">
      <AppSidebar
        active="storage"
        basePath={workspace.basePath}
        activeStorageId={workspace.activeStorageId}
        visibility={navVisibility}
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

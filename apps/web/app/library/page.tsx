import { Suspense } from "react";
import { connection } from "next/server";
import { PageLoginGuard } from "../../lib/page-auth-guard";
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
  const workspace = await resolveGlobalWorkspace(w);
  const storages = await getAccountConnectedStorages(accountId);

  const repo = getWorkflowRepository();
  const libraries = repo.mediaLibraryStore.listLibraries(accountId);

  return (
    <div className="app-shell">
      <AppSidebar
        active="medialib"
        basePath={workspace.basePath}
        activeStorageId={workspace.activeStorageId}
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

        <LibraryView initialLibraries={libraries} storages={storages} />
        <GitHubNameplate />
      </main>
    </div>
  );
}

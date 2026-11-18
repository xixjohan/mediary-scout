import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { Download, FolderSync } from "lucide-react";
import { PageLoginGuard } from "../../lib/page-auth-guard";
import {
  decidePageAccess,
  resolvePageAccess,
} from "../../lib/page-permission-guard";
import { resolveVisibilityFromPermissions } from "../../features/auth/core/nav-visibility";
import { PageAccessDenied } from "../../features/auth/components/page-access-denied";
import { ClientLoginRedirect } from "../../features/auth/components/client-login-redirect";
import { AppSidebar } from "../../components/layout/app-sidebar";
import { GitHubNameplate } from "../../components/layout/github-nameplate";
import {
  getAccountConnectedStorages,
  getCurrentAccountId,
  resolveGlobalWorkspace,
  UNAUTHENTICATED_ACCOUNT_ID,
} from "../../lib/workflow-runtime";
import { StorageManagerView } from "../../features/storage-drives/components/storage-manager-view";

export default function StoragePage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string; dir?: string }>;
}) {
  return (
    <>
      <Suspense fallback={null}>
        <PageLoginGuard />
      </Suspense>
      <Suspense fallback={<StorageShell />}>
        <StorageSurface searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function StorageShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="storage" skeleton />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function StorageSurface({
  searchParams,
}: {
  searchParams: Promise<{ w?: string; dir?: string }>;
}) {
  await connection();
  const accountId = await getCurrentAccountId();
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) {
    return (
      <>
        <ClientLoginRedirect />
        <StorageShell />
      </>
    );
  }
  // 网盘运维页 = 浏览/整理盘上任意目录，需要 storage:browse_any。成员只有媒体库
  // 浏览权，这里直接 403（不 redirect：他确实登录了，只是这个页面不给）。
  const access = await resolvePageAccess();
  const verdict = decidePageAccess(access, "storage:browse_any");
  if (verdict !== "allow") {
    return <PageAccessDenied required="storage:browse_any" verdict={verdict} />;
  }
  const { w, dir } = await searchParams;
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
        <div className="section-heading library-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1>网盘管理</h1>
            <p>直接浏览、整理和管理已绑定的云网盘文件与目录</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Link
              href="/storage/strm"
              className="btn btn-secondary"
              style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
            >
              <FolderSync size={16} /> STRM 任务计划
            </Link>
            {/* 入口可见性只是体验：真正的边界是 /api/owner/ingest/* 的 requireOwner
                与 /storage/owner-ingest 的 OwnerPageGuard。判据用 isOwner 位，
                与 API 侧同一个来源（管理员有 storage:browse_any 但不是站长）。 */}
            {access.isOwner ? (
              <Link
                href="/storage/owner-ingest"
                className="btn btn-secondary"
                style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
              >
                <Download size={16} /> 关键字投放
              </Link>
            ) : null}
          </div>
        </div>
        <StorageManagerView
          storages={storages}
          initialStorageId={workspace.activeStorageId}
        />
        <GitHubNameplate />
      </main>
    </div>
  );
}

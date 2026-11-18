import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageLoginGuard } from "../../../lib/page-auth-guard";
import { OwnerPageGuard } from "../../../lib/owner-guard";
import { ClientLoginRedirect } from "../../../features/auth/components/client-login-redirect";
import { AppSidebar } from "../../../components/layout/app-sidebar";
import { GitHubNameplate } from "../../../components/layout/github-nameplate";
import {
  getAccountConnectedStorages,
  getCurrentAccountId,
  resolveGlobalWorkspace,
  UNAUTHENTICATED_ACCOUNT_ID,
} from "../../../lib/workflow-runtime";
import { NAV_ALL_VISIBLE, resolveVisibilityFromPermissions } from "../../../features/auth/core/nav-visibility";
import { resolvePageAccess } from "../../../lib/page-permission-guard";
import { OwnerIngestConsole } from "../../../features/storage-drives/components/storage/owner-ingest-console";

/**
 * 站长「关键字投放」页。
 *
 * 守卫双层：`OwnerPageGuard`（页面渲染，is_owner 位）与
 * `/api/owner/ingest/*` 的 `requireOwner`（真正的边界）。页面隐藏不是控制。
 */
export default function OwnerIngestPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  return (
    <>
      <Suspense fallback={null}>
        <PageLoginGuard />
      </Suspense>
      <Suspense fallback={<OwnerIngestShell />}>
        <OwnerIngestSurface searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function OwnerIngestShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="storage" skeleton />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function OwnerIngestSurface({
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
        <OwnerIngestShell />
      </>
    );
  }

  const workspace = await resolveGlobalWorkspace(undefined);
  // 侧边栏可见性只决定「要不要浪费一次点击」；真正的边界在 OwnerPageGuard
  // 与 /api/owner/ingest/*。
  //
  // 这里**读真实权限**而不是写死一个空集合：上一版传的是空 Set，
  // 结果站长的侧边栏在投放页上退化成「搜索/订阅/通知/活动」——验收时一眼可见。
  // 站长（isOwner 或 *）走 NAV_ALL_VISIBLE，其余按真实权限算。
  const access = await resolvePageAccess();
  const navVisibility = access.isOwner || access.permissions.has("*")
    ? NAV_ALL_VISIBLE
    : resolveVisibilityFromPermissions(access.permissions);
  void searchParams;

  return (
    <div className="app-shell">
      <AppSidebar
        active="storage"
        basePath={workspace.basePath}
        activeStorageId={workspace.activeStorageId}
        visibility={navVisibility}
      />
      <main className="main product-main">
        <Link
          className="nav-item"
          href="/storage"
          style={{ display: "inline-flex", marginBottom: 16 }}
        >
          <ArrowLeft size={16} aria-hidden />
          返回网盘管理
        </Link>
        <div className="section-heading library-heading">
          <div>
            <h1>关键字投放</h1>
            <p>按关键字检索资源并直接落到指定网盘目录；落盘确认后才计入入库。</p>
          </div>
        </div>
        {/* 非站长的子树根本不会被渲染：网盘列表等数据也就不会被读取。 */}
        <OwnerPageGuard>
          <OwnerIngestContent />
        </OwnerPageGuard>
        <GitHubNameplate />
      </main>
    </div>
  );
}

async function OwnerIngestContent() {
  await connection();
  const storages = await getAccountConnectedStorages();
  return <OwnerIngestConsole storages={storages} />;
}

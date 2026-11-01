import { Suspense } from "react";
import Link from "next/link";
import { FolderSync } from "lucide-react";
import { PageLoginGuard } from "../../lib/page-auth-guard";
import { AppSidebar } from "../../components/layout/app-sidebar";
import { GitHubNameplate } from "../../components/layout/github-nameplate";
import {
  getAccountConnectedStorages,
  resolveGlobalWorkspace,
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
      <AppSidebar active="storage" />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function StorageSurface({
  searchParams,
}: {
  searchParams: Promise<{ w?: string; dir?: string }>;
}) {
  const { w, dir } = await searchParams;
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
        <div className="section-heading library-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1>网盘管理</h1>
            <p>直接浏览、整理和管理已绑定的云网盘文件与目录</p>
          </div>
          <Link
            href="/storage/strm"
            className="btn btn-secondary"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <FolderSync size={16} /> STRM 任务计划
          </Link>
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

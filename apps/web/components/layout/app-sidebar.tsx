import { Suspense } from "react";
import Link from "next/link";
import { Activity, Aperture, Bell, Bot, HardDrive, Library, Settings } from "lucide-react";
import { resolveIsDesktop } from "../../lib/workflow-runtime";
import { globalNavHref } from "@media-track/workflow";
import { SearchNavLink } from "../../features/catalog/components/search-memory";
import { ActivityNavBadge } from "../../features/activity/components/activity-nav-badge";
import { NotificationsNavBadge } from "./notifications-nav-badge";
import { SettingsAttentionBadge } from "../../features/settings-system/components/settings-attention-badge";
import { WorkspaceSwitcherLoader } from "../../features/auth/components/workspace-switcher-loader";
import { AccountIdentityLoader } from "../../features/auth/components/account-identity-loader";

export type SidebarActiveTab = "search" | "library" | "notifications" | "activity" | "settings" | "storage" | "chat" | "none";

function SidebarHeader({
  activeStorageId,
  skeleton,
}: {
  activeStorageId?: string | undefined;
  skeleton: boolean;
}) {
  return (
    <>
      <div className="brand">
        <span className="brand-mark">
          <Aperture size={18} aria-hidden />
        </span>
        <span className="brand-copy">
          <strong>巡影 · Mediary Scout</strong>
          <span>多网盘媒体 agent</span>
        </span>
      </div>

      {!skeleton ? (
        <Suspense fallback={null}>
          <WorkspaceSwitcherLoader />
        </Suspense>
      ) : null}

      {!skeleton ? (
        <Suspense fallback={null}>
          <div className="sidebar-top-identity">
            <AccountIdentityLoader storageId={activeStorageId} />
          </div>
        </Suspense>
      ) : null}
    </>
  );
}

function SidebarNav({
  active,
  searchQuery,
  basePath,
  activeStorageId,
  skeleton,
}: {
  active: SidebarActiveTab;
  searchQuery: string;
  basePath: string;
  activeStorageId?: string | undefined;
  skeleton: boolean;
}) {
  return (
    <nav aria-label="主导航">
      <ul className="nav-list">
        <li>
          <SearchNavLink active={active === "search"} knownQuery={searchQuery} basePath={basePath} />
        </li>
        <li>
          <Link
            className={`nav-item ${active === "library" ? "is-active" : ""}`}
            href={`${basePath}?tab=library`}
          >
            <Library size={16} aria-hidden />
            订阅
          </Link>
        </li>
        <li>
          <Link
            className={`nav-item ${active === "chat" ? "is-active" : ""}`}
            href={globalNavHref("/chat", activeStorageId)}
          >
            <Bot size={16} aria-hidden />
            助理
          </Link>
        </li>
        <li>
          <Link
            className={`nav-item ${active === "storage" ? "is-active" : ""}`}
            href={globalNavHref("/storage", activeStorageId)}
          >
            <HardDrive size={16} aria-hidden />
            网盘
          </Link>
        </li>
        <li>
          <Link
            className={`nav-item ${active === "notifications" ? "is-active" : ""}`}
            href={globalNavHref("/notifications", activeStorageId)}
          >
            <Bell size={16} aria-hidden />
            通知
            {!skeleton ? <NotificationsNavBadge storageId={activeStorageId} /> : null}
          </Link>
        </li>
        <li className="nav-activity-item">
          <Link
            className={`nav-item ${active === "activity" ? "is-active" : ""}`}
            href={globalNavHref("/activity", activeStorageId)}
          >
            <Activity size={16} aria-hidden />
            活动
            {!skeleton ? <ActivityNavBadge storageId={activeStorageId} /> : null}
          </Link>
        </li>
        <li className="nav-settings-item">
          <Link
            className={`nav-item ${active === "settings" ? "is-active" : ""}`}
            href={globalNavHref("/settings", activeStorageId)}
          >
            <Settings size={16} aria-hidden />
            设置
            {!skeleton ? <SettingsAttentionBadge storageId={activeStorageId} visibleWhen="mobile" /> : null}
          </Link>
        </li>
      </ul>
    </nav>
  );
}

function SidebarFooter({
  active,
  activeStorageId,
  skeleton,
}: {
  active: SidebarActiveTab;
  activeStorageId?: string | undefined;
  skeleton: boolean;
}) {
  return (
    <div className="sidebar-footer">
      {!skeleton ? (
        <Suspense fallback={null}>
          <AccountIdentityLoader storageId={activeStorageId} />
        </Suspense>
      ) : null}
      <Link
        className={`nav-item nav-secondary ${active === "activity" ? "is-active" : ""}`}
        href={globalNavHref("/activity", activeStorageId)}
      >
        <Activity size={16} aria-hidden />
        活动
        {!skeleton ? <ActivityNavBadge storageId={activeStorageId} /> : null}
      </Link>
      <Link className="health-card" href={globalNavHref("/settings", activeStorageId)} style={{ textDecoration: "none", color: "inherit" }}>
        <span className="health-icon">
          <Settings size={16} aria-hidden />
        </span>
        <span>
          <strong>设置</strong>
          <span>{resolveIsDesktop() ? "网盘 · 偏好 · 设置" : "网盘 · 偏好 · 远程访问"}</span>
        </span>
        {!skeleton ? <SettingsAttentionBadge storageId={activeStorageId} visibleWhen="desktop" /> : null}
      </Link>
    </div>
  );
}

export function AppSidebar({
  active,
  searchQuery = "",
  basePath = "/",
  activeStorageId,
  skeleton = false,
}: {
  active: SidebarActiveTab;
  searchQuery?: string;
  basePath?: string;
  activeStorageId?: string | undefined;
  skeleton?: boolean;
}) {
  return (
    <aside className="sidebar">
      <SidebarHeader activeStorageId={activeStorageId} skeleton={skeleton} />
      <SidebarNav
        active={active}
        searchQuery={searchQuery}
        basePath={basePath}
        activeStorageId={activeStorageId}
        skeleton={skeleton}
      />
      <SidebarFooter active={active} activeStorageId={activeStorageId} skeleton={skeleton} />
    </aside>
  );
}

/**
 * Pure synchronous static skeleton variant of AppSidebar for Suspense fallback shells.
 * Satisfies React 19 / PPR invariant: zero async I/O, zero connection() calls.
 */
export function AppSidebarSkeleton({
  active = "none",
}: {
  active?: SidebarActiveTab;
}) {
  return <AppSidebar active={active} skeleton />;
}

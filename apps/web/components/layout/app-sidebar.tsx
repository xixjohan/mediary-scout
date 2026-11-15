import { Suspense } from "react";
import Link from "next/link";
import { Activity, Aperture, Bell, Bot, Film, HardDrive, Library, Settings } from "lucide-react";
import { resolveIsDesktop } from "../../lib/workflow-runtime";
import { globalNavHref } from "@media-track/workflow";
import { SearchNavLink } from "../../features/catalog/components/search-memory";
import { ActivityNavBadge } from "../../features/activity/components/activity-nav-badge";
import { NotificationsNavBadge } from "./notifications-nav-badge";
import { SettingsAttentionBadge } from "../../features/settings-system/components/settings-attention-badge";
import { WorkspaceSwitcherLoader } from "../../features/auth/components/workspace-switcher-loader";
import { AccountIdentityLoader } from "../../features/auth/components/account-identity-loader";
import { NAV_ALL_VISIBLE, type NavVisibility } from "../../features/auth/core/nav-visibility";

export type SidebarActiveTab = "search" | "library" | "medialib" | "notifications" | "activity" | "settings" | "storage" | "chat" | "none";

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

      {activeStorageId && skeleton ? (
        <div className="ws-skeleton" />
      ) : !skeleton ? (
        <Suspense fallback={activeStorageId ? <div className="ws-skeleton" /> : null}>
          <WorkspaceSwitcherLoader activeStorageId={activeStorageId} />
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
  visibility,
}: {
  active: SidebarActiveTab;
  searchQuery: string;
  basePath: string;
  activeStorageId?: string | undefined;
  skeleton: boolean;
  visibility: NavVisibility;
}) {
  return (
    <nav aria-label="主导航">
      <ul className="nav-list">
        <li>
          <SearchNavLink active={active === "search"} knownQuery={searchQuery} basePath={basePath} />
        </li>
        <li>
          <Link
            prefetch={true}
            className={`nav-item ${active === "library" ? "is-active" : ""}`}
            href={`${basePath}?tab=library`}
          >
            <Library size={16} aria-hidden />
            订阅
          </Link>
        </li>
        {visibility.chat ? (
          <li>
            <Link
              prefetch={true}
              className={`nav-item ${active === "chat" ? "is-active" : ""}`}
              href={globalNavHref("/chat", activeStorageId)}
            >
              <Bot size={16} aria-hidden />
              助理
            </Link>
          </li>
        ) : null}
        {visibility.storage ? (
          <li>
            <Link
              prefetch={true}
              className={`nav-item ${active === "storage" ? "is-active" : ""}`}
              href={globalNavHref("/storage", activeStorageId)}
            >
              <HardDrive size={16} aria-hidden />
              网盘
            </Link>
          </li>
        ) : null}
        {visibility.medialib ? (
          <li>
            <Link
              prefetch={true}
              className={`nav-item ${active === "medialib" ? "is-active" : ""}`}
              href={globalNavHref("/library", activeStorageId)}
            >
              <Film size={16} aria-hidden />
              影视库
            </Link>
          </li>
        ) : null}
        <li>
          <Link
            prefetch={true}
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
            prefetch={true}
            className={`nav-item ${active === "activity" ? "is-active" : ""}`}
            href={globalNavHref("/activity", activeStorageId)}
          >
            <Activity size={16} aria-hidden />
            活动
            {!skeleton ? <ActivityNavBadge storageId={activeStorageId} /> : null}
          </Link>
        </li>
        {visibility.settings ? (
          <li className="nav-settings-item">
            <Link
              prefetch={true}
              className={`nav-item ${active === "settings" ? "is-active" : ""}`}
              href={globalNavHref("/settings", activeStorageId)}
            >
              <Settings size={16} aria-hidden />
              设置
              {!skeleton ? <SettingsAttentionBadge storageId={activeStorageId} visibleWhen="mobile" /> : null}
            </Link>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}

function SidebarFooter({
  active,
  activeStorageId,
  skeleton,
  visibility,
}: {
  active: SidebarActiveTab;
  activeStorageId?: string | undefined;
  skeleton: boolean;
  visibility: NavVisibility;
}) {
  return (
    <div className="sidebar-footer">
      {!skeleton ? (
        <Suspense fallback={<div className="account-identity-skeleton" />}>
          <AccountIdentityLoader storageId={activeStorageId} />
        </Suspense>
      ) : (
        <div className="account-identity-skeleton" />
      )}
      <Link
        prefetch={true}
        className={`nav-item nav-secondary ${active === "activity" ? "is-active" : ""}`}
        href={globalNavHref("/activity", activeStorageId)}
      >
        <Activity size={16} aria-hidden />
        活动
        {!skeleton ? <ActivityNavBadge storageId={activeStorageId} /> : null}
      </Link>
      {visibility.settings ? (
        <Link prefetch={true} className="health-card" href={globalNavHref("/settings", activeStorageId)} style={{ textDecoration: "none", color: "inherit" }}>
          <span className="health-icon">
            <Settings size={16} aria-hidden />
          </span>
          <span>
            <strong>设置</strong>
            <span>{resolveIsDesktop() ? "网盘 · 偏好 · 设置" : "网盘 · 偏好 · 远程访问"}</span>
          </span>
          {!skeleton ? <SettingsAttentionBadge storageId={activeStorageId} visibleWhen="desktop" /> : null}
        </Link>
      ) : null}
    </div>
  );
}

export function AppSidebar({
  active,
  searchQuery = "",
  basePath = "/",
  activeStorageId,
  skeleton = false,
  visibility = NAV_ALL_VISIBLE,
}: {
  active: SidebarActiveTab;
  searchQuery?: string;
  basePath?: string;
  activeStorageId?: string | undefined;
  skeleton?: boolean;
  /** 由调用方（异步 surface）按角色算好；骨架屏与单用户默认全部可见。 */
  visibility?: NavVisibility;
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
        visibility={visibility}
      />
      <SidebarFooter active={active} activeStorageId={activeStorageId} skeleton={skeleton} visibility={visibility} />
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

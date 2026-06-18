"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface WorkspaceTab {
  id: string;
  href: string;
  label: string;
  frozen: boolean;
}

/**
 * Bottom-left drive switcher (tree model). Only rendered when the account has ≥2
 * connected drives — single-drive users see nothing (current behavior). The
 * server passes the tab list (computed via switcherItems); this client component
 * only re-derives which tab is active from the current path so highlighting
 * follows navigation without a round-trip.
 */
export function WorkspaceSwitcher({ tabs }: { tabs: WorkspaceTab[] }) {
  const pathname = usePathname() ?? "/";
  if (tabs.length < 2) {
    return null;
  }
  const match = /^\/w\/([^/]+)/.exec(pathname);
  const activeId = match ? match[1] : tabs[0]?.id; // root / non-workspace → primary

  return (
    <nav className="workspace-switcher" aria-label="网盘工作区切换">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          className={`ws-tab${tab.id === activeId ? " is-active" : ""}${tab.frozen ? " is-frozen" : ""}`}
          title={tab.frozen ? `${tab.label}（网盘掉线，去设置重新绑定）` : tab.label}
        >
          <span className="ws-dot" aria-hidden />
          <span className="ws-label">{tab.label}</span>
          {tab.frozen ? <span className="ws-frozen" aria-label="掉线">⚠</span> : null}
        </Link>
      ))}
    </nav>
  );
}

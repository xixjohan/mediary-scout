"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export interface WorkspaceTab {
  id: string;
  href: string;
  label: string;
  frozen: boolean;
}

/**
 * Sidebar-top drive switcher (tree model, ≥2 drives only — single-drive accounts
 * see nothing). The active drive resolves from the pathname (/w/<id>) or a global
 * page's `?w` param, falling back to primary (tabs[0]). Uses a native <details>
 * dropdown — SSR-friendly, no extra JS. The server passes the tab list (computed
 * via switcherItems); the client only picks the active tab so highlighting follows
 * navigation without a round-trip.
 */
export function WorkspaceSwitcher({ tabs }: { tabs: WorkspaceTab[] }) {
  const pathname = usePathname() ?? "/";
  const search = useSearchParams();
  if (tabs.length < 2) {
    return null;
  }
  const pathMatch = /^\/w\/([^/]+)/.exec(pathname);
  const activeId = pathMatch ? pathMatch[1] : (search.get("w") ?? tabs[0]?.id);
  const current = tabs.find((tab) => tab.id === activeId) ?? tabs[0]!;

  return (
    <details className="workspace-switcher">
      <summary className="ws-current" aria-label="切换网盘工作区">
        <span className={`ws-dot${current.frozen ? " is-frozen" : ""}`} aria-hidden />
        <span className="ws-label">{current.label}</span>
        {current.frozen ? (
          <span className="ws-frozen" aria-label="掉线">
            ⚠
          </span>
        ) : null}
        <span className="ws-caret" aria-hidden>
          ⌄
        </span>
      </summary>
      <nav className="ws-menu" aria-label="网盘工作区">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            href={tab.href}
            className={`ws-tab${tab.id === current.id ? " is-active" : ""}${tab.frozen ? " is-frozen" : ""}`}
            title={tab.frozen ? `${tab.label}（网盘掉线，去设置重新绑定）` : tab.label}
          >
            <span className="ws-dot" aria-hidden />
            <span className="ws-label">{tab.label}</span>
            {tab.frozen ? (
              <span className="ws-frozen" aria-label="掉线">
                ⚠
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
    </details>
  );
}

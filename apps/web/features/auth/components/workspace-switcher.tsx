"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { lastQueryKey, switcherTabHref, workspaceSection } from "@media-track/workflow/scope";
import { WORKSPACE_COOKIE_NAME } from "@media-track/workflow";

export interface WorkspaceTab {
  id: string;
  href: string;
  label: string;
  frozen: boolean;
  provider?: string | undefined;
}

/** Brand logo for a drive (left of the label). Falls back to the legacy colored
 *  dot when the drive has no provider or its /brands/<provider>.svg is missing —
 *  so an unconfigured brand never breaks the row. */
function BrandMark({ provider, frozen }: { provider?: string | undefined; frozen: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!provider || failed) {
    return <span className={`ws-dot${frozen ? " is-frozen" : ""}`} aria-hidden />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="ws-icon"
      src={`/brands/${provider}.svg`}
      alt=""
      aria-hidden
      onError={() => setFailed(true)}
    />
  );
}

function getClientWorkspaceCookie(): string | null {
  if (typeof document === "undefined") return null;
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${WORKSPACE_COOKIE_NAME}=([^;]*)`));
    return match && match[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export function resolveActiveSwitcherId(
  tabs: WorkspaceTab[],
  pathname: string,
  searchW: string | null,
  initialActiveId?: string | undefined,
): string {
  const primaryId = tabs[0]!.id;
  const pathMatch = /^\/w\/([^/]+)/.exec(pathname);
  if (pathMatch && tabs.some((tab) => tab.id === pathMatch[1])) return pathMatch[1]!;
  if (searchW && tabs.some((tab) => tab.id === searchW)) return searchW;
  if (initialActiveId && tabs.some((tab) => tab.id === initialActiveId)) return initialActiveId;
  const cookieWorkspace = getClientWorkspaceCookie();
  if (cookieWorkspace && tabs.some((tab) => tab.id === cookieWorkspace)) return cookieWorkspace;
  return primaryId;
}

/**
 * 侧栏顶部网盘切换器(树模型,≥2 盘才显示)。
 * 活跃盘决议链：
 * PathMatch (/w/<id>) -> QueryParam (?w=) -> initialActiveId (服务端解析注入) -> ClientCookie -> primary(tabs[0])。
 * 切盘**保持当前 section**(搜索/订阅/通知/活动/设置),由 switcherTabHref 算去处;搜索页额外注入目标盘的记忆 query。
 * 用原生 <details> 下拉,SSR 友好。
 */
export function WorkspaceSwitcher({
  tabs,
  initialActiveId,
}: {
  tabs: WorkspaceTab[];
  initialActiveId?: string | undefined;
}) {
  const pathname = usePathname() ?? "/";
  const search = useSearchParams();
  const router = useRouter();
  if (tabs.length < 2) {
    return null;
  }
  const primaryId = tabs[0]!.id;
  const activeId = resolveActiveSwitcherId(tabs, pathname, search.get("w"), initialActiveId);
  const current = tabs.find((tab) => tab.id === activeId) ?? tabs[0]!;
  const section = workspaceSection(pathname, search.get("tab"));

  const targetBasePath = (driveId: string): string => (driveId === primaryId ? "/" : `/w/${driveId}`);

  return (
    <details className="workspace-switcher">
      <summary className="ws-current" aria-label="切换网盘工作区">
        <BrandMark provider={current.provider} frozen={current.frozen} />
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
        {tabs.map((tab) => {
          const href = switcherTabHref(section, tab.id, primaryId);
          return (
            <Link
              key={tab.id}
              href={href}
              className={`ws-tab${tab.id === current.id ? " is-active" : ""}${tab.frozen ? " is-frozen" : ""}`}
              title={tab.frozen ? `${tab.label}（网盘掉线，去设置重新绑定）` : tab.label}
              onClick={(event) => {
                try {
                  document.cookie = `${WORKSPACE_COOKIE_NAME}=${encodeURIComponent(tab.id)}; path=/; max-age=2592000; SameSite=Lax`;
                } catch {
                  // ignore
                }
                // Search keeps the section AND restores the TARGET drive's last query
                // (per-drive memory). Done on click (not in href) to avoid reading
                // sessionStorage during render → SSR hydration mismatch.
                if (section !== "search") {
                  return;
                }
                let remembered = "";
                try {
                  remembered = sessionStorage.getItem(lastQueryKey(targetBasePath(tab.id))) ?? "";
                } catch {
                  remembered = "";
                }
                if (remembered) {
                  event.preventDefault();
                  router.push(`${targetBasePath(tab.id)}?tab=search&q=${encodeURIComponent(remembered)}`);
                }
              }}
            >
              <BrandMark provider={tab.provider} frozen={tab.frozen} />
              <span className="ws-label">{tab.label}</span>
              {tab.frozen ? (
                <span className="ws-frozen" aria-label="掉线">
                  ⚠
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </details>
  );
}

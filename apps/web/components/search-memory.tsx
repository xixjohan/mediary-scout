"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { lastQueryKey } from "@media-track/workflow/scope";

/** Persists the current search query (per drive) so navigation can restore it. */
export function RememberQuery({ query, basePath = "/" }: { query: string; basePath?: string }) {
  useEffect(() => {
    try {
      sessionStorage.setItem(lastQueryKey(basePath), query);
    } catch {
      // storage unavailable — nothing to remember
    }
  }, [query, basePath]);
  return null;
}

/**
 * 搜索 nav entry that restores the last query (per drive): leaving for 媒体库/通知
 * and coming back must not reset the result list.
 */
export function SearchNavLink({
  active,
  knownQuery = "",
  basePath = "/",
}: {
  active: boolean;
  knownQuery?: string;
  /** Tree model: the active workspace path ("/w/<id>" or "/") so search stays in it. */
  basePath?: string;
}) {
  const router = useRouter();
  return (
    <Link
      className={`nav-item ${active ? "is-active" : ""}`}
      href={`${basePath}?tab=search&q=${encodeURIComponent(knownQuery)}`}
      onClick={(event) => {
        if (knownQuery) {
          return; // server-known query already in href
        }
        let remembered = "";
        try {
          remembered = sessionStorage.getItem(lastQueryKey(basePath)) ?? "";
        } catch {
          remembered = "";
        }
        if (remembered) {
          event.preventDefault();
          router.push(`${basePath}?tab=search&q=${encodeURIComponent(remembered)}`);
        }
      }}
    >
      <Search size={16} aria-hidden />
      搜索
    </Link>
  );
}

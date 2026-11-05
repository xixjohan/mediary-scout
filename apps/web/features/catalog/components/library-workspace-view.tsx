"use client";

import { useState, useCallback, useEffect, type JSX } from "react";
import type { InProgressTitle, LibraryWallEntry } from "../../../lib/title-hub";
import { SubscriptionTodo } from "../../acquisition/components/subscription-todo";
import { LibraryQuickFind } from "./library-quick-find";

export interface LibraryWorkspaceViewProps {
  wallEntries: LibraryWallEntry[];
  inProgressTitles: InProgressTitle[];
  storageId?: string | undefined;
  category: "movie" | "tv" | "anime" | null;
  initialFilter?: "all" | "complete" | "tracking" | "partial" | undefined;
  initialStatus?: "active" | "completed" | "all" | undefined;
}

/**
 * 订阅媒体库统一工作区客户端视图容器 (LibraryWorkspaceView)。
 *
 * 核心架构职责：
 * 1. 统一管理 status（"active" | "completed" | "all"）与 filter（"all" | "complete" | ...）的受控状态；
 * 2. 状态切换在客户端 0ms 完成内存过滤与组件重绘，阻断任何昂贵的服务端 RSC 重渲染；
 * 3. 使用 window.history.replaceState 保持浏览器地址栏 URL 同步，确保刷新与分享链接准确；
 * 4. 联动控制 SubscriptionTodo（在 status === "completed" 时秒级隐藏，非 completed 时即时展开）。
 */
export function LibraryWorkspaceView({
  wallEntries,
  inProgressTitles,
  storageId,
  category,
  initialFilter = "all",
  initialStatus = "active",
}: LibraryWorkspaceViewProps): JSX.Element {
  const [status, setStatus] = useState<"active" | "completed" | "all">(initialStatus);
  const [filter, setFilter] = useState<"all" | "complete" | "tracking" | "partial">(initialFilter);

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    setFilter(initialFilter);
  }, [initialFilter]);

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const st = params.get("status") as "active" | "completed" | "all" | null;
      if (st === "active" || st === "completed" || st === "all") {
        setStatus(st);
      }
      const ft = params.get("filter") as "all" | "complete" | "tracking" | "partial" | null;
      if (ft === "all" || ft === "complete" || ft === "tracking" || ft === "partial") {
        setFilter(ft);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const handleStatusChange = useCallback((newStatus: "active" | "completed" | "all") => {
    setStatus(newStatus);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("status", newStatus);
      window.history.replaceState(null, "", url.toString());
    }
  }, []);

  const handleFilterChange = useCallback((newFilter: "all" | "complete" | "tracking" | "partial") => {
    setFilter(newFilter);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("filter", newFilter);
      window.history.replaceState(null, "", url.toString());
    }
  }, []);

  return (
    <>
      {status !== "completed" && !category ? (
        <SubscriptionTodo wallEntries={wallEntries} storageId={storageId} initialCategory={category} />
      ) : null}
      <LibraryQuickFind
        wallEntries={wallEntries}
        inProgressTitles={inProgressTitles}
        storageId={storageId}
        mode={category ? "category" : "home"}
        mediaType={category ?? undefined}
        filter={filter}
        status={status}
        onStatusChange={handleStatusChange}
        onFilterChange={handleFilterChange}
      />
    </>
  );
}

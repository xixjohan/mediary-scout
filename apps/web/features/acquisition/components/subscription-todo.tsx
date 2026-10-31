"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, Film, Layers, Tv } from "lucide-react";
import { showHref } from "@media-track/workflow";
import type { LibraryWallEntry } from "../../../lib/title-hub";

export type MissingUrgencyLevel = "critical" | "moderate" | "low";
export type MissingCategoryFilter = "all" | "tv" | "anime" | "movie";

export interface MissingTodoItemViewModel {
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterUrl: string | null;
  missingAiredCount: number;
  obtainedEpisodes: number;
  totalAiredEpisodes: number;
  totalEpisodes: number;
  progressPercent: number;
  urgencyLevel: MissingUrgencyLevel;
  typeLabel: string;
  detailHref: string;
}

/**
 * 将原始海报路径格式化为可用的海报 URL。
 */
export function formatPosterUrl(posterPath: string | null | undefined): string | null {
  if (!posterPath) return null;
  if (posterPath.startsWith("http://") || posterPath.startsWith("https://")) {
    return posterPath;
  }
  const cleanPath = posterPath.startsWith("/") ? posterPath : `/${posterPath}`;
  return `https://image.tmdb.org/t/p/w185${cleanPath}`;
}

/**
 * 适配器模式 (Adapter Pattern)：
 * 将 LibraryWallEntry 转换为富视觉卡片所需的 MissingTodoItemViewModel。
 */
export function adaptToMissingTodoItem(
  entry: LibraryWallEntry,
  storageId?: string | undefined
): MissingTodoItemViewModel {
  const targetEpisodes = entry.totalAiredEpisodes > 0 ? entry.totalAiredEpisodes : entry.totalEpisodes;
  const progressPercent =
    targetEpisodes > 0 ? Math.min(100, Math.round((entry.obtainedEpisodes / targetEpisodes) * 100)) : 0;

  let urgencyLevel: MissingUrgencyLevel = "low";
  if (entry.obtainedEpisodes === 0 || entry.missingAiredCount >= 10) {
    urgencyLevel = "critical";
  } else if (entry.missingAiredCount >= 3) {
    urgencyLevel = "moderate";
  }

  const typeLabel = entry.type === "anime" ? "动漫" : entry.type === "movie" ? "电影" : "电视剧";

  return {
    tmdbId: entry.tmdbId,
    title: entry.title,
    year: entry.year,
    type: entry.type,
    posterUrl: formatPosterUrl(entry.posterPath),
    missingAiredCount: entry.missingAiredCount,
    obtainedEpisodes: entry.obtainedEpisodes,
    totalAiredEpisodes: entry.totalAiredEpisodes,
    totalEpisodes: entry.totalEpisodes,
    progressPercent,
    urgencyLevel,
    typeLabel,
    detailHref: showHref(entry.tmdbId, "library", storageId, entry.type),
  };
}

/**
 * 筛选并排序缺失作品。
 * 排序：按缺失集数降序，同数按标题排序（稳定）。
 */
export function missingAiredTitles(
  wallEntries: LibraryWallEntry[],
  category?: MissingCategoryFilter | null
): LibraryWallEntry[] {
  return wallEntries
    .filter((entry) => {
      if (entry.missingAiredCount <= 0) return false;
      if (category && category !== "all" && entry.type !== category) return false;
      return true;
    })
    .sort((a, b) => b.missingAiredCount - a.missingAiredCount || a.title.localeCompare(b.title, "zh-Hans-CN"));
}

/** 默认折叠展示的焦点卡片上限 */
export const COMPACT_PREVIEW_LIMIT = 4;

export interface SubscriptionTodoProps {
  wallEntries: LibraryWallEntry[];
  storageId?: string | undefined;
  initialCategory?: "movie" | "tv" | "anime" | null | undefined;
}

function MissingTodoCard({ item }: { item: MissingTodoItemViewModel }) {
  const episodeTotal = item.totalAiredEpisodes > 0 ? item.totalAiredEpisodes : item.totalEpisodes;
  return (
    <Link
      href={item.detailHref}
      className={`subscription-todo-card urgency-${item.urgencyLevel}`}
      title={`${item.title} (${item.year}) - 缺 ${item.missingAiredCount} 集`}
    >
      <div className="subscription-todo-poster-wrap">
        {item.posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.posterUrl}
            alt={item.title}
            className="subscription-todo-poster"
            loading="lazy"
          />
        ) : (
          <div className="subscription-todo-poster-placeholder" aria-hidden>
            {item.type === "movie" ? <Film size={18} /> : <Tv size={18} />}
          </div>
        )}
      </div>

      <div className="subscription-todo-info">
        <div className="subscription-todo-card-top">
          <span className="subscription-todo-card-title">{item.title}</span>
          <span className={`subscription-todo-count-badge urgency-${item.urgencyLevel}`}>
            缺 {item.missingAiredCount} 集
          </span>
        </div>

        <div className="subscription-todo-meta">
          <span className="subscription-todo-type-tag">{item.typeLabel}</span>
          <span className="subscription-todo-year">{item.year}</span>
          <span className="subscription-todo-ratio">
            已获 {item.obtainedEpisodes}/{episodeTotal} 集
          </span>
        </div>

        <div className="subscription-todo-progress-box">
          <div className="subscription-todo-progress-track">
            <div
              className={`subscription-todo-progress-fill urgency-${item.urgencyLevel}`}
              style={{ width: `${item.progressPercent}%` }}
            />
          </div>
          <span className="subscription-todo-progress-text">{item.progressPercent}%</span>
        </div>
      </div>
    </Link>
  );
}

interface CategoryTabsProps {
  activeTab: MissingCategoryFilter;
  counts: { all: number; tv: number; anime: number; movie: number };
  onSelect: (tab: MissingCategoryFilter) => void;
}

function CategoryTabs({ activeTab, counts, onSelect }: CategoryTabsProps) {
  const tabs: Array<{ id: MissingCategoryFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: counts.all },
    { id: "tv", label: "电视剧", count: counts.tv },
    { id: "anime", label: "动漫", count: counts.anime },
    { id: "movie", label: "电影", count: counts.movie },
  ];

  return (
    <div className="subscription-todo-tabs" role="tablist" aria-label="待办分类筛选">
      {tabs
        .filter((t) => t.id === "all" || t.count > 0)
        .map((tab) => {
          const isSelected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              className={`subscription-todo-tab-btn ${isSelected ? "is-active" : ""}`}
              onClick={() => onSelect(tab.id)}
            >
              <span>{tab.label}</span>
              <span className="subscription-todo-tab-count">({tab.count})</span>
            </button>
          );
        })}
    </div>
  );
}

export function SubscriptionTodo({
  wallEntries,
  storageId,
  initialCategory = null,
}: SubscriptionTodoProps) {
  const [selectedCategory, setSelectedCategory] = useState<MissingCategoryFilter>(
    initialCategory ?? "all"
  );
  const [expanded, setExpanded] = useState(false);

  // 全量有缺失的作品列表
  const allMissing = useMemo(() => missingAiredTitles(wallEntries, "all"), [wallEntries]);

  // 分类统计
  const categoryCounts = useMemo(() => {
    return {
      all: allMissing.length,
      tv: allMissing.filter((e) => e.type === "tv").length,
      anime: allMissing.filter((e) => e.type === "anime").length,
      movie: allMissing.filter((e) => e.type === "movie").length,
    };
  }, [allMissing]);

  // 当前激活分类过滤后的缺失作品
  const activeCategory = initialCategory ?? selectedCategory;
  const filteredTodo = useMemo(
    () => missingAiredTitles(wallEntries, activeCategory),
    [wallEntries, activeCategory]
  );

  if (filteredTodo.length === 0) {
    return null;
  }

  const totalMissing = filteredTodo.reduce((sum, entry) => sum + entry.missingAiredCount, 0);
  const viewModels = filteredTodo.map((entry) => adaptToMissingTodoItem(entry, storageId));

  // 策略模式：数量超出阈值时折叠显示 Top N
  const hasMore = viewModels.length > COMPACT_PREVIEW_LIMIT;
  const visibleItems = expanded || !hasMore ? viewModels : viewModels.slice(0, COMPACT_PREVIEW_LIMIT);
  const remainingCount = viewModels.length - COMPACT_PREVIEW_LIMIT;
  const remainingMissing = viewModels
    .slice(COMPACT_PREVIEW_LIMIT)
    .reduce((sum, item) => sum + item.missingAiredCount, 0);

  const categoryContextLabel =
    activeCategory === "anime"
      ? "部动漫"
      : activeCategory === "movie"
      ? "部电影"
      : activeCategory === "tv"
      ? "部电视剧"
      : "部";

  return (
    <section className="subscription-todo" aria-label="订阅缺失待办看板">
      <header className="subscription-todo-head">
        <div className="subscription-todo-title-group">
          <div className="subscription-todo-heading-row">
            <Layers className="subscription-todo-icon" size={18} aria-hidden />
            <h2>还缺 {totalMissing} 集</h2>
            <span className="subscription-todo-badge">
              共 {filteredTodo.length} {categoryContextLabel}待办
            </span>
          </div>
          <span className="quiet">按缺失集数排序 · 优先解决未补齐剧集</span>
        </div>

        {initialCategory === null && categoryCounts.all > 0 ? (
          <CategoryTabs
            activeTab={selectedCategory}
            counts={categoryCounts}
            onSelect={setSelectedCategory}
          />
        ) : null}
      </header>

      <div className={`subscription-todo-deck ${expanded ? "is-expanded" : "is-collapsed"}`}>
        {visibleItems.map((item) => (
          <MissingTodoCard key={item.tmdbId} item={item} />
        ))}
      </div>

      {hasMore ? (
        <footer className="subscription-todo-foot">
          <button
            type="button"
            className="subscription-todo-expand-btn"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            {expanded ? (
              <>
                <span>收起待办</span>
                <ChevronUp size={15} aria-hidden />
              </>
            ) : (
              <>
                <span>展开剩余 {remainingCount} 部待办 (共 {remainingMissing} 集)</span>
                <ChevronDown size={15} aria-hidden />
              </>
            )}
          </button>
        </footer>
      ) : null}
    </section>
  );
}

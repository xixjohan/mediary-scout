import Link from "next/link";
import { Filter, SlidersHorizontal, Sparkles } from "lucide-react";
import {
  MEDIA_TYPES,
  GENRE_TAGS,
  YEAR_TAGS,
  SORT_OPTIONS,
  buildFilterHref,
} from "../lib/media-filters";

export {
  MEDIA_TYPES,
  GENRE_TAGS,
  YEAR_TAGS,
  SORT_OPTIONS,
  TMDB_GENRE_MAP,
  GENRE_KEYWORDS,
  type MediaFilterValues,
  type FilterableMediaItem,
  isAnimeItem,
  isDocumentaryItem,
  isVarietyItem,
  matchesItemType,
  matchesItemGenre,
  matchesItemYear,
  sortItems,
  applyCandidateFilters,
  buildFilterHref,
} from "../lib/media-filters";

/**
 * 影视多类型多标签复合筛选栏（MediaFilterBar）。
 *
 * 业界流媒体标准筛选矩阵：
 *  1. 类型维度：全部 / 电影 / 剧集 / 动漫 / 纪录片 / 综艺
 *  2. 题材维度：全部题材 / 科幻 / 悬疑 / 动作 / 喜剧 / 爱情 / 犯罪 / 动画 / 奇幻 / 冒险 / 惊悚
 *  3. 年代维度：全部年份 / 2026 / 2025 / 2024 / 2023 / 2020年代 / 2010年代
 *  4. 排序维度：热门流行 / 高分优先 / 最新上映
 *
 * 纯 URL 参数驱动（SSR 亲和、可收藏书签、回退保留状态）。
 */
export function MediaFilterBar({
  basePath,
  query,
  activeType = "all",
  activeGenre = "all",
  activeYear = "all",
  activeSort = "popularity",
  activeTrending,
}: {
  basePath: string;
  query: string;
  activeType?: string;
  activeGenre?: string;
  activeYear?: string;
  activeSort?: string;
  activeTrending?: string;
}) {
  const currentParams = {
    q: query,
    type: activeType,
    genre: activeGenre,
    year: activeYear,
    sort: activeSort,
    trending: activeTrending,
  };

  return (
    <nav className="media-filter-bar" aria-label="分类筛选矩阵">
      {/* 维度 1：媒体类型 */}
      <div className="media-filter-row">
        <span className="media-filter-label">
          <Filter size={13} aria-hidden /> 类型
        </span>
        <div className="media-filter-pills">
          {MEDIA_TYPES.map((t) => (
            <Link
              key={t.id}
              className={`filter-pill ${activeType === t.id ? "is-active" : ""}`}
              href={buildFilterHref(basePath, currentParams, { type: t.id })}
              scroll={false}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </div>

      {/* 维度 2：题材标签 */}
      <div className="media-filter-row">
        <span className="media-filter-label">
          <Sparkles size={13} aria-hidden /> 题材
        </span>
        <div className="media-filter-pills">
          {GENRE_TAGS.map((g) => (
            <Link
              key={g.id}
              className={`filter-pill ${activeGenre === g.id ? "is-active" : ""}`}
              href={buildFilterHref(basePath, currentParams, { genre: g.id })}
              scroll={false}
            >
              {g.label}
            </Link>
          ))}
        </div>
      </div>

      {/* 维度 3 & 4：年份与排序复合行 */}
      <div className="media-filter-row media-filter-split-row">
        <div className="media-filter-subgroup">
          <span className="media-filter-label">年代</span>
          <div className="media-filter-pills">
            {YEAR_TAGS.map((y) => (
              <Link
                key={y.id}
                className={`filter-pill ${activeYear === y.id ? "is-active" : ""}`}
                href={buildFilterHref(basePath, currentParams, { year: y.id })}
                scroll={false}
              >
                {y.label}
              </Link>
            ))}
          </div>
        </div>

        <div className="media-filter-subgroup media-filter-sort-group">
          <span className="media-filter-label">
            <SlidersHorizontal size={13} aria-hidden /> 排序
          </span>
          <div className="media-filter-pills">
            {SORT_OPTIONS.map((s) => (
              <Link
                key={s.id}
                className={`filter-pill ${activeSort === s.id ? "is-active" : ""}`}
                href={buildFilterHref(basePath, currentParams, { sort: s.id })}
                scroll={false}
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </nav>
  );
}

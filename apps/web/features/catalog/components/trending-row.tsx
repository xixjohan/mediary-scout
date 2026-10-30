import Link from "next/link";
import { Film, RefreshCw, Search } from "lucide-react";
import { getDiscoverFeed, type TrendingKind } from "../../../lib/trending";
import { getDoubanRatings } from "../../../lib/douban-rating";
import { PaginationBar } from "../../../components/pagination-bar";

const POSTER = "https://image.tmdb.org/t/p/w342";

function cardMediaTypeLabel(genreIds?: number[], mediaType?: string, title?: string): string {
  if (genreIds?.includes(16) || (title && /[\u3040-\u309F\u30A0-\u30FF]/.test(title))) {
    return "动漫";
  }
  if (genreIds?.includes(99)) {
    return "纪录片";
  }
  return mediaType === "movie" ? "电影" : "剧集";
}

function isFilterSpecified(p?: { type?: string; genre?: string; year?: string; page?: number }): boolean {
  if (!p) return false;
  if (p.type && p.type !== "all") return true;
  if (p.genre && p.genre !== "all") return true;
  if (p.year && p.year !== "all") return true;
  return Boolean(p.page && p.page > 1);
}

function TrendingRatingBadge({
  douban,
  voteAverage,
}: {
  douban?: { score: number } | undefined;
  voteAverage?: number | undefined;
}) {
  if (douban) {
    return (
      <span className="douban-badge" title={`豆瓣评分 ${douban.score}`}>
        <span className="douban-dot">🟢</span> {douban.score.toFixed(1)}
      </span>
    );
  }
  if (voteAverage) {
    return (
      <span className="douban-badge" title={`TMDB评分 ${voteAverage.toFixed(1)}`}>
        <span className="douban-dot">⭐</span> {voteAverage.toFixed(1)}
      </span>
    );
  }
  return null;
}

function TrendingCardItem({
  card,
  index,
  basePath,
  douban,
}: {
  card: Awaited<ReturnType<typeof getDiscoverFeed>>[number];
  index: number;
  basePath: string;
  douban?: { score: number } | undefined;
}) {
  const typeLabel = cardMediaTypeLabel(card.genreIds, card.mediaType, card.title);
  return (
    <Link
      key={`${card.mediaType}_${card.tmdbId}`}
      className="trending-card"
      href={`${basePath}?q=${encodeURIComponent(card.title)}`}
    >
      <div className="trending-poster">
        {card.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`${POSTER}${card.posterPath}`} alt="" loading="lazy" />
        ) : (
          <Film size={24} aria-hidden />
        )}
        <span className="trending-rank">#{index + 1}</span>
      </div>
      <span className="trending-title">{card.title}</span>
      <span className="trending-meta">
        {card.year ?? "—"} · {typeLabel}
        <TrendingRatingBadge douban={douban} voteAverage={card.voteAverage} />
      </span>
    </Link>
  );
}

function buildFilterQueryParams(
  filterParams?: { type?: string; genre?: string; year?: string; sort?: string; pageSize?: number } | undefined,
) {
  if (!filterParams) return {};
  const query: Record<string, string | undefined> = {};
  if (filterParams.type && filterParams.type !== "all") query.type = filterParams.type;
  if (filterParams.genre && filterParams.genre !== "all") query.genre = filterParams.genre;
  if (filterParams.year && filterParams.year !== "all") query.year = filterParams.year;
  if (filterParams.sort && filterParams.sort !== "popularity") query.sort = filterParams.sort;
  if (filterParams.pageSize && filterParams.pageSize !== 30) query.pageSize = String(filterParams.pageSize);
  return query;
}

function TrendingRowPagination({
  filterParams,
  count,
  basePath,
}: {
  filterParams?: { type?: string; genre?: string; year?: string; sort?: string; page?: number; pageSize?: number } | undefined;
  count: number;
  basePath: string;
}) {
  const page = filterParams?.page ?? 1;
  const pageSize = filterParams?.pageSize ?? 30;
  if (count === 0 && page <= 1) {
    return null;
  }
  const totalPages = count >= pageSize ? Math.min(50, page + 1) : page;

  return (
    <PaginationBar
      currentPage={page}
      totalPages={totalPages}
      pageSize={pageSize}
      basePath={basePath}
      queryParams={buildFilterQueryParams(filterParams)}
    />
  );
}

/** The search page's empty-state discovery feed. When getDiscoverFeed yields []
 *  (proxy/network down or strict filter with no matches) it falls back to an
 *  informative placeholder so search is never blocked. Poster clicks navigate
 *  to `?q=<title>` so the pick lands in the normal results flow. */
export async function TrendingRow({
  activeKind,
  basePath,
  filterParams,
}: {
  activeKind: TrendingKind;
  basePath: string;
  filterParams?: { type?: string; genre?: string; year?: string; sort?: string; page?: number; pageSize?: number } | undefined;
}) {
  const pageSize = filterParams?.pageSize ?? 30;
  const cards = await getDiscoverFeed({ ...filterParams, pageSize, trending: activeKind });
  if (cards.length === 0) {
    const hasFilter = isFilterSpecified(filterParams);
    return (
      <div className="quiet-state">
        <Search size={24} aria-hidden />
        <strong>{hasFilter ? "未找到符合筛选条件的作品" : "输入目标名称"}</strong>
        <span>
          {hasFilter
            ? "可以尝试放宽题材或年份限制，或直接在上方搜索框输入关键词。"
            : "搜索后才会请求元数据。"}
        </span>
        {filterParams?.page && filterParams.page > 1 ? (
          <Link className="primary-button" href={basePath} style={{ marginTop: "0.75rem" }}>
            返回第 1 页
          </Link>
        ) : null}
      </div>
    );
  }

  const doubanMap = await getDoubanRatings(
    cards.slice(0, pageSize).map((c) => ({ title: c.title, year: c.year })),
  );

  return (
    <section className="trending" aria-label="发现精选">
      <div className="trending-head">
        <div className="trending-tabs">
          <h2>发现 · 精选推荐</h2>
          <span className="panel-note" style={{ alignSelf: "center", margin: 0 }}>
            {cards.length} 部
          </span>
        </div>
        <span className="trending-note">
          <RefreshCw size={12} aria-hidden /> 每日更新 · 权威双评分
        </span>
      </div>
      <div className="trending-grid">
        {cards.map((card, index) => (
          <TrendingCardItem
            key={`${card.mediaType}_${card.tmdbId}`}
            card={card}
            index={index}
            basePath={basePath}
            douban={doubanMap.get(`${card.title}_${card.year ?? ""}`)}
          />
        ))}
      </div>
      <TrendingRowPagination filterParams={filterParams} count={cards.length} basePath={basePath} />
    </section>
  );
}

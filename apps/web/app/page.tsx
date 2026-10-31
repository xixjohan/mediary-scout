import Link from "next/link";

import { PageLoginGuard } from "../lib/page-auth-guard";
import { Suspense } from "react";
import { Library, TriangleAlert } from "lucide-react";
import { AcquiringPoller } from "../features/acquisition/components/acquiring-poller";
import { AppSidebar } from "../components/layout/app-sidebar";
import { CandidateCard } from "../features/acquisition/components/candidate-card";
import { DemoSessionLibrary } from "../components/demo/demo-session-library";
import { LibraryQuickFind } from "../features/catalog/components/library-quick-find";
import { SubscriptionTodo } from "../features/acquisition/components/subscription-todo";
import { RememberQuery } from "../features/catalog/components/search-memory";
import { SearchForm } from "../features/catalog/components/search-form";
import { TrendingRow } from "../features/catalog/components/trending-row";
import { PaginationBar } from "../components/ui/pagination-bar";
import { MediaFilterBar, applyCandidateFilters } from "../features/catalog/components/media-filter-bar";
import { getDoubanRatings, type DoubanRating } from "../lib/douban-rating";
import { GitHubNameplate } from "../components/layout/github-nameplate";
import type { TrendingKind } from "../lib/trending";
import { getSearchView } from "../lib/search-page";
import { getInProgressTitles, getLibraryWall } from "../lib/title-hub";
import {
  ensureDemoSeeded,
  getActiveWorkspaceScope,
  getRegisteredDriveCount,
  getWorkflowRepository,
} from "../lib/workflow-runtime";
import { showHref } from "@media-track/workflow";
import type { SearchCandidateCard, TrackedSeasonState } from "@media-track/workflow";

/** Workspace base path: "/" is the account's primary drive, "/w/<id>" a
 *  specific drive. Library links must route within the current workspace —
 *  hardcoding "/" silently jumps to the primary drive from any other drive. */
function workspaceBasePath(storageId?: string): string {
  return storageId ? `/w/${storageId}` : "/";
}

export default function Page({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <>
      <Suspense fallback={null}>
        <PageLoginGuard />
      </Suspense>
      <HomeView searchParams={searchParams} />
    </>
  );
}

/**
 * Shared home surface for both the root route (storageId undefined → the
 * account's primary drive) and the /w/<storageId> workspace route (a specific
 * drive). The library + search awareness are scoped to that workspace.
 */
export function HomeView({
  searchParams,
  storageId,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>> | undefined;
  storageId?: string | undefined;
}) {
  // searchParams is a dynamic input. Reading it inside a Suspense boundary lets
  // the static app shell prerender instead of the whole route blocking on it —
  // this is what silences the cacheComponents "blocking-route" warning. The await
  // resolves from the request URL (no I/O), so the fallback is effectively instant.
  return (
    <Suspense fallback={<HomeShell />}>
      <HomeSurface searchParams={searchParams} storageId={storageId} />
    </Suspense>
  );
}

function HomeShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="search" />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

function parseMediaType(typeParam?: string, trendingParam?: string): string {
  if (typeParam) return typeParam;
  if (trendingParam) return trendingParam;
  return "all";
}

function parsePageNumber(pageParam?: string): number {
  const parsed = parseInt(pageParam || "1", 10);
  return Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
}

function parsePageSizeParam(sizeParam?: string): number {
  const parsed = parseInt(sizeParam || "30", 10);
  return [20, 30, 50].includes(parsed) ? parsed : 30;
}

function parseStatus(statusParam?: string): "active" | "completed" | "all" {
  if (statusParam === "completed" || statusParam === "all") return statusParam;
  return "active";
}

function resolveActiveTrending(mediaType: string): TrendingKind {
  if (mediaType === "tv") return "tv";
  if (mediaType === "anime") return "anime";
  return "movie";
}

function parseHomeSearchParams(params: Record<string, string | string[] | undefined>) {
  const query = stringParam(params.q);
  const activeTab: "library" | "search" =
    stringParam(params.tab) === "library" ? "library" : "search";
  const mediaType = parseMediaType(stringParam(params.type), stringParam(params.trending));
  const country = stringParam(params.country) || "all";
  const genre = stringParam(params.genre) || "all";
  const year = stringParam(params.year) || "all";
  const sort = stringParam(params.sort) || "popularity";
  const filter = stringParam(params.filter) || "all";
  const page = parsePageNumber(stringParam(params.page));
  const pageSize = parsePageSizeParam(stringParam(params.pageSize));
  const status = parseStatus(stringParam(params.status));
  const activeTrending = resolveActiveTrending(mediaType);

  return { query, activeTab, mediaType, country, genre, year, sort, filter, page, pageSize, status, activeTrending };
}

async function HomeSurface({
  searchParams,
  storageId,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
  storageId?: string | undefined;
}) {
  const params = (await searchParams) ?? {};
  const {
    query,
    activeTab,
    mediaType,
    country,
    genre,
    year,
    sort,
    filter,
    page,
    pageSize,
    status,
    activeTrending,
  } = parseHomeSearchParams(params);

  // Tree model: keep searches inside the ACTIVE workspace so an acquisition lands
  // on the drive you're viewing — not silently on the primary drive. Root route
  // (no storageId) posts to "/" as before.
  const basePath = workspaceBasePath(storageId);
  const driveCount = await getRegisteredDriveCount().catch(() => 0);


  return (
    <div className="app-shell">
      <AppSidebar active={activeTab} searchQuery={query} basePath={basePath} activeStorageId={storageId} />

      <main className="main product-main">
        {activeTab === "search" ? (
          <section className="search-surface">
            <RememberQuery query={query} basePath={basePath} />
            <div className="search-hero">
              <div>
                <h1>搜索</h1>
                <p>找到目标后发起获取，后台会处理资源判断、转存和验证。</p>
              </div>
              <SearchForm basePath={basePath} defaultQuery={query} />
            </div>
            {driveCount >= 2 ? (
              <p className="panel-note" style={{ marginTop: -4, marginBottom: 4 }}>
                搜索与获取按网盘隔离 —— 想为某块盘获取资源，请切到该盘后在它的搜索页操作。
              </p>
            ) : null}
            <MediaFilterBar
              basePath={basePath}
              query={query}
              activeType={mediaType}
              activeCountry={country}
              activeGenre={genre}
              activeYear={year}
              activeSort={sort}
              activeTrending={activeTrending}
            />
            <Suspense key={`search-${query}-${mediaType}-${country}-${genre}-${year}-${sort}-${page}-${pageSize}`} fallback={<SearchResultsSkeleton />}>
              <SearchResults
                query={query}
                storageId={storageId}
                activeTrending={activeTrending}
                basePath={basePath}
                filterParams={{ type: mediaType, country, genre, year, sort, page, pageSize }}
              />
            </Suspense>
          </section>
        ) : (
          <>
            <DemoSessionLibrary />
            <Suspense fallback={<LibrarySurfaceSkeleton />}>
              <LibrarySurface mediaType={mediaType} filter={filter} status={status} storageId={storageId} />
            </Suspense>
          </>
        )}
        <GitHubNameplate />
      </main>
    </div>
  );
}

function buildTrackedByTmdbId(states: TrackedSeasonState[]): Map<number, TrackedSeasonState[]> {
  const map = new Map<number, TrackedSeasonState[]>();
  for (const state of states) {
    if (state.title.type === "movie") continue;
    const list = map.get(state.title.tmdbId) ?? [];
    list.push(state);
    map.set(state.title.tmdbId, list);
  }
  return map;
}

function SearchProviderErrorView({
  searchView,
  basePath,
}: {
  searchView: Awaited<ReturnType<typeof getSearchView>>;
  basePath: string;
}) {
  return (
    <section className="search-results" aria-label="搜索结果">
      <div className="quiet-state compact" role="alert">
        <TriangleAlert size={22} aria-hidden />
        <strong>搜索暂时不可用：连不上元数据服务（TMDB）</strong>
        <span>
          当前部署环境连不上 TMDB，内置代理也不通。国内网络未配置代理时常见——
          给部署主机（或容器）配置可访问外网的代理后重试。
        </span>
        <a className="primary-button" href={`${basePath}?q=${encodeURIComponent(searchView.query)}`}>
          重试
        </a>
        {searchView.providerError ? <span className="panel-note">{searchView.providerError}</span> : null}
      </div>
    </section>
  );
}

function SearchEmptyQuietState({ query }: { query: string }) {
  return (
    <div className="quiet-state compact">
      <TriangleAlert size={22} aria-hidden />
      <strong>没有匹配结果</strong>
      <span>{query}</span>
      <span className="panel-note">
        可以试试剧情描述（如「男主带着小绿瓶修仙的国漫」），或去掉「第几季／篇章名」只搜作品名。
      </span>
    </div>
  );
}

function SearchResultsHeading({
  count,
  searchView,
}: {
  count: number;
  searchView: Awaited<ReturnType<typeof getSearchView>>;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>结果</h2>
        <p>
          {count} 个候选
          {searchView.cacheStatus === "hit" ? "，来自缓存" : ""}
          {searchView.source === "douban" ? " · 豆瓣兜底源" : ""}
        </p>
        {searchView.interpretedQuery ? (
          <p className="panel-note">
            「{searchView.query}」像是描述而不是片名 —— 已按「{searchView.interpretedQuery}」搜索。
          </p>
        ) : null}
      </div>
    </div>
  );
}

function setQueryParamIf(
  params: Record<string, string | undefined>,
  key: string,
  value?: string,
  defaultVal = "all",
) {
  if (value && value !== defaultVal) {
    params[key] = value;
  }
}

function buildSearchPaginationQuery(
  query: string,
  filterParams?: { type?: string; country?: string; genre?: string; year?: string; sort?: string; pageSize?: number } | undefined,
) {
  const params: Record<string, string | undefined> = { q: query };
  if (!filterParams) return params;
  setQueryParamIf(params, "type", filterParams.type);
  setQueryParamIf(params, "country", filterParams.country);
  setQueryParamIf(params, "genre", filterParams.genre);
  setQueryParamIf(params, "year", filterParams.year);
  setQueryParamIf(params, "sort", filterParams.sort, "popularity");
  if (filterParams.pageSize && filterParams.pageSize !== 30) {
    params.pageSize = String(filterParams.pageSize);
  }
  return params;
}

function CandidateGridList({
  candidates,
  inProgressIds,
  trackedByTmdbId,
  storageId,
  searchQuery,
  doubanMap,
}: {
  candidates: SearchCandidateCard[];
  inProgressIds: Set<number>;
  trackedByTmdbId: Map<number, TrackedSeasonState[]>;
  storageId?: string | undefined;
  searchQuery: string;
  doubanMap: Map<string, DoubanRating>;
}) {
  return (
    <div className="candidate-grid">
      {candidates.map((candidate) => {
        const trackedStates = trackedByTmdbId.get(candidate.tmdbId) ?? [];
        const trackedLabel =
          candidate.mediaType === "tv"
            ? trackedSummaryLabel(trackedStates, candidate.seasonNumbers.length)
            : null;

        return (
          <CandidateCard
            candidate={candidate}
            acquiring={inProgressIds.has(candidate.tmdbId)}
            trackedLabel={trackedLabel}
            trackedSeasonNumbers={trackedStates.map((s) => s.season.seasonNumber)}
            storageId={storageId}
            searchQuery={searchQuery}
            doubanRating={doubanMap.get(`${candidate.title}_${candidate.year ?? ""}`)}
            key={`${candidate.mediaType}_${candidate.tmdbId}`}
          />
        );
      })}
    </div>
  );
}

async function SearchResults({
  query,
  storageId,
  activeTrending,
  basePath,
  filterParams,
}: {
  query: string;
  storageId?: string | undefined;
  activeTrending: TrendingKind;
  basePath: string;
  filterParams?: { type?: string; country?: string; genre?: string; year?: string; sort?: string; page?: number; pageSize?: number } | undefined;
}) {
  const pageSize = filterParams?.pageSize ?? 30;
  const searchView = await getSearchView(query, storageId, filterParams?.page, pageSize);
  if (searchView.state === "empty") {
    return <TrendingRow activeKind={activeTrending} basePath={basePath} filterParams={filterParams} />;
  }
  if (searchView.state === "provider_error") {
    return <SearchProviderErrorView searchView={searchView} basePath={basePath} />;
  }

  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const scope = await getActiveWorkspaceScope(storageId);
  const trackedByTmdbId = buildTrackedByTmdbId(await repository.listTrackedSeasonStates(scope));

  const inProgress = await getInProgressTitles(storageId);
  const inProgressIds = new Set(inProgress.map((title) => title.tmdbId));

  const doubanMap = await getDoubanRatings(
    searchView.candidates.slice(0, pageSize).map((c) => ({ title: c.title, year: c.year })),
  );
  const filteredCandidates = applyCandidateFilters(searchView.candidates, filterParams, doubanMap);
  const page = searchView.page ?? filterParams?.page ?? 1;

  return (
    <>
      {inProgress.length > 0 ? <AcquiringPoller /> : null}
      <section className="search-results" aria-label="搜索结果">
        {searchView.source === "douban" ? (
          <div className="douban-fallback-notice" role="status">
            <span>💡 TMDB 暂未收录该关键词，已为您自动触发「豆瓣搜索兜底」展示相关条目。</span>
          </div>
        ) : null}
        <SearchResultsHeading count={filteredCandidates.length} searchView={searchView} />
        {filteredCandidates.length > 0 ? (
          <>
            <CandidateGridList
              candidates={filteredCandidates}
              inProgressIds={inProgressIds}
              trackedByTmdbId={trackedByTmdbId}
              storageId={storageId}
              searchQuery={searchView.query}
              doubanMap={doubanMap}
            />
            <PaginationBar
              currentPage={page}
              totalPages={searchView.totalPages ?? 1}
              totalResults={searchView.totalResults}
              pageSize={pageSize}
              basePath={basePath}
              queryParams={buildSearchPaginationQuery(searchView.query, filterParams)}
            />
          </>
        ) : (
          <SearchEmptyQuietState query={searchView.query} />
        )}
      </section>
    </>
  );
}

/**
 * Concrete library awareness for a result card: not just "tracked", but
 * WHICH seasons are obtained / airing / missing.
 */
function trackedSummaryLabel(states: TrackedSeasonState[], totalSeasonCount: number): string | null {
  if (states.length === 0) {
    return null;
  }
  const seasonNumber = (state: TrackedSeasonState) => state.season.seasonNumber;
  const obtainedCount = (state: TrackedSeasonState) =>
    state.episodes.filter((episode) => episode.obtained).length;
  const complete = states
    .filter(
      (state) =>
        state.season.status === "completed" && obtainedCount(state) >= state.season.totalEpisodes,
    )
    .map(seasonNumber)
    .sort((a, b) => a - b);
  const active = states
    .filter((state) => state.season.status === "active")
    .map(seasonNumber)
    .sort((a, b) => a - b);
  if (totalSeasonCount > 0 && complete.length === totalSeasonCount) {
    return `全 ${totalSeasonCount} 季已获取`;
  }
  const parts: string[] = [];
  if (complete.length > 0) {
    parts.push(`第 ${complete.join("、")} 季已获取`);
  }
  if (active.length > 0) {
    parts.push(`第 ${active.join("、")} 季追更中`);
  }
  const rest = states.length - complete.length - active.length;
  if (rest > 0) {
    parts.push(`${rest} 季有缺集`);
  }
  return parts.join(" · ") || "已追踪";
}



async function LibrarySurface({
  mediaType,
  filter,
  status = "active",
  storageId,
}: {
  mediaType: string;
  filter: string;
  status?: "active" | "completed" | "all";
  storageId?: string | undefined;
}) {
  const [rawWall, inProgress] = await Promise.all([getLibraryWall(storageId), getInProgressTitles(storageId)]);
  const inProgressIds = new Set(inProgress.map((title) => title.tmdbId));
  // A title still being fetched shows as a 获取中 placeholder, not (yet) a card.
  const wall = rawWall.filter((entry) => !inProgressIds.has(entry.tmdbId));

  if (wall.length === 0 && inProgress.length === 0) {
    return (
      <section className="library-surface">
        <div className="quiet-state">
          <Library size={24} aria-hidden />
          <strong>订阅还是空的</strong>
          <span>去搜索页发起第一次订阅吧。</span>
        </div>
      </section>
    );
  }

  // The type param is always one of the three (every link generates it that way);
  // anything else falls back to the rows overview.
  const category = mediaType === "movie" || mediaType === "tv" || mediaType === "anime" ? mediaType : null;
  return (
    <section className="library-surface">
      {inProgress.length > 0 ? <AcquiringPoller /> : null}
      {/* 缺失待办区：正名为「订阅」后，用户要的第一答案是「还缺什么」。
          数据来自 LibraryWallEntry.missingAiredCount（与 /api/agent/library、
          详情页季行同一口径，见 lib/subscription-missing），这里不重算。
          category 视图及「已完成」视图下不显示——那一屏已被收窄，再叠一块全局
          待办会让人以为数字对应当前筛选。 */}
      {category === null && status !== "completed" ? <SubscriptionTodo wallEntries={wall} storageId={storageId} /> : null}
      <LibraryQuickFind
        wallEntries={wall}
        inProgressTitles={inProgress}
        storageId={storageId}
        mode={category ? "category" : "home"}
        mediaType={category ?? undefined}
        filter={filter === "complete" || filter === "tracking" || filter === "partial" ? filter : "all"}
        status={status}
      />
    </section>
  );
}

function SearchResultsSkeleton() {
  return (
    <div className="candidate-grid" style={{ marginTop: 24 }}>
      <div className="skeleton-card" />
      <div className="skeleton-card" />
    </div>
  );
}

function LibrarySurfaceSkeleton() {
  return (
    <section className="library-surface">
      <div className="skeleton skeleton-heading" />
      <div className="poster-wall">
        <div className="skeleton skeleton-poster" />
        <div className="skeleton skeleton-poster" />
        <div className="skeleton skeleton-poster" />
        <div className="skeleton skeleton-poster" />
      </div>
    </section>
  );
}

function stringParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

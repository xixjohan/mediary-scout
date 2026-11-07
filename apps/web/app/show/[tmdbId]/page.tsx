import { buildMovieCandidateId } from "@media-track/workflow";
import { Suspense } from "react";
import { PageLoginGuard } from "../../../lib/page-auth-guard";
import { ClientLoginRedirect } from "../../../features/auth/components/client-login-redirect";
import Link from "next/link";
import { connection } from "next/server";
import { cache, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { isMovieUnreleased, type EpisodeDisplayState } from "@media-track/workflow";
import { AcquiringPoller } from "../../../features/acquisition/components/acquiring-poller";
import { AcquisitionLockProvider } from "../../../features/acquisition/components/acquisition-lock";
import { AppSidebar } from "../../../components/layout/app-sidebar";
import { GitHubNameplate } from "../../../components/layout/github-nameplate";
import { BackLink } from "../../../components/layout/back-link";
import { TitleResourcePanel } from "../../../features/acquisition/components/title-resource-panel";
import { OrganizePanel } from "../../../features/acquisition/components/title-organize-panel";
import { SubscriptionPolicyPanel } from "../../../features/acquisition/components/subscription-policy-panel";
import { MovieSynopsis } from "../../../features/catalog/components/movie-synopsis";
import { RequestTrackButton } from "../../../features/acquisition/components/request-track-button";
import { SwapBadgeLive, SwapKeepProvider } from "../../../features/acquisition/components/swap-keep";
import { EpisodeTargetProvider } from "../../../features/acquisition/components/episode-target-context";
import { MissingEpisodesDeck } from "../../../features/acquisition/components/missing-episodes-deck";
import { SeasonRow } from "../../../features/acquisition/components/season-row";
import { ManualSubscriptionSearchButton, RequestRemainingButton, SubscriptionConfigButton } from "../../../features/catalog/components/title-action-buttons";
import { UntrackButton } from "../../../features/acquisition/components/untrack-button";
import { AcquiringStatusTrigger } from "../../../features/acquisition/components/acquiring-status-trigger";
import { AgentMemoryNotes } from "../../../features/activity/components/agent-memory-panel";
import { UserMessageThread } from "../../../features/acquisition/components/user-message-thread";
import { isDemoMode } from "../../../lib/demo-mode";
import type { DemoAcquisitionEntry } from "../../../lib/demo-session";
import { getDetailView, type MovieHubView, type TitleHubSeason, type TitleHubView } from "../../../lib/title-hub";
import { nextPatrolLabel, readTitleMessages } from "../../../lib/user-message-server";
import { showsMessageCard } from "../../../lib/user-message-state";
import {
  beijingDateTime, getActiveWorkspaceScope, getCurrentAccountId, getDailySweepTimes,
  getWorkflowRepository, resolveGlobalWorkspace, isSharedResourceMode, getCurrentAccountSummary,
  UNAUTHENTICATED_ACCOUNT_ID,
} from "../../../lib/workflow-runtime";

const aggregateBadge = { untracked: null, tracking: { label: "追更中", tone: "indigo" }, partial: { label: "部分入库", tone: "amber" }, complete: { label: "已全部入库", tone: "green" } } as const;

function ShowPageInner({
  params,
  searchParams,
}: {
  params: Promise<{ tmdbId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Everything here is dynamic (searchParams + params + DB), so the whole shell
  // streams inside one Suspense — cacheComponents forbids reading uncached data
  // outside a boundary. The fallback mirrors the shell (sidebar + hub skeleton).
  return (
    <div className="app-shell">
      <Suspense
        fallback={
          <ShowShell active="none" skeleton>
            <HubSkeleton backLabel="返回" backHref="/?tab=search" />
          </ShowShell>
        }
      >
        <ShowContent params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function ShowShell({ active, basePath = "/", activeStorageId, skeleton = false, children }: { active: "search" | "library" | "none"; basePath?: string; activeStorageId?: string | undefined; skeleton?: boolean; children: ReactNode }) {
  return (
    <>
      <AppSidebar active={active} basePath={basePath} activeStorageId={activeStorageId} skeleton={skeleton} />
      <main className="main product-main product-main-hub">{children}</main>
    </>
  );
}

async function ShowContent({
  params,
  searchParams,
}: {
  params: Promise<{ tmdbId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  await connection();
  const accountId = await getCurrentAccountId();
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) {
    return (
      <ShowShell active="none" skeleton>
        <ClientLoginRedirect />
        <HubSkeleton backLabel="返回" backHref="/login" />
      </ShowShell>
    );
  }
  // 搜索是搜索，订阅是订阅: the title page belongs to whichever surface the
  // user came FROM. Entry links carry ?from=search|library; back keeps the
  // previous list state (history.back preserves the search query).
  const params0 = (await searchParams) ?? {};
  const fromParam = params0["from"];
  const from = fromParam === "library" ? "library" : fromParam === "search" ? "search" : null;
  // The title page is a global route (/show/<id>); it must resolve against the
  // drive the user came FROM (?w), NOT the primary drive — otherwise a non-primary
  // title isn't found in the (wrong) scope and falls back to a TMDB lookup of the
  // same numeric id in the OTHER namespace (movie 278 ≠ tv 278 = unrelated show).
  const wParam = params0["w"];
  const w = Array.isArray(wParam) ? wParam[0] : wParam;
  const workspace = await resolveGlobalWorkspace(w);
  const qParam = params0["q"];
  const searchQuery = Array.isArray(qParam) ? qParam[0] : qParam;
  // `t` (the card's media type) disambiguates TMDB's movie/tv id namespaces for an
  // untracked title — without it a movie id can resolve to an unrelated tv show.
  const tParam = params0["t"];
  const tRaw = Array.isArray(tParam) ? tParam[0] : tParam;
  const typeHint = tRaw === "movie" || tRaw === "tv" || tRaw === "anime" ? tRaw : undefined;
  const { tmdbId: tmdbIdParam } = await params;
  const tmdbId = Number(tmdbIdParam);
  const view = Number.isInteger(tmdbId)
    ? await getDetailView(tmdbId, workspace.connectedStorageId ?? undefined, typeHint)
    : null;

  const backLabel = from === "search" ? "搜索" : from === "library" ? "订阅" : "返回";
  const backHref =
    from === "library" ? `${workspace.basePath}?tab=library` : `${workspace.basePath}?tab=search`;

  const summary = await getCurrentAccountSummary();
  const canManageMedia = !isSharedResourceMode() || (summary?.isOwner ?? false);

  return (
    <ShowShell
      active={from ?? "none"}
      basePath={workspace.basePath}
      activeStorageId={workspace.activeStorageId}
    >
      {view ? (
        view.kind === "movie" ? (
          <MovieHub
            view={view}
            storageId={workspace.activeStorageId}
            basePath={workspace.basePath}
            backLabel={backLabel}
            backHref={backHref}
            searchQuery={searchQuery}
            canManageMedia={canManageMedia}
          />
        ) : (
          <TvHub
            view={view}
            storageId={workspace.activeStorageId}
            basePath={workspace.basePath}
            backLabel={backLabel}
            backHref={backHref}
            searchQuery={searchQuery}
            canManageMedia={canManageMedia}
          />
        )
      ) : (
        <div className="quiet-state">
          <BackLink label={backLabel} fallbackHref={backHref} />
          <TriangleAlert size={24} aria-hidden />
          <strong>没有找到这部影片</strong>
          <span>回到搜索页重新查找。</span>
        </div>
      )}
      <GitHubNameplate />
    </ShowShell>
  );
}

function TvHub({
  view,
  storageId,
  basePath,
  backLabel,
  backHref,
  searchQuery,
  canManageMedia = true,
}: {
  view: TitleHubView;
  storageId: string | undefined;
  basePath: string;
  backLabel: string;
  backHref: string;
  searchQuery?: string | undefined;
  canManageMedia?: boolean;
}) {
  const badge = aggregateBadge[view.aggregate];
  // The message card's episode picker: every episode of a tracked season in the library.
  const libraryEpisodes = view.seasons
    .filter((season) => season.tracked)
    .flatMap((season) => season.episodes.filter((episode) => episode.obtained).map((episode) => episode.episodeCode));
  return (
    <AcquisitionLockProvider>
    <SwapKeepProvider key={`tv:${view.tmdbId}:${storageId ?? ""}`}>
    <EpisodeTargetProvider>
    {view.acquiring ? <AcquiringPoller /> : null}
    <section className="title-hub title-hub-immersive">
      {/* Backdrop clipped to hub-hero only — seasons stay on plain page bg. */}
      <div className="hub-hero">
        {view.backdropPath ? (
          <div
            className="hub-backdrop"
            style={{ backgroundImage: `url(https://image.tmdb.org/t/p/w1280${view.backdropPath})` }}
            aria-hidden
          />
        ) : null}
        <BackLink label={backLabel} fallbackHref={backHref} />
      <header className="hub-header">
        <div className="hub-poster">
          {view.posterPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://image.tmdb.org/t/p/w342${view.posterPath}`}
              alt={`${view.title} 海报`}
            />
          ) : (
            <span className="poster-fallback">{view.title.slice(0, 4)}</span>
          )}
        </div>
        <div className="hub-title-block">
          {/* 缺集 and 在更 are orthogonal: a partial title whose latest season is
              still releasing shows 追更中 alongside 部分入库 (斗破苍穹) — side by
              side in a row, not stacked. */}
          {badge ? (
            <div className="hub-badges">
              <span className={`hub-badge tone-${badge.tone}`}>{badge.label}</span>
              {view.airing && view.aggregate === "partial" ? (
                <span className="hub-badge tone-indigo">追更中</span>
              ) : null}
              <SwapBadge tmdbId={view.tmdbId} mediaType="tv" storageId={storageId} />
            </div>
          ) : null}
          <h1>
            {view.title} <span className="hub-year">({view.year})</span>
          </h1>
          <p className="hub-attributes">
            {view.seasons.length} 季
            {view.originalTitle && view.originalTitle !== view.title
              ? ` · ${view.originalTitle}`
              : ""}
          </p>
          <div className="hub-actions">
            {view.acquiring ? (
              <AcquiringStatusTrigger
                title={{ tmdbId: view.tmdbId, title: view.title, year: view.year, type: "tv", posterPath: view.posterPath }}
                storageId={storageId}
              />
            ) : null}
            {/* Single-season titles get their button on the season row. */}
            {view.untrackedSeasonNumbers.length > 0 && view.seasons.length > 1 ? (
              <RequestRemainingButton
                tmdbId={view.tmdbId}
                storageId={storageId}
                titleAcquiring={view.acquiring}
                label={
                  view.aggregate === "untracked"
                    ? "获取所有季"
                    : `获取剩余 ${view.untrackedSeasonNumbers.length} 季`
                }
                demoEntry={{
                  tmdbId: view.tmdbId,
                  title: view.title,
                  year: view.year,
                  type: "tv",
                  posterPath: view.posterPath,
                }}
              />
            ) : null}
            {view.untrackedSeasonNumbers.length > 0 ? (
              <SubscriptionConfigButton
                tmdbId={view.tmdbId}
                title={view.title}
                year={view.year}
                posterPath={view.posterPath}
                storageId={storageId}
                initialTracked={view.aggregate !== "untracked"}
                titleAcquiring={view.acquiring}
                seasons={view.seasons
                  .filter((season) => !season.tracked)
                  .map((season) => ({ seasonNumber: season.seasonNumber, totalEpisodes: season.totalEpisodes }))}
              />
            ) : null}
            {canManageMedia && view.aggregate !== "untracked" ? (
              <UntrackButton tmdbId={view.tmdbId} storageId={storageId} mediaKind="tv" basePath={basePath} />
            ) : null}
          </div>
        </div>
      </header>
      </div>

      <div className="hub-body">
        {view.overview ? <MovieSynopsis overview={view.overview} /> : null}
      </div>

      <section className="hub-seasons" aria-label="季列表">
        <MissingEpisodesDeck seasons={view.seasons} title={view.title} />
        <ul className="hub-season-list">
          <SeasonRowsWithSwap view={view} storageId={storageId} basePath={basePath} canManageMedia={canManageMedia} />
        </ul>
      </section>

      <TitleResourcePanel
        tmdbId={view.tmdbId}
        mediaType="tv"
        seasonNumbers={view.seasons.map((s) => s.seasonNumber)}
        defaultKeyword={searchQuery?.trim() || view.title}
        title={view.title}
        year={view.year}
        storageId={storageId}
      />

      <OrganizePanel tmdbId={view.tmdbId} seasonNumber={view.seasons[0]?.seasonNumber} />

      {canManageMedia ? <SubscriptionPolicyPanel tmdbId={view.tmdbId} mediaType="tv" seasonNumbers={view.seasons.map((season) => season.seasonNumber)} /> : null}
      {view.aggregate !== "untracked" ? (
        <TitleMessageSection
          tmdbId={view.tmdbId}
          mediaType="tv"
          storageId={storageId}
          hasFile={libraryEpisodes.length > 0}
          episodes={libraryEpisodes}
        />
      ) : null}
      {view.aggregate !== "untracked" ? <TitleMemorySection mediaType="tv" tmdbId={view.tmdbId} /> : null}
    </section>
    </EpisodeTargetProvider>
    </SwapKeepProvider>
    </AcquisitionLockProvider>
  );
}

const movieStateMeta = {
  acquired: { label: "已入库", tone: "green" },
  reserved: { label: "预定 · 未上映", tone: "blue" },
  acquiring: { label: "获取中", tone: "indigo" },
  missing: { label: "未获取", tone: "amber" },
  untracked: { label: "未追踪", tone: "muted" },
} as const;

/** A movie's detail page: immersive hero + full synopsis body (no season grid). */
function MovieHub({
  view,
  storageId,
  basePath,
  backLabel,
  backHref,
  searchQuery,
  canManageMedia = true,
}: {
  view: MovieHubView;
  storageId: string | undefined;
  basePath: string;
  backLabel: string;
  backHref: string;
  searchQuery?: string | undefined;
  canManageMedia?: boolean;
}) {
  const meta = movieStateMeta[view.state];
  const activityHref = storageId ? `/activity?w=${encodeURIComponent(storageId)}` : "/activity";
  const nowIso = new Date().toISOString();
  const unreleased =
    view.state === "untracked" && isMovieUnreleased(view.releaseDate, nowIso);
  const movieCandidateId = buildMovieCandidateId({ source: "tmdb", id: view.tmdbId });
  const chips: Array<{ label: string; value: string }> = [];
  if (view.releaseDate) chips.push({ label: "上映", value: formatMovieDate(view.releaseDate) });
  if (view.originalTitle && view.originalTitle !== view.title) {
    chips.push({ label: "原名", value: view.originalTitle });
  }
  chips.push({ label: "类型", value: "电影" });

  return (
    <AcquisitionLockProvider>
    <SwapKeepProvider key={`movie:${view.tmdbId}:${storageId ?? ""}`}>
    <EpisodeTargetProvider>
      {view.acquiring ? <AcquiringPoller /> : null}
      <section className="title-hub title-hub-immersive">
        {/* Backdrop lives inside hub-hero only — must NOT cover synopsis body. */}
        <div className="hub-hero">
          {view.backdropPath ? (
            <div
              className="hub-backdrop"
              style={{ backgroundImage: `url(https://image.tmdb.org/t/p/w1280${view.backdropPath})` }}
              aria-hidden
            />
          ) : null}
          <BackLink label={backLabel} fallbackHref={backHref} />
          <header className="hub-header">
            <div className="hub-poster">
              {view.posterPath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`https://image.tmdb.org/t/p/w342${view.posterPath}`} alt={`${view.title} 海报`} />
              ) : (
                <span className="poster-fallback">{view.title.slice(0, 4)}</span>
              )}
            </div>
            <div className="hub-title-block">
              <div className="hub-badges">
                <span className={`hub-badge tone-${meta.tone}`}>{meta.label}</span>
                {view.state !== "untracked" ? (
                  <SwapBadge tmdbId={view.tmdbId} mediaType="movie" storageId={storageId} />
                ) : null}
              </div>
              <h1>
                {view.title} <span className="hub-year">({view.year})</span>
              </h1>
              <p className="hub-attributes">电影</p>
              <div className="hub-actions">
                {view.state === "untracked" ? (
                  <RequestTrackButton
                    candidateId={movieCandidateId}
                    tmdbId={view.tmdbId}
                    title={view.title}
                    year={view.year}
                    posterPath={view.posterPath}
                    actionState={unreleased ? "can_reserve" : "can_request"}
                    label={unreleased ? "预定" : "获取"}
                    storageId={storageId}
                  />
                ) : null}
                {view.state === "acquiring" ? (
                  <>
                    <AcquiringStatusTrigger
                      title={{ tmdbId: view.tmdbId, title: view.title, year: view.year, type: "movie", posterPath: view.posterPath }}
                      storageId={storageId}
                    />
                    <Link className="primary-button" href={activityHref}>
                      查看活动
                    </Link>
                  </>
                ) : null}
                {canManageMedia && view.state === "missing" ? (
                  <ManualSubscriptionSearchButton
                    tmdbId={view.tmdbId}
                    mediaType="movie"
                    storageId={storageId}
                    activityHref={activityHref}
                  />
                ) : null}
                {canManageMedia && view.state !== "untracked" ? (
                  <UntrackButton tmdbId={view.tmdbId} storageId={storageId} mediaKind="movie" basePath={basePath} />
                ) : null}
              </div>
              {view.state === "missing" ? (
                <p className="hub-missing-note">已上映但仍缺资源，日常巡检会继续尝试。</p>
              ) : null}
            </div>
          </header>
        </div>
        <div className="hub-body">
          {view.overview ? <MovieSynopsis overview={view.overview} /> : null}
          {chips.length > 0 ? (
            <div className="movie-meta-chips">
              {chips.map((chip) => (
                <span key={`${chip.label}-${chip.value}`} className="movie-meta-chip">
                  {chip.label} <strong>{chip.value}</strong>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <TitleResourcePanel
          tmdbId={view.tmdbId}
          mediaType="movie"
          defaultKeyword={searchQuery?.trim() || view.title}
          title={view.title}
          year={view.year}
          storageId={storageId}
          releaseDate={view.releaseDate}
        />
        {view.state !== "untracked" ? (
          <OrganizePanel tmdbId={view.tmdbId} seasonNumber={undefined} />
        ) : null}
        {canManageMedia ? <SubscriptionPolicyPanel tmdbId={view.tmdbId} mediaType="movie" /> : null}
        {view.state !== "untracked" ? (
          <TitleMessageSection tmdbId={view.tmdbId} mediaType="movie" storageId={storageId} hasFile={view.obtained} episodes={[]} />
        ) : null}
        {view.state !== "untracked" ? <TitleMemorySection mediaType="movie" tmdbId={view.tmdbId} /> : null}
      </section>
    </EpisodeTargetProvider>
    </SwapKeepProvider>
    </AcquisitionLockProvider>
  );
}

function formatMovieDate(releaseDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(releaseDate);
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : releaseDate;
}

/** Shared placeholder while the hub streams. Header-only — no fake TV season
 *  rows (movies have none; TV content replaces this quickly). */
function HubSkeleton({ backLabel, backHref }: { backLabel: string; backHref: string }) {
  return (
    <section className="title-hub title-hub-immersive">
      <div className="hub-hero">
        <BackLink label={backLabel} fallbackHref={backHref} />
        <header className="hub-header">
          <div className="skeleton skeleton-hub-poster" />
          <div className="skeleton-hub-titleblock">
            <div className="skeleton skeleton-hub-badge" />
            <div className="skeleton skeleton-hub-h1" />
            <div className="skeleton skeleton-hub-line" />
            <div className="skeleton skeleton-hub-line short" />
            <div className="skeleton skeleton-hub-line short" />
          </div>
        </header>
      </div>
      <div className="hub-body movie-synopsis" aria-hidden>
        <div className="skeleton skeleton-hub-section" />
        <div className="skeleton skeleton-hub-line" />
        <div className="skeleton skeleton-hub-line" />
        <div className="skeleton skeleton-hub-line short" />
      </div>
    </section>
  );
}

/** This work's messages and 待换 episodes, read once per request (the title badge and
 *  the season grid both use them). The work is resolved the way the message actions
 *  resolve it, so the page shows what the engine acts on. Null when the title is not
 *  tracked on this drive — or when the read failed: these are decorations, logged and
 *  left out rather than failing the whole page. */
const loadTitleMessages = cache((tmdbId: number, mediaType: "movie" | "tv", storageId: string | undefined) => {
  const repo = getWorkflowRepository();
  return readTitleMessages({
    repo,
    scope: () => getActiveWorkspaceScope(storageId),
    tmdbId,
    mediaType,
    sweepTimes: () => getDailySweepTimes(repo),
  });
});

/** 「N 集待换」 (show) /「待换资源」 (film) beside the title's status badge. */
async function SwapBadge({
  tmdbId,
  mediaType,
  storageId,
}: {
  tmdbId: number;
  mediaType: "movie" | "tv";
  storageId: string | undefined;
}) {
  const messages = await loadTitleMessages(tmdbId, mediaType, storageId);
  // A client piece: 「不换了」 on the message card takes it down at once.
  return messages ? <SwapBadgeLive mediaType={mediaType} pending={messages.thread.pendingReplacements} /> : null;
}

/** The message card: under the season rows (TV) or the synopsis (film), above
 *  the agent's notes. Shown while the work has a file on this drive, or messages / 待换
 *  to show — never keyed off the film's 已入库: a film whose replace run is in flight
 *  reads 获取中, and the card must not vanish exactly then. Not on the read-only demo. */
async function TitleMessageSection({
  tmdbId,
  mediaType,
  storageId,
  hasFile,
  episodes,
}: {
  tmdbId: number;
  mediaType: "movie" | "tv";
  storageId: string | undefined;
  hasFile: boolean;
  /** The picker's cells (TV); [] for a film. */
  episodes: string[];
}) {
  if (isDemoMode()) return null;
  const messages = await loadTitleMessages(tmdbId, mediaType, storageId);
  if (!messages) return null;
  const { thread, run, sweepTimes } = messages;
  if (!showsMessageCard({ tracked: true, hasFile, messageCount: thread.messages.length, pendingCount: thread.pendingReplacements.length })) {
    return null;
  }
  return (
    <div className="hub-message">
      <UserMessageThread
        work={{ tmdbId, mediaType, storageId }}
        view={thread}
        run={run}
        nextPatrol={nextPatrolLabel(sweepTimes, beijingDateTime().hhmm)}
        episodes={episodes}
        now={new Date().toISOString()}
      />
    </div>
  );
}

/** The season rows, each episode a user asked to replace drawn 「待换」 in red. */
async function SeasonRowsWithSwap({
  view,
  storageId,
  basePath,
  canManageMedia = true,
}: {
  view: TitleHubView;
  storageId: string | undefined;
  basePath: string;
  canManageMedia?: boolean;
}) {
  const messages = view.aggregate === "untracked" ? null : await loadTitleMessages(view.tmdbId, "tv", storageId);
  const swap = new Set(messages?.thread.pendingReplacements ?? []);
  return (
    <>
      {view.seasons.map((season) => (
        <SeasonRow
          key={season.seasonNumber}
          season={season}
          tmdbId={view.tmdbId}
          storageId={storageId}
          mediaType={view.mediaType}
          basePath={basePath}
          acquiring={view.acquiring}
          swap={swap}
          demoEntry={{
            tmdbId: view.tmdbId,
            title: view.title,
            year: view.year,
            type: "tv",
            posterPath: view.posterPath,
          }}
          canManageMedia={canManageMedia}
        />
      ))}
    </>
  );
}


/** This work's agent notes, collapsed to one line under the episode progress (TV) or
 *  the synopsis (movie). Absent when the agent has written nothing for this work. */
async function TitleMemorySection({ mediaType, tmdbId }: { mediaType: "movie" | "tv"; tmdbId: number }) {
  const { getWorkflowRepository, getCurrentAccountId } = await import("../../../lib/workflow-runtime");
  const { driveLabelerFor, listMemoriesForUi, toMemoryItem } = await import("../../../lib/agent-memory-server");
  const accountId = await getCurrentAccountId();
  const items = await listMemoriesForUi(getWorkflowRepository(), accountId, { scope: "title", mediaType, tmdbId });
  if (items.length === 0) return null;
  const driveLabel = await driveLabelerFor(getWorkflowRepository(), accountId);
  return (
    <div className="hub-memory">
      <AgentMemoryNotes
        address={{ scope: "title", mediaType, tmdbId }}
        items={items.map((m) => toMemoryItem(m, driveLabel))}
        summaryLabel={mediaType === "tv" ? "agent 补缺集时记了 {n} 条笔记" : "agent 获取时记了 {n} 条笔记"}
        now={new Date().toISOString()}
      />
    </div>
  );
}

/**
 * S5.7 页面登录守卫（见 lib/page-auth-guard.ts）。
 *
 * 为什么每页都要包一层：cacheComponents（PPR）下，请求期读取必须发生在
 * <Suspense> 边界内，否则构建期预渲染直接失败；而 layout 顶层读又被同一规则
 * 挡下（S5.7 两条路都实测过）。页面级是唯一同时满足「构建能过」与「redirect
 * 能生效」的位置——redirect 在 streaming 下插 meta 标签让客户端跳转，且 React
 * 会在该边界抛出时中止渲染，原页面的数据不会进入 HTML（已实测确认）。
 */
export default function ShowPage(props: Parameters<typeof ShowPageInner>[0]) {
  return (
    <>
      <Suspense fallback={null}>
        <PageLoginGuard />
      </Suspense>
      <ShowPageInner {...props} />
    </>
  );
}

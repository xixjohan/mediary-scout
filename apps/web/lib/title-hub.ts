import { buildTitleId, buildTvCandidateId, buildMovieCandidateId } from "@media-track/workflow";
import { isLiveSearch } from "./search-provider";
import {
  createTmdbMetadataProvider,
  getTrackedSeasonStatusView,
  isMovieUnreleased,
  isUserVisibleWorkflowKind,
  prepareSeriesTarget,
  queueSeriesInitialization,
  queueTrackingInitialization,
  type EpisodeStatusCell,
  type MediaTitle,
  type PreparedSeriesTarget,
  type WorkflowKind,
  type WorkflowRunProgress,
} from "@media-track/workflow";
import { findDemoCandidateByTmdbId } from "./demo-candidates";
import {
  aggregateAiring,
  aggregateStateFromSeasons,
  libraryWallAiring,
  libraryWallState,
  type LibraryWallStateValue,
  type TitleAggregateState,
} from "./title-aggregate";
import { createTtlMemo } from "./series-target-memo";
import { getDurableJsonCache } from "./durable-cache";
import { missingAiredEpisodeCodes } from "./subscription-missing";
import type { DurableJsonCache } from "@media-track/workflow";
import {
  ensureDemoSeeded,
  getAccountScopedSettings,
  getActiveWorkspaceScope,
  getCurrentAccountId,
  getTmdbAccesses,
  getWorkflowRepository,
  movieTargetFromTmdbId,
  queueCandidateTracking,
  type CandidateTrackingRequestResult,
} from "./workflow-runtime";

export interface TitleHubSeason {
  seasonNumber: number;
  totalEpisodes: number;
  latestAiredEpisode: number;
  tracked: boolean;
  /** TrackedSeason status when tracked. */
  status: "active" | "completed" | null;
  obtainedCount: number;
  missingAiredCount: number;
  trackedSeasonId: string | null;
  episodes: EpisodeStatusCell[];
}

export type { TitleAggregateState };

export interface TitleHubView {
  kind: "tv";
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  aggregate: TitleAggregateState;
  /** Orthogonal to `aggregate`: any tracked season still airing. A partial title
   *  that is also airing shows BOTH 部分入库 and 追更中. */
  airing: boolean;
  seasons: TitleHubSeason[];
  untrackedSeasonNumbers: number[];
  /** A queued/running acquisition for this title — disables all acquire buttons. */
  acquiring: boolean;
}

/** A movie has no seasons — its detail page is a single status, not a season grid. */
export interface MovieHubView {
  kind: "movie";
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  /** acquired=已入库, reserved=未上映已预定, acquiring=获取中, missing=已上映未获取, untracked=未追踪. */
  state: "acquired" | "reserved" | "acquiring" | "missing" | "untracked";
  acquiring: boolean;
  /** The film's file is in the library. Not the same as state "acquired": while a run
   *  of the film is queued or running (a user's replace request keeps the old file)
   *  the state reads 获取中. */
  obtained: boolean;
}

export type DetailView = TitleHubView | MovieHubView;

import { loadSeriesTargetWithCache, seriesTargetFor } from "./series-target";
export { loadSeriesTargetWithCache, seriesTargetFor };

export async function getTitleHubView(tmdbId: number, storageId?: string): Promise<TitleHubView | null> {
  const repository = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope(storageId);
  await ensureDemoSeeded(repository);
  const trackedStates = (await repository.listTrackedSeasonStates(scope)).filter(
    // tv AND anime are season-shaped detail pages; only movies are excluded.
    (state) => state.title.tmdbId === tmdbId && state.title.type !== "movie",
  );
  const target = await seriesTargetFor(tmdbId);
  if (trackedStates.length === 0 && target === null) {
    return null;
  }

  const dbTitle = trackedStates[0]?.title;
  const meta = {
    title: dbTitle?.title ?? target?.title.title ?? `TMDB ${tmdbId}`,
    originalTitle: dbTitle?.originalTitle ?? target?.title.originalTitle ?? "",
    year: dbTitle?.year ?? target?.title.year ?? 0,
    overview: dbTitle?.overview ?? target?.title.overview ?? "",
    posterPath: dbTitle?.posterPath ?? target?.title.posterPath ?? null,
    backdropPath: dbTitle?.backdropPath ?? target?.title.backdropPath ?? null,
  };

  const trackedBySeason = new Map(trackedStates.map((state) => [state.season.seasonNumber, state]));
  const seasonNumbers = [
    ...new Set([
      ...(target?.seasons.map((season) => season.seasonNumber) ?? []),
      ...trackedStates.map((state) => state.season.seasonNumber),
    ]),
  ].sort((a, b) => a - b);

  const seasons: TitleHubSeason[] = [];
  for (const seasonNumber of seasonNumbers) {
    const tracked = trackedBySeason.get(seasonNumber);
    const targetSeason = target?.seasons.find((season) => season.seasonNumber === seasonNumber);
    if (tracked) {
      // Scope to THIS workspace's drive: the same season can be tracked on
      // several drives (醒来 on 123 21/22 and on 115 0/22), and an unscoped
      // lookup returned the other drive's episodes on the detail page.
      const view = await getTrackedSeasonStatusView({
        repository,
        trackedSeasonId: tracked.season.id,
        scope,
      });
      seasons.push({
        seasonNumber,
        totalEpisodes: tracked.season.totalEpisodes,
        latestAiredEpisode: tracked.season.latestAiredEpisode,
        tracked: true,
        status: tracked.season.status === "completed" ? "completed" : "active",
        obtainedCount: view?.obtainedCount ?? 0,
        missingAiredCount: view?.missingAiredCount ?? 0,
        trackedSeasonId: tracked.season.id,
        episodes: view?.episodes ?? [],
      });
    } else if (targetSeason) {
      seasons.push({
        seasonNumber,
        totalEpisodes: targetSeason.totalEpisodes,
        latestAiredEpisode: targetSeason.latestAiredEpisode,
        tracked: false,
        status: null,
        obtainedCount: 0,
        missingAiredCount: 0,
        trackedSeasonId: null,
        episodes: [],
      });
    }
  }

  const untrackedSeasonNumbers = seasons
    .filter((season) => !season.tracked)
    .map((season) => season.seasonNumber);
  const aggregate = aggregateStateFromSeasons(seasons);
  const airing = aggregateAiring(seasons);

  const acquiring = (await repository.listActiveWorkflowRuns(scope)).some(
    (snapshot) => snapshot.title.tmdbId === tmdbId && isUserVisibleWorkflowKind(snapshot.workflowRun.kind),
  );

  return {
    kind: "tv",
    tmdbId,
    ...meta,
    aggregate,
    airing,
    seasons,
    untrackedSeasonNumbers,
    acquiring,
  };
}

/**
 * The detail entry the title page calls: a movie returns a single-status
 * MovieHubView (fixing the "没有找到这部剧" dead end for films), everything else
 * the season-shaped TitleHubView. Tracked movies resolve from the DB with no
 * TMDB round-trip; an untracked title falls through to the TV hub, then to a
 * TMDB movie lookup.
 */
export async function getDetailView(
  tmdbId: number,
  storageId?: string,
  typeHint?: "movie" | "tv" | "anime",
): Promise<DetailView | null> {
  const repository = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope(storageId);
  await ensureDemoSeeded(repository);
  const now = new Date().toISOString();

  const trackedForTitle = (await repository.listTrackedSeasonStates(scope)).filter(
    (state) => state.title.tmdbId === tmdbId,
  );
  const movieState = trackedForTitle.find((state) => state.title.type === "movie");
  if (movieState) {
    const acquiring = (await repository.listActiveWorkflowRuns(scope)).some(
      (snapshot) => snapshot.title.tmdbId === tmdbId && isUserVisibleWorkflowKind(snapshot.workflowRun.kind),
    );
    const obtained = movieState.episodes.some((episode) => episode.obtained);
    const reserved = isMovieUnreleased(movieState.title.releaseDate, now);
    const state = acquiring ? "acquiring" : reserved ? "reserved" : obtained ? "acquired" : "missing";
    return movieHubViewFromTitle(movieState.title, state, acquiring, obtained);
  }

  // Untracked title: TMDB's movie/tv id namespaces collide (movie 278 ≠ tv 278).
  // The detail page can't guess which; the card carries `typeHint`. When it says
  // movie, resolve the MOVIE namespace FIRST — otherwise the season-shaped hub's
  // TMDB tv lookup spuriously matches an unrelated show with the same numeric id.
  const untrackedMovie = async (): Promise<DetailView | null> => {
    const movieTarget = await movieTargetFromTmdbId(tmdbId);
    if (!movieTarget) {
      return null;
    }
    // Untracked stays untracked even if unreleased — `reserved` means tracked + waiting.
    return movieHubViewFromTitle(movieTarget.title, "untracked", false, false);
  };

  if (typeHint === "movie") {
    const movie = await untrackedMovie();
    if (movie) {
      return movie;
    }
  }

  // Season-shaped (tv/anime) hub — same drive scope. Covers tracked tv + TMDB tv target.
  const tv = await getTitleHubView(tmdbId, storageId);
  if (tv) {
    return tv;
  }

  // Last resort: a movie known to TMDB (e.g. no typeHint).
  return untrackedMovie();
}

function movieHubViewFromTitle(
  title: MediaTitle,
  state: MovieHubView["state"],
  acquiring: boolean,
  obtained: boolean,
): MovieHubView {
  return {
    kind: "movie",
    tmdbId: title.tmdbId,
    title: title.title,
    originalTitle: title.originalTitle,
    year: title.year,
    overview: title.overview ?? "",
    posterPath: title.posterPath ?? null,
    backdropPath: title.backdropPath ?? null,
    releaseDate: title.releaseDate ?? null,
    state,
    acquiring,
    obtained,
  };
}

export async function queueSeasonTracking(
  tmdbId: number,
  seasonNumber: number,
  storageId?: string,
): Promise<CandidateTrackingRequestResult> {
  const scope = await getActiveWorkspaceScope(storageId);
  return queueCandidateTracking(
      buildTvCandidateId({ source: "tmdb", id: tmdbId, seasonNumber }),
      scope.connectedStorageId,
    );
}

/**
 * "获取剩余": series initialization scoped to the seasons that have no
 * tracking state yet. Already-tracked seasons stay owned by their own
 * lifecycle (Type 3 for active ones); the reconcile step makes any
 * resource overlap harmless.
 */
export async function queueRemainingSeasons(
  tmdbId: number,
  storageId?: string,
): Promise<CandidateTrackingRequestResult> {
  const repository = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope(storageId);
  await ensureDemoSeeded(repository);
  const target = await seriesTargetFor(tmdbId);
  if (!target) {
    return { status: "unsupported", message: "无法获取该剧的季信息。" };
  }
  const trackedSeasonNumbers = new Set(
    (await repository.listTrackedSeasonStates(scope))
      .filter((state) => state.title.tmdbId === tmdbId && state.title.type !== "movie")
      .map((state) => state.season.seasonNumber),
  );
  const remaining = target.seasons.filter(
    (season) => !trackedSeasonNumbers.has(season.seasonNumber),
  );
  if (remaining.length === 0) {
    return {
      status: "already_tracked",
      workflowRunId: null,
      trackedSeasonId: buildTvCandidateId({
          source: "tmdb",
          id: tmdbId,
          seasonNumber: target.seasons[0]?.seasonNumber ?? 1,
        }),
    };
  }
  const request = await queueSeriesInitialization({
    title: target.title,
    seasons: remaining,
    keyword: target.keyword,
    repository,
    accountId: scope.accountId,
    connectedStorageId: scope.connectedStorageId,
  });
  return {
    status: request.status === "queued" ? "queued" : request.status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: buildTvCandidateId({
        source: "tmdb",
        id: tmdbId,
        seasonNumber: remaining[0]?.seasonNumber ?? 1,
      }),
  };
}

/** Queue only the requested seasons that are not already tracked on this drive. */
export async function queueSelectedSeasons(
  tmdbId: number,
  seasonNumbers: number[],
  storageId?: string,
): Promise<CandidateTrackingRequestResult> {
  const selected = new Set(seasonNumbers.filter((number) => Number.isInteger(number) && number >= 0));
  if (selected.size === 0) {
    return { status: "unsupported", message: "请至少选择一季。" };
  }

  const repository = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope(storageId);
  await ensureDemoSeeded(repository);
  const target = await seriesTargetFor(tmdbId);
  if (!target) {
    return { status: "unsupported", message: "无法获取该剧的季信息。" };
  }

  const trackedSeasonNumbers = new Set(
    (await repository.listTrackedSeasonStates(scope))
      .filter((state) => state.title.tmdbId === tmdbId && state.title.type !== "movie")
      .map((state) => state.season.seasonNumber),
  );
  const requested = target.seasons.filter((season) => selected.has(season.seasonNumber));
  if (requested.length !== selected.size) {
    return { status: "unsupported", message: "所选季信息已变化，请刷新页面后重试。" };
  }
  const remaining = requested.filter((season) => !trackedSeasonNumbers.has(season.seasonNumber));
  if (remaining.length === 0) {
    return {
      status: "already_tracked",
      workflowRunId: null,
      trackedSeasonId: buildTvCandidateId({
        source: "tmdb",
        id: tmdbId,
        seasonNumber: requested[0]?.seasonNumber ?? target.seasons[0]?.seasonNumber ?? 1,
      }),
    };
  }

  const request = await queueSeriesInitialization({
    title: target.title,
    seasons: remaining,
    keyword: target.keyword,
    repository,
    accountId: scope.accountId,
    connectedStorageId: scope.connectedStorageId,
  });
  return {
    status: request.status === "queued" ? "queued" : request.status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: buildTvCandidateId({
      source: "tmdb",
      id: tmdbId,
      seasonNumber: remaining[0]?.seasonNumber ?? 1,
    }),
  };
}

export * from "./title-hub-wall";

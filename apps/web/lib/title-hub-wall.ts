import {
  isMovieUnreleased,
  isUserVisibleWorkflowKind,
  type MediaTitle,
  type WorkflowKind,
  type WorkflowRunProgress,
} from "@media-track/workflow";
import {
  libraryWallAiring,
  libraryWallState,
  type LibraryWallStateValue,
} from "./title-aggregate";
import { missingAiredEpisodeCodes } from "./subscription-missing";
import {
  ensureDemoSeeded,
  getActiveWorkspaceScope,
  getWorkflowRepository,
  movieTargetFromTmdbId,
} from "./workflow-runtime";
import { seriesTargetFor } from "./series-target";

export interface LibraryWallEntry {
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
  seasonCount: number;
  obtainedEpisodes: number;
  totalAiredEpisodes: number;
  missingAiredCount: number;
  totalEpisodes: number;
  releaseDate: string | null;
  state: LibraryWallStateValue;
  airing: boolean;
}

export interface LibraryTypeCounts {
  movie: number;
  tv: number;
  anime: number;
}

/** Poster-wall view of every tracked title. */
export async function getLibraryWall(storageId?: string): Promise<LibraryWallEntry[]> {
  const repository = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope(storageId);
  await ensureDemoSeeded(repository);
  const now = new Date().toISOString();
  const states = await repository.listTrackedSeasonStates(scope);
  const byTitle = new Map<number, typeof states>();
  for (const state of states) {
    const list = byTitle.get(state.title.tmdbId) ?? [];
    list.push(state);
    byTitle.set(state.title.tmdbId, list);
  }

  const titleList = Array.from(byTitle.entries()).map(([tmdbId, titleStates]) => ({
    tmdbId,
    titleStates,
    title: titleStates[0]!.title,
  }));

  // 并行获取缺失的海报，并异步回写 SQLite media_titles，彻底消除 N+1 串行外网请求
  const resolvedPosters = await Promise.all(
    titleList.map(async ({ title, tmdbId }) => {
      let posterPath = title.posterPath ?? null;
      if (posterPath === null) {
        try {
          const target =
            title.type === "movie"
              ? await movieTargetFromTmdbId(tmdbId).catch(() => null)
              : await seriesTargetFor(tmdbId).catch(() => null);
          posterPath = target?.title.posterPath ?? null;
          if (posterPath) {
            repository.updateMediaTitlePosterPath(title.id, posterPath).catch((err) => {
              console.warn(`[title-hub-wall] failed to persist posterPath for ${title.id}:`, err);
            });
          }
        } catch {
          posterPath = null;
        }
      }
      return { tmdbId, posterPath };
    }),
  );

  const posterByTmdb = new Map<number, string | null>(
    resolvedPosters.map((p) => [p.tmdbId, p.posterPath]),
  );

  const entries: LibraryWallEntry[] = [];
  for (const { tmdbId, titleStates, title } of titleList) {
    const posterPath = posterByTmdb.get(tmdbId) ?? null;
    let obtained = 0;
    let aired = 0;
    let total = 0;
    let missingAired = 0;
    let anyActive = false;
    for (const state of titleStates) {
      aired += Math.min(state.season.latestAiredEpisode, state.season.totalEpisodes);
      total += state.season.totalEpisodes;
      obtained += state.episodes.filter((episode) => episode.obtained).length;
      missingAired += missingAiredEpisodeCodes(state.episodes).length;
      if (state.season.status === "active") {
        anyActive = true;
      }
    }
    const unreleased = title.type === "movie" && isMovieUnreleased(title.releaseDate, now);
    entries.push({
      tmdbId,
      title: title.title,
      year: title.year,
      type: title.type,
      posterPath,
      seasonCount: titleStates.length,
      obtainedEpisodes: obtained,
      totalAiredEpisodes: aired,
      missingAiredCount: missingAired,
      totalEpisodes: total,
      releaseDate: title.releaseDate ?? null,
      state: libraryWallState({ obtained, aired, anyActive, unreleased }),
      airing: libraryWallAiring({ anyActive, unreleased }),
    });
  }
  return entries.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
}

export interface InProgressTitle {
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
  runId?: string | undefined;
  status?: ("queued" | "running") | undefined;
  queuePosition?: number | null | undefined;
  progress?: WorkflowRunProgress | null | undefined;
  kind?: WorkflowKind | undefined;
  startedAt?: string | undefined;
  seasonNumber?: number | null | undefined;
  activityText?: string | undefined;
}

export function inferActivityText(
  status: "queued" | "running",
  progress: WorkflowRunProgress | undefined | null,
  queuePosition: number | null | undefined,
): string {
  if (progress?.activity) return progress.activity;
  if (status === "queued") {
    return typeof queuePosition === "number" && queuePosition > 0
      ? `排队中（第 ${queuePosition} 位）`
      : "排队等待中";
  }
  return "处理中";
}

/** In-flight titles for the current workspace. */
export async function getInProgressTitles(storageId?: string): Promise<InProgressTitle[]> {
  const repository = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope(storageId);
  const snapshots = await repository.listActiveWorkflowRuns(scope);

  const active = snapshots.filter(
    (s) =>
      (s.workflowRun.status === "running" || s.workflowRun.status === "queued") &&
      isUserVisibleWorkflowKind(s.workflowRun.kind) &&
      // A replacement request applies to an already tracked title. Keep its library
      // card clickable so the user can edit or withdraw the request instead of
      // covering it with the "still acquiring" placeholder used for new imports.
      s.workflowRun.kind !== "replace_request",
  );

  const queuedOrder = active
    .filter((s) => s.workflowRun.status === "queued")
    .sort((a, b) => a.workflowRun.startedAt.localeCompare(b.workflowRun.startedAt))
    .map((s) => s.workflowRun.id);

  const uniqueActiveSnapshots: typeof active = [];
  const seenTmdb = new Set<number>();
  for (const snapshot of active) {
    if (!seenTmdb.has(snapshot.title.tmdbId)) {
      seenTmdb.add(snapshot.title.tmdbId);
      uniqueActiveSnapshots.push(snapshot);
    }
  }

  // 并行解析获取中条目的缺失海报并异步回写
  const resolvedInProgPosters = await Promise.all(
    uniqueActiveSnapshots.map(async (snapshot) => {
      const title = snapshot.title;
      let posterPath = title.posterPath ?? null;
      if (posterPath === null) {
        try {
          const target =
            title.type === "movie"
              ? await movieTargetFromTmdbId(title.tmdbId).catch(() => null)
              : await seriesTargetFor(title.tmdbId).catch(() => null);
          posterPath = target?.title.posterPath ?? null;
          if (posterPath) {
            repository.updateMediaTitlePosterPath(title.id, posterPath).catch(() => {});
          }
        } catch {
          posterPath = null;
        }
      }
      return { tmdbId: title.tmdbId, posterPath };
    }),
  );
  const inProgPosterMap = new Map<number, string | null>(
    resolvedInProgPosters.map((p) => [p.tmdbId, p.posterPath]),
  );

  const byTmdb = new Map<number, InProgressTitle>();
  for (const snapshot of uniqueActiveSnapshots) {
    const title = snapshot.title;
    const posterPath = inProgPosterMap.get(title.tmdbId) ?? null;

    const status = snapshot.workflowRun.status === "running" ? "running" : "queued";
    const queueIndex = queuedOrder.indexOf(snapshot.workflowRun.id);
    const queuePosition = status === "queued" && queueIndex >= 0 ? queueIndex + 1 : null;
    const progress = snapshot.workflowRun.progress ?? null;
    const activityText = inferActivityText(status, progress, queuePosition);

    byTmdb.set(title.tmdbId, {
      tmdbId: title.tmdbId,
      title: title.title,
      year: title.year,
      type: title.type,
      posterPath,
      runId: snapshot.workflowRun.id,
      status,
      queuePosition,
      progress,
      kind: snapshot.workflowRun.kind,
      startedAt: snapshot.workflowRun.startedAt,
      seasonNumber: snapshot.season.seasonNumber ?? null,
      activityText,
    });
  }
  return [...byTmdb.values()];
}

/** Get count of each media type in the library. */
export function getLibraryTypeCounts(entries: LibraryWallEntry[]): LibraryTypeCounts {
  return {
    movie: entries.filter((entry) => entry.type === "movie").length,
    tv: entries.filter((entry) => entry.type === "tv").length,
    anime: entries.filter((entry) => entry.type === "anime").length,
  };
}

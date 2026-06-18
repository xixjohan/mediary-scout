import type { LanguageModel } from "ai";
import type {
  AcquisitionSeasonScope,
  EpisodeState,
  MediaTitle,
  MediaType,
  TrackedSeason,
  WorkflowStatus,
} from "./domain.js";
import type { ResourceProvider, StorageExecutor } from "./ports.js";
import type { WorkflowRepository } from "./repository.js";
import { isMovieUnreleased } from "./domain.js";
import {
  runMovieAcquisitionV2AndPersist,
  runSeriesInitializationV2AndPersist,
  runType2InitializationV2AndPersist,
  runType3MonitoringV2AndPersist,
} from "./runner-v2.js";
import { syncSeasonAgainstMetadata } from "./season-sync.js";

/**
 * Pick the 115 landing parent for a title. Anime lands under its own parent
 * (when configured) so the 动漫 library shelf is a physically separate tree,
 * never intermixed with TV shows; everything else uses the default parent.
 */
function storageParentForTitle(
  title: { type: MediaType },
  storageParentDirectoryId: string | undefined,
  animeStorageParentDirectoryId: string | undefined,
): string | undefined {
  if (title.type === "anime" && animeStorageParentDirectoryId !== undefined) {
    return animeStorageParentDirectoryId;
  }
  return storageParentDirectoryId;
}

/**
 * Merge the per-account worker context (resolved from the run's owner) over the
 * globally-passed deps. Per-account fields (115 storage + landing CIDs) win;
 * everything else falls through to the base. No resolver → base unchanged.
 */
async function resolveWorkerDeps(
  resolve: ResolveAccountWorkerContext | undefined,
  accountId: string,
  connectedStorageId: string | null,
  base: AccountWorkerContext & {
    storage: StorageExecutor;
    resourceProvider: ResourceProvider;
    model: LanguageModel;
  },
): Promise<{
  storage: StorageExecutor;
  resourceProvider: ResourceProvider;
  model: LanguageModel;
  preferredLanguage: string | undefined;
  qualityPreference: "high" | "medium" | undefined;
  storageParentDirectoryId: string | undefined;
  animeStorageParentDirectoryId: string | undefined;
  moviesParentDirectoryId: string | undefined;
}> {
  const ctx = resolve ? await resolve(accountId, connectedStorageId) : {};
  return {
    storage: ctx.storage ?? base.storage,
    resourceProvider: ctx.resourceProvider ?? base.resourceProvider,
    model: ctx.model ?? base.model,
    preferredLanguage: ctx.preferredLanguage ?? base.preferredLanguage,
    qualityPreference: ctx.qualityPreference ?? base.qualityPreference,
    storageParentDirectoryId: ctx.storageParentDirectoryId ?? base.storageParentDirectoryId,
    animeStorageParentDirectoryId: ctx.animeStorageParentDirectoryId ?? base.animeStorageParentDirectoryId,
    moviesParentDirectoryId: ctx.moviesParentDirectoryId ?? base.moviesParentDirectoryId,
  };
}

/**
 * Refresh a tracked season's aired/total counts from TMDB. Returning null (or
 * throwing) leaves the season on its stored counts — the sweep still runs, it
 * just won't discover episodes aired since tracking began.
 */
export type SeasonMetadataSync = (input: {
  tmdbId: number;
  seasonNumber: number;
}) => Promise<{ latestAiredEpisode: number; totalEpisodes: number } | null>;

/**
 * §7: per-account worker context. After a run is claimed, the worker resolves the
 * RUN's account credentials (115 cookie via storage, landing CIDs) so a multi-user
 * acquisition transfers to the right person's 网盘. Every field is optional — the
 * resolver overrides only what is per-account (storage + CIDs); model/provider/
 * language fall through to the globally-passed values. No resolver → the function
 * uses its input deps unchanged (single-user / tests).
 */
export interface AccountWorkerContext {
  storage?: StorageExecutor;
  resourceProvider?: ResourceProvider;
  model?: LanguageModel;
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  storageParentDirectoryId?: string;
  animeStorageParentDirectoryId?: string;
  moviesParentDirectoryId?: string;
}

export type ResolveAccountWorkerContext = (
  accountId: string,
  connectedStorageId?: string | null,
) => Promise<AccountWorkerContext>;

export type QueuedType2WorkerResult =
  | {
      status: "idle";
    }
  | {
    status: "ran";
    workflowRunId: string;
    workflowStatus: WorkflowStatus;
  }
  | {
      status: "failed";
      workflowRunId: string;
      errorMessage: string;
    };

export async function runQueuedType2Workflow(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  now?: () => string;
  storageParentDirectoryId?: string;
  /** Separate landing parent for anime (see runQueuedSeriesInitialization). */
  animeStorageParentDirectoryId?: string;
  /** §7: resolve the claimed run's per-account 115 creds + landing CIDs. */
  resolveAccountContext?: ResolveAccountWorkerContext;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const claimed = await input.repository.claimNextQueuedWorkflowRun({
    kind: "type2_init",
    now: now(),
  });
  if (!claimed) {
    return { status: "idle" };
  }
  const deps = await resolveWorkerDeps(input.resolveAccountContext, claimed.accountId, claimed.connectedStorageId, input);

  try {
    const result = await runType2InitializationV2AndPersist({
      title: claimed.title,
      season: claimed.season,
      categoryParentId: requireCategoryParent(
        storageParentForTitle(claimed.title, deps.storageParentDirectoryId, deps.animeStorageParentDirectoryId),
      ),
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository: input.repository,
      accountId: claimed.accountId,
      ...(deps.preferredLanguage === undefined ? {} : { preferredLanguage: deps.preferredLanguage }),
      ...(deps.qualityPreference === undefined ? {} : { qualityPreference: deps.qualityPreference }),
      // finishedAt is stamped post-run inside the persist step (see runner-v2),
      // so it reflects actual completion, not the claim time.
      workflowRun: {
        id: claimed.workflowRun.id,
        startedAt: claimed.workflowRun.startedAt,
        finishedAt: null,
      },
      now,
    });

    return {
      status: "ran",
      workflowRunId: claimed.workflowRun.id,
      workflowStatus: result.status,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Workflow failed";
    await input.repository.saveWorkflowRunSnapshot({
      accountId: claimed.accountId,
      title: claimed.title,
      season: claimed.season,
      workflowRun: {
        ...claimed.workflowRun,
        status: "failed",
        finishedAt: now(),
        auditEvents: [
          ...claimed.workflowRun.auditEvents,
          {
            type: "workflow_failed",
            message: errorMessage,
          },
        ],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    return {
      status: "failed",
      workflowRunId: claimed.workflowRun.id,
      errorMessage,
    };
  }
}

export type ScheduledType3Outcome =
  | {
      trackedSeasonId: string;
      status: "skipped_active";
    }
  | {
      trackedSeasonId: string;
      status: "ran";
      workflowRunId: string;
      workflowStatus: WorkflowStatus;
    }
  | {
      trackedSeasonId: string;
      status: "failed";
      workflowRunId: string;
      errorMessage: string;
    };

/**
 * Unattended Type 3 sweep: one reservation-guarded monitoring run per active
 * tracked season. One season's failure never blocks the rest, and a failed
 * run preserves the season's episode state (unlike a failed Type 2 init,
 * which clears it).
 */
export async function runScheduledType3Monitoring(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  storageParentDirectoryId: string;
  /** Separate landing parent for anime, so anime patrol verify-or-creates under
   *  its own tree (see runQueuedSeriesInitialization). */
  animeStorageParentDirectoryId?: string;
  /** Movies category parent. When set, the sweep also patrols tracked-but-
   *  unobtained films, dispatching the MOVIE agent (by title.type) — 已上映无源
   *  films get retried until covered. Unset → movies are left alone. */
  moviesParentDirectoryId?: string;
  now?: () => string;
  createWorkflowRunId?: () => string;
  staleActiveRunTimeoutMs?: number;
  syncSeasonMetadata?: SeasonMetadataSync;
  /** §7: resolve each patrolled season's per-account 115 creds + landing CIDs.
   *  The sweep is cross-account; each show runs under its owner's credentials. */
  resolveAccountContext?: ResolveAccountWorkerContext;
}): Promise<ScheduledType3Outcome[]> {
  const now = input.now ?? (() => new Date().toISOString());
  const outcomes: ScheduledType3Outcome[] = [];
  // Cross-account: patrol EVERY user's tracked shows, each under its owner's creds.
  const trackedStates = await input.repository.listAllTrackedSeasonStates();

  for (const state of trackedStates) {
    const deps = await resolveWorkerDeps(input.resolveAccountContext, state.accountId, state.connectedStorageId, input);
    // Patrol dispatches by title.type: a film needs the MOVIE agent, not the
    // TV/anime agent (different semantics). (未上映/reserved films aren't tracked
    // yet; the air-time gate lands with that product state.)
    if (state.title.type === "movie") {
      const outcome = await patrolMovie({ input, deps, state, now });
      if (outcome) {
        outcomes.push(outcome);
      }
      continue;
    }

    if (state.season.status !== "active" || state.episodes.length === 0) {
      continue;
    }

    // sync_all equivalent: refresh aired/total from TMDB so episodes that aired
    // after tracking began surface as real gaps this sweep can acquire.
    let season = state.season;
    let episodes = state.episodes;
    if (input.syncSeasonMetadata) {
      try {
        const meta = await input.syncSeasonMetadata({
          tmdbId: state.title.tmdbId,
          seasonNumber: state.season.seasonNumber,
        });
        if (meta) {
          const synced = syncSeasonAgainstMetadata({
            season,
            episodes,
            latestAiredEpisode: meta.latestAiredEpisode,
            totalEpisodes: meta.totalEpisodes,
          });
          season = synced.season;
          episodes = synced.episodes;
        }
      } catch {
        // Metadata sync is best-effort; fall back to stored counts.
      }
    }

    const workflowRunId = input.createWorkflowRunId?.() ?? crypto.randomUUID();
    const startedAt = now();
    const staleActiveRunStartedBefore = staleStartedBefore(startedAt, input.staleActiveRunTimeoutMs);

    const reservation = await input.repository.reserveWorkflowRun({
      accountId: state.accountId,
      title: state.title,
      season,
      workflowRun: {
        id: workflowRunId,
        kind: "type3_monitor",
        status: "running",
        trackedSeasonId: season.id,
        startedAt,
        finishedAt: null,
        auditEvents: [
          {
            type: "type3_scheduled",
            message: "Scheduled Type 3 monitoring reserved",
          },
        ],
      },
      episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
      ...(staleActiveRunStartedBefore === null
        ? {}
        : { staleActiveRunStartedBefore, staleFinishedAt: startedAt }),
    });
    if (reservation.status !== "reserved") {
      outcomes.push({ trackedSeasonId: season.id, status: "skipped_active" });
      continue;
    }

    try {
      const result = await runType3MonitoringV2AndPersist({
        title: state.title,
        season,
        episodes,
        categoryParentId: requireCategoryParent(
          storageParentForTitle(state.title, deps.storageParentDirectoryId, deps.animeStorageParentDirectoryId),
        ),
        resourceProvider: deps.resourceProvider,
        storage: deps.storage,
        model: deps.model,
        repository: input.repository,
        accountId: state.accountId,
        ...(deps.preferredLanguage === undefined ? {} : { preferredLanguage: deps.preferredLanguage }),
        ...(deps.qualityPreference === undefined ? {} : { qualityPreference: deps.qualityPreference }),
        workflowRun: { id: workflowRunId, startedAt, finishedAt: null },
        now,
      });
      outcomes.push({
        trackedSeasonId: state.season.id,
        status: "ran",
        workflowRunId,
        workflowStatus: result.status,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Workflow failed";
      await input.repository.saveWorkflowRunSnapshot({
        accountId: state.accountId,
        title: state.title,
        season: state.season,
        workflowRun: {
          id: workflowRunId,
          kind: "type3_monitor",
          status: "failed",
          trackedSeasonId: state.season.id,
          startedAt,
          finishedAt: now(),
          auditEvents: [
            { type: "type3_scheduled", message: "Scheduled Type 3 monitoring reserved" },
            { type: "workflow_failed", message: errorMessage },
          ],
        },
        episodes: state.episodes,
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
      outcomes.push({
        trackedSeasonId: state.season.id,
        status: "failed",
        workflowRunId,
        errorMessage,
      });
    }
  }

  return outcomes;
}

/**
 * Patrol one tracked film: a 已上映无源 movie (anchor episode not obtained) is
 * retried by the MOVIE agent. Returns null when nothing to do (already obtained,
 * or no movies parent configured). A reservation guards against a concurrent run.
 */
async function patrolMovie(args: {
  input: {
    repository: WorkflowRepository;
    createWorkflowRunId?: () => string;
    staleActiveRunTimeoutMs?: number;
  };
  deps: {
    resourceProvider: ResourceProvider;
    storage: StorageExecutor;
    model: LanguageModel;
    preferredLanguage: string | undefined;
    qualityPreference: "high" | "medium" | undefined;
    moviesParentDirectoryId: string | undefined;
  };
  state: { accountId: string; title: MediaTitle; season: TrackedSeason; episodes: EpisodeState[] };
  now: () => string;
}): Promise<ScheduledType3Outcome | null> {
  const { input, deps, state, now } = args;
  const moviesParent = deps.moviesParentDirectoryId;
  if (moviesParent === undefined) {
    return null;
  }
  const obtained = state.episodes.some((episode) => episode.obtained);
  if (obtained) {
    return null;
  }
  // Air-time gate: a reserved (未上映) film whose release date is still in the
  // future stays reserved — the agent must NOT run before release. Once the date
  // arrives this gate opens and the patrol collects it (点预定 → 上映后自然收).
  if (isMovieUnreleased(state.title.releaseDate, now())) {
    return null;
  }

  const workflowRunId = input.createWorkflowRunId?.() ?? crypto.randomUUID();
  const startedAt = now();
  const staleActiveRunStartedBefore = staleStartedBefore(startedAt, input.staleActiveRunTimeoutMs);
  const reservation = await input.repository.reserveWorkflowRun({
    accountId: state.accountId,
    title: state.title,
    season: state.season,
    workflowRun: {
      id: workflowRunId,
      kind: "movie_init",
      status: "running",
      trackedSeasonId: state.season.id,
      startedAt,
      finishedAt: null,
      auditEvents: [{ type: "movie_patrol_scheduled", message: "Scheduled movie patrol reserved" }],
    },
    episodes: state.episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    ...(staleActiveRunStartedBefore === null
      ? {}
      : { staleActiveRunStartedBefore, staleFinishedAt: startedAt }),
  });
  if (reservation.status !== "reserved") {
    return { trackedSeasonId: state.season.id, status: "skipped_active" };
  }

  try {
    const result = await runMovieAcquisitionV2AndPersist({
      title: state.title,
      categoryParentId: moviesParent,
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository: input.repository,
      accountId: state.accountId,
      ...(deps.preferredLanguage === undefined ? {} : { preferredLanguage: deps.preferredLanguage }),
      ...(deps.qualityPreference === undefined ? {} : { qualityPreference: deps.qualityPreference }),
      workflowRun: { id: workflowRunId, startedAt, finishedAt: null },
      now,
    });
    return { trackedSeasonId: state.season.id, status: "ran", workflowRunId, workflowStatus: result.status };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Workflow failed";
    await input.repository.saveWorkflowRunSnapshot({
      accountId: state.accountId,
      title: state.title,
      season: state.season,
      workflowRun: {
        id: workflowRunId,
        kind: "movie_init",
        status: "failed",
        trackedSeasonId: state.season.id,
        startedAt,
        finishedAt: now(),
        auditEvents: [
          { type: "movie_patrol_scheduled", message: "Scheduled movie patrol reserved" },
          { type: "workflow_failed", message: errorMessage },
        ],
      },
      episodes: state.episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    return { trackedSeasonId: state.season.id, status: "failed", workflowRunId, errorMessage };
  }
}

function staleStartedBefore(nowIso: string, timeoutMs: number | undefined): string | null {
  if (timeoutMs === undefined) {
    return null;
  }
  if (timeoutMs <= 0) {
    throw new Error("staleActiveRunTimeoutMs must be positive");
  }
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`Invalid now timestamp: ${nowIso}`);
  }
  return new Date(nowMs - timeoutMs).toISOString();
}

/**
 * The V2 directory lifecycle must verify-or-create the library category parent
 * (Movies/TV/Anime); a missing parent is a misconfiguration, not a silent
 * account-root fallback (fail loud — see acquisition-hard-details).
 */
function requireCategoryParent(parent: string | undefined): string {
  if (parent === undefined || parent === "") {
    throw new Error(
      "MEDIA_TRACK_CATEGORY_PARENT_REQUIRED: a library category parent (Movies/TV/Anime) is required for directory verify-or-create",
    );
  }
  return parent;
}

export async function runQueuedMovieAcquisition(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  moviesParentDirectoryId: string;
  now?: () => string;
  /** §7: resolve the claimed run's per-account 115 creds + landing CIDs. */
  resolveAccountContext?: ResolveAccountWorkerContext;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const claimed = await input.repository.claimNextQueuedWorkflowRun({ kind: "movie_init", now: now() });
  if (!claimed) {
    return { status: "idle" };
  }
  const deps = await resolveWorkerDeps(input.resolveAccountContext, claimed.accountId, claimed.connectedStorageId, input);

  try {
    const result = await runMovieAcquisitionV2AndPersist({
      title: claimed.title,
      categoryParentId: deps.moviesParentDirectoryId ?? input.moviesParentDirectoryId,
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository: input.repository,
      accountId: claimed.accountId,
      ...(deps.preferredLanguage === undefined ? {} : { preferredLanguage: deps.preferredLanguage }),
      ...(deps.qualityPreference === undefined ? {} : { qualityPreference: deps.qualityPreference }),
      workflowRun: { id: claimed.workflowRun.id, startedAt: claimed.workflowRun.startedAt, finishedAt: null },
      now,
    });
    return { status: "ran", workflowRunId: claimed.workflowRun.id, workflowStatus: result.status };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Workflow failed";
    await input.repository.saveWorkflowRunSnapshot({
      accountId: claimed.accountId,
      title: claimed.title,
      season: claimed.season,
      workflowRun: {
        ...claimed.workflowRun,
        status: "failed",
        finishedAt: now(),
        auditEvents: [...claimed.workflowRun.auditEvents, { type: "workflow_failed", message: errorMessage }],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    return { status: "failed", workflowRunId: claimed.workflowRun.id, errorMessage };
  }
}

export async function runQueuedSeriesInitialization(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  storageParentDirectoryId: string;
  /** Separate landing parent for anime, so the 动漫 shelf is physically its own
   *  tree on 115 and never mixed into the TV shows directory. */
  animeStorageParentDirectoryId?: string;
  now?: () => string;
  /** §7: resolve the claimed run's per-account 115 creds + landing CIDs. */
  resolveAccountContext?: ResolveAccountWorkerContext;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const claimed = await input.repository.claimNextQueuedWorkflowRun({
    kind: "type1_package_init",
    now: now(),
  });
  if (!claimed) {
    return { status: "idle" };
  }
  const deps = await resolveWorkerDeps(input.resolveAccountContext, claimed.accountId, claimed.connectedStorageId, input);

  const queuedEvent = claimed.workflowRun.auditEvents.find((event) => event.type === "series_init_queued");
  const seasons = (queuedEvent?.data?.["seasons"] ?? []) as AcquisitionSeasonScope[];

  try {
    if (seasons.length === 0) {
      throw new Error("Queued series initialization run is missing its season metadata");
    }
    const result = await runSeriesInitializationV2AndPersist({
      title: claimed.title,
      seasons,
      categoryParentId: requireCategoryParent(
        storageParentForTitle(claimed.title, deps.storageParentDirectoryId, deps.animeStorageParentDirectoryId),
      ),
      seasonQualityRecord: claimed.season.qualityPreference,
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository: input.repository,
      accountId: claimed.accountId,
      ...(deps.preferredLanguage === undefined ? {} : { preferredLanguage: deps.preferredLanguage }),
      ...(deps.qualityPreference === undefined ? {} : { qualityPreference: deps.qualityPreference }),
      workflowRun: {
        id: claimed.workflowRun.id,
        startedAt: claimed.workflowRun.startedAt,
        finishedAt: null,
      },
      now,
    });
    // Finalize the claimed lock run itself; it doubles as season 1's summary
    // record (same tracked season and episode state as the persisted _s1 run).
    const firstSeason = result.seasons[0];
    await input.repository.saveWorkflowRunSnapshot({
      accountId: claimed.accountId,
      title: claimed.title,
      season: firstSeason?.season ?? claimed.season,
      workflowRun: {
        ...claimed.workflowRun,
        status: result.status,
        finishedAt: now(),
        auditEvents: [...claimed.workflowRun.auditEvents, ...result.auditEvents],
      },
      episodes: firstSeason?.episodes ?? [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    return {
      status: "ran",
      workflowRunId: claimed.workflowRun.id,
      workflowStatus: result.status,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Workflow failed";
    await input.repository.saveWorkflowRunSnapshot({
      accountId: claimed.accountId,
      title: claimed.title,
      season: claimed.season,
      workflowRun: {
        ...claimed.workflowRun,
        status: "failed",
        finishedAt: now(),
        auditEvents: [
          ...claimed.workflowRun.auditEvents,
          { type: "workflow_failed", message: errorMessage },
        ],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    return { status: "failed", workflowRunId: claimed.workflowRun.id, errorMessage };
  }
}

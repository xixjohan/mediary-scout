import type { LanguageModel } from "ai";
import { runKeyedPool } from "../storage/keyed-pool.js";
import type {
  AcquisitionSeasonScope,
  EpisodeState,
  MediaTitle,
  MediaType,
  NotificationEvent,
  NotificationReport,
  TrackedSeason,
  WorkflowStatus,
} from "../domain/domain.js";
import type { ResourceProvider, StorageExecutor } from "../domain/ports.js";
import type { PersistedWorkflowRunSnapshot, QueueClaimOptions, WorkflowRepository } from "../persistence/repository.js";
import {
  AUTO_REQUEUE_BACKOFF_MS,
  AUTO_REQUEUE_MAX,
  claimNextQueuedRun,
  failWorkflowRun,
  requeueWorkflowRunForRetry,
} from "../persistence/repository.js";
import { isTransientAcquisitionError } from "../acquisition-v2/transient-error.js";
import type { JevJudge } from "../providers/jev-judge.js";
import { stagingFailureAuditEvents } from "../acquisition-v2/directory-lifecycle.js";
import { hasTransferAttemptedOnThrow } from "../acquisition-v2/orchestrator.js";
import { cooldownLogLine, overBudgetLogLine, patrolSkipKey, planPatrolScope } from "./patrol-scope.js";
import {
  describeAgentRunError,
  isLlmAuthError,
  isLlmHttpStatusError,
  isLlmModelGoneError,
  isLlmRateLimitError,
  isLlmServerError,
  summarizeErrorForNotification,
} from "../domain/agent-error.js";
import { isFreeLlmPreset } from "../domain/agent-model.js";
import type { TitleResearchOptions } from "../acquisition-v2/title-research.js";
import { formatReportPushText } from "../domain/notification-report.js";
import { isMovieUnreleased } from "../domain/domain.js";
import {
  runMovieAcquisitionV2AndPersist,
  runSeriesInitializationV2AndPersist,
  runType2InitializationV2AndPersist,
  runType3MonitoringV2AndPersist,
} from "./runner-v2.js";
import { triggerPostIngestSyncIfSucceeded } from "../strm/pinpoint-ingest-sync.js";
import type { MediaServerCoordinator } from "../mediaserver/coordinator.js";
import { hasIncompleteEpisodeStates, syncSeasonAgainstMetadata } from "./season-sync.js";
import { isBrandStorageAuthError, maybeFreezeOnBrandAuthError } from "../storage/storage-auth-error.js";
import { staleStartedBefore } from "./commands.js";
import { userMessageDrive, type UserMessageScope } from "./user-requests.js";
// Circular with replace-request.ts (it uses this module's claim helpers); both sides
// only call the other's functions at run time, never at module evaluation.
import { queueReplaceRequest } from "./replace-request.js";

/**
 * Pick the 115 landing parent for a title. Anime lands under its own parent
 * (when configured) so the 动漫 library shelf is a physically separate tree,
 * never intermixed with TV shows; everything else uses the default parent.
 */
export function storageParentForTitle(
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
export interface BaseWorkerDeps {
  storage: StorageExecutor;
  resourceProvider: ResourceProvider;
  model: LanguageModel;
  llmConfig?: { baseURL?: string; modelId?: string };
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  storageProvider?: string;
  assrtToken?: string;
  jevJudge?: JevJudge;
  agentMemory?: boolean;
  titleResearch?: TitleResearchOptions;
  storageParentDirectoryId?: string;
  animeStorageParentDirectoryId?: string;
  moviesParentDirectoryId?: string;
  baseUrl?: string;
  mediaServerCoordinator?: MediaServerCoordinator;
}

export async function resolveWorkerDeps(
  resolve: ResolveAccountWorkerContext | undefined,
  accountId: string,
  connectedStorageId: string | null,
  base: BaseWorkerDeps,
): Promise<{
  storage: StorageExecutor;
  resourceProvider: ResourceProvider;
  model: LanguageModel;
  llmConfig: { baseURL?: string; modelId?: string } | undefined;
  preferredLanguage: string | undefined;
  qualityPreference: "high" | "medium" | undefined;
  storageProvider: string | undefined;
  assrtToken: string | undefined;
  jevJudge: JevJudge | undefined;
  agentMemory: boolean | undefined;
  titleResearch: TitleResearchOptions | undefined;
  storageParentDirectoryId: string | undefined;
  animeStorageParentDirectoryId: string | undefined;
  moviesParentDirectoryId: string | undefined;
  baseUrl: string | undefined;
  mediaServerCoordinator: MediaServerCoordinator | undefined;
}> {
  const ctx = resolve ? await resolve(accountId, connectedStorageId) : {};
  return {
    storage: ctx.storage ?? base.storage,
    resourceProvider: ctx.resourceProvider ?? base.resourceProvider,
    model: ctx.model ?? base.model,
    // The failure-copy config must describe the model THIS run actually uses.
    // The resolver's model wins only when it discloses its config; a resolver
    // that overrides the model without llmConfig yields undefined → the worker
    // falls back to the AGNOSTIC copy (never guess a config it cannot see).
    llmConfig: ctx.model !== undefined ? ctx.llmConfig : base.llmConfig,
    preferredLanguage: ctx.preferredLanguage ?? base.preferredLanguage,
    qualityPreference: ctx.qualityPreference ?? base.qualityPreference,
    storageProvider: ctx.storageProvider ?? base.storageProvider,
    assrtToken: ctx.assrtToken ?? base.assrtToken,
    // Jev is per-account opt-in: with a resolver, its answer is authoritative even
    // when it has no judge — an account that never configured (or switched off) the
    // prefilter must not inherit a judge that happens to ride in the base deps.
    jevJudge: resolve ? ctx.jevJudge : base.jevJudge,
    agentMemory: ctx.agentMemory ?? base.agentMemory,
    // Web search follows the account's LLM endpoint (DeepSeek's own engine when
    // that is what they configured). With a resolver its answer is authoritative
    // — an account without one must not inherit another account's config.
    titleResearch: resolve ? ctx.titleResearch : base.titleResearch,
    storageParentDirectoryId:
      ctx.storageParentDirectoryId ?? base.storageParentDirectoryId,
    animeStorageParentDirectoryId:
      ctx.animeStorageParentDirectoryId ?? base.animeStorageParentDirectoryId,
    moviesParentDirectoryId:
      ctx.moviesParentDirectoryId ?? base.moviesParentDirectoryId,
    baseUrl: ctx.baseUrl ?? base.baseUrl,
    mediaServerCoordinator: ctx.mediaServerCoordinator ?? base.mediaServerCoordinator,
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
  accountId: string;
}) => Promise<{ latestAiredEpisode: number; totalEpisodes: number } | null>;

/**
 * §7: per-account worker context. After a run is claimed, the worker resolves the
 * RUN's account credentials (115 cookie via storage, landing CIDs) so a multi-user
 * acquisition transfers to the right person's 网盘. Every field is optional — the
 * resolver overrides only what is per-account (storage + CIDs); model/provider/
 * language fall through to the globally-passed values. No resolver → the function
 * uses its input deps unchanged (single-user / tests).
 */
/** Asked right before a run is claimed or reserved as running. False = start nothing
 *  now (the web process is about to be replaced by an update); queued runs stay
 *  queued. Absent = always allowed. */
export type MayStartRun = () => boolean;

export interface AccountWorkerContext extends Partial<BaseWorkerDeps> {}

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

import {
  FREE_LLM_MODEL_GONE_LINE,
  FREE_LLM_POOL_FAILURE_LINE,
  handleWorkflowRunFailure,
  isTransientForRun,
} from "./workflow-failure-handler.js";

export {
  FREE_LLM_MODEL_GONE_LINE,
  FREE_LLM_POOL_FAILURE_LINE,
  handleWorkflowRunFailure,
};

export async function runQueuedType2Workflow(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  /** Config that built `model` (failure-copy only — see AccountWorkerContext.llmConfig). */
  llmConfig?: { baseURL?: string; modelId?: string };
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  /** Web-reference tools for the agent (see TitleResearchOptions). */
  titleResearch?: TitleResearchOptions;
  now?: () => string;
  storageParentDirectoryId?: string;
  /** Separate landing parent for anime (see runQueuedSeriesInitialization). */
  animeStorageParentDirectoryId?: string;
  /** §7: resolve the claimed run's per-account 115 creds + landing CIDs. */
  resolveAccountContext?: ResolveAccountWorkerContext;
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  mayStartRun?: MayStartRun;
  /** The worker's drive filter and claim callback when queued runs go side by side. */
  claim?: QueueClaimOptions;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.mayStartRun && !input.mayStartRun()) {
    return { status: "idle" };
  }
  const claimed = await claimNextQueuedRun(input.repository, "type2_init", now(), input.claim);
  if (!claimed) {
    return { status: "idle" };
  }
  // The config of the model this run ENDED UP using (per-account resolver may
  // override the base) — captured for the failure handler's free-tier copy.
  let resolvedLlmConfig: { baseURL?: string; modelId?: string } | undefined;
  // Inside the try: a throw here (drive gone, settings cleared, a DB blip) must end the
  // claimed run through the failure handler, not leave it "running".
  try {
    const deps = await resolveWorkerDeps(
      input.resolveAccountContext,
      claimed.accountId,
      claimed.connectedStorageId,
      input,
    );
    resolvedLlmConfig = deps.llmConfig;
    const categoryParentId = requireCategoryParent(
      storageParentForTitle(claimed.title, deps.storageParentDirectoryId, deps.animeStorageParentDirectoryId),
    );
    const result = await runType2InitializationV2AndPersist({
      title: claimed.title,
      season: claimed.season,
      categoryParentId,
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository: input.repository,
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      ...(deps.preferredLanguage === undefined ? {} : { preferredLanguage: deps.preferredLanguage }),
      ...(deps.qualityPreference === undefined ? {} : { qualityPreference: deps.qualityPreference }),
      ...(deps.storageProvider === undefined ? {} : { storageProvider: deps.storageProvider }),
      ...(deps.assrtToken === undefined ? {} : { assrtToken: deps.assrtToken }),
      ...(deps.jevJudge === undefined ? {} : { jevJudge: deps.jevJudge }),
      ...(deps.agentMemory === undefined ? {} : { agentMemory: deps.agentMemory }),
      ...(deps.titleResearch === undefined ? {} : { titleResearch: deps.titleResearch }),
      workflowRun: { id: claimed.workflowRun.id, startedAt: claimed.workflowRun.startedAt, finishedAt: null },
      now,
    });

    await triggerPostIngestSyncIfSucceeded(result.status, {
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      repository: input.repository,
      storage: deps.storage,
      title: claimed.title,
      categoryParentId,
      baseUrl: deps.baseUrl,
      mediaServerCoordinator: deps.mediaServerCoordinator,
    });
    return {
      status: "ran",
      workflowRunId: claimed.workflowRun.id,
      workflowStatus: result.status,
    };
  } catch (error) {
    const handled = await handleWorkflowRunFailure({
      claimed,
      error,
      repository: input.repository,
      now,
      ...(resolvedLlmConfig === undefined ? {} : { llmConfig: resolvedLlmConfig }),
      ...(input.onAuthErrorFreeze === undefined
        ? {}
        : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
    });
    return handled.status === "auto_requeued"
      ? { status: "ran", workflowRunId: handled.workflowRunId, workflowStatus: "queued" }
      : { status: "failed", workflowRunId: handled.workflowRunId, errorMessage: handled.errorMessage };
  }
}

export type ScheduledType3Outcome =
  | {
      trackedSeasonId: string;
      status: "skipped_active";
    }
  | {
      /** Untracked after the sweep read it: nothing was written, nothing ran. */
      trackedSeasonId: string;
      status: "skipped_untracked";
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
  /** Config that built `model` (used for free-preset HTTP-status transient classification). */
  llmConfig?: { baseURL?: string; modelId?: string };
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  /** Web-reference tools for the agent (see TitleResearchOptions). */
  titleResearch?: TitleResearchOptions;
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
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  /** How many shows the sweep works on at once (default 1 = one after another).
   *  Never two on the same drive — see runKeyedPool. */
  maxConcurrentRuns?: number;
  /** The drive an account's unbound shows land on (its default drive). Used only
   *  to keep those shows off the same drive as its bound ones when running in
   *  parallel; null when the account has no drive. */
  resolveDriveId?: (accountId: string) => Promise<string | null>;
  /** Checked before each show's run is reserved; a false stops the rest of the sweep
   *  from starting (those shows are reported skipped_active). */
  mayStartRun?: MayStartRun;
  /** 批次 5：监控季数上限（plan §4.1 成本模型）。未配/非法值回落到保守默认。 */
  configuredMaxMonitoredSeasons?: number | string | null;
  /** 批次 5：每日巡检次数，用于超限提示里的成本估算。不给就不编估算。 */
  patrolsPerDay?: number;
}): Promise<ScheduledType3Outcome[]> {
  const now = input.now ?? (() => new Date().toISOString());
  // Cross-account: patrol EVERY user's tracked shows, each under its owner's creds.
  const trackedStates = await input.repository.listAllTrackedSeasonStates();

  // Works with a user message or an unfinished replacement run as ONE replace_request
  // (it covers every season and includes the gaps), so this sweep skips their seasons.
  // Queued, not run here: the queue worker claims it right after the sweep.
  const workKey = (w: UserMessageScope) => JSON.stringify([w.accountId, w.drive, w.titleKey]);
  const requestWorks = [
    ...(await input.repository.listWorksWithPendingMessages({ urgentOnly: false })),
    ...(await input.repository.listWorksWithPendingReplacements()),
  ];
  const requestKeys = new Set(requestWorks.map(workKey));

  // The drive a show runs on: its bound drive, else its account's default drive (null:
  // no drive at all → the process-wide fallback executor). One lookup per account.
  const defaultDrives = new Map<string, Promise<string | null>>();
  const defaultDriveOf = (accountId: string) => {
    let drive = defaultDrives.get(accountId);
    if (!drive) {
      drive = input.resolveDriveId ? input.resolveDriveId(accountId) : Promise.resolve(null);
      defaultDrives.set(accountId, drive);
    }
    return drive;
  };
  // A frozen drive's login is dead: every call on it fails until the drive is re-bound.
  // Its shows and requests wait untouched (no run, no call to the drive) and are
  // patrolled again once the drive is active.
  const frozenDrives = new Set<string>();
  for (const accountId of new Set([...trackedStates, ...requestWorks].map((item) => item.accountId))) {
    for (const storage of await input.repository.listConnectedStorages(accountId)) {
      if (storage.status === "frozen") frozenDrives.add(storage.id);
    }
  }
  const skippedOnFrozen = new Map<string, number>();
  const onFrozenDrive = async (accountId: string, connectedStorageId: string | null) => {
    const drive = connectedStorageId ?? (await defaultDriveOf(accountId));
    if (drive === null || !frozenDrives.has(drive)) return false;
    skippedOnFrozen.set(drive, (skippedOnFrozen.get(drive) ?? 0) + 1);
    return true;
  };

  for (const key of requestKeys) {
    const [accountId, drive, titleKey] = JSON.parse(key) as [string, string, string];
    // Still in requestKeys, so the ordinary patrol leaves the work alone too.
    if (await onFrozenDrive(accountId, drive === "" ? null : drive)) continue;
    try {
      await queueReplaceRequest({ repository: input.repository, work: { accountId, drive, titleKey }, now, origin: "patrol" });
    } catch (error) {
      // One work's queueing failure must not abort the whole sweep; the next sweep retries it.
      console.error(`[user-message] patrol could not queue a replace request for ${titleKey}: ${String(error)}`);
    }
  }
  // Also skip a title whose replace run or leftover recovery is already active.
  // Patrols run outside the queue drain, so either would move files in the same
  // directories at the same time. This filter is only the cheap path; a run queued
  // after it is caught by the patrol reservation (blockIfTitleHasActiveKinds).
  // The janitor will not queue a recovery while any run of the title is active,
  // so the exclusion holds both ways.
  const busyKeys = new Set((await input.repository.listWorksWithProcessingMessages()).map(workKey));
  for (const accountId of new Set(trackedStates.map((s) => s.accountId))) {
    for (const run of await input.repository.listActiveWorkflowRuns({ accountId, connectedStorageId: null })) {
      if (run.workflowRun.kind !== "replace_request" && run.workflowRun.kind !== "staging_recovery") continue;
      busyKeys.add(workKey({ accountId, drive: userMessageDrive(run.connectedStorageId), titleKey: run.title.id }));
    }
  }
  // 成本门会按冷却期筛掉一部分，所以是 let 而非 const。
  let patrolStates: typeof trackedStates = [];
  for (const s of trackedStates) {
    // 订阅完成防重复运行：已入库电影、未上映预定电影、已完结剧集季不加入巡检队列
    if (s.title.type === "movie") {
      if (s.episodes.some((e) => e.obtained)) continue;
      if (isMovieUnreleased(s.title.releaseDate, now())) continue;
    } else {
      if (s.season.status !== "active" || s.episodes.length === 0) continue;
    }
    const key = workKey({ accountId: s.accountId, drive: userMessageDrive(s.connectedStorageId), titleKey: s.title.id });
    if (requestKeys.has(key) || busyKeys.has(key)) continue;
    if (await onFrozenDrive(s.accountId, s.connectedStorageId)) continue;
    patrolStates.push(s);
  }
  for (const [drive, count] of skippedOnFrozen) {
    console.log(`[patrol] drive ${drive} is frozen (login expired): skipped ${count} item(s) until it is re-bound`);
  }

  // 批次 5 成本门（plan §4.1）：监控季数上限 + 每部作品的冷却期。此前两个护栏都是
  // 只有测试没有调用方的纯函数——写好了没人接等于没有。这里接上，并保持三条性质：
  //   ① 没配策略的作品照常巡检（策略层是 opt-in 过滤器，不是闸门）；
  //   ② 超限仍巡检上限内的部分，只是明确告知（全部跳过会让每个人的订阅一起停）；
  //   ③ 跳过必留日志——默默跳过等于订阅凭空停摆。
  const scopeDecision = await planPatrolScope({
    candidates: patrolStates.map((state) => ({
      accountId: state.accountId,
      titleKey: state.title.id,
      titleName: state.title.title,
    })),
    lookupPolicy: async (candidate) =>
      input.repository.getSubscriptionPolicy({
        accountId: candidate.accountId,
        titleKey: candidate.titleKey,
      }),
    ...(input.configuredMaxMonitoredSeasons === undefined
      ? {}
      : { configuredMaxSeasons: input.configuredMaxMonitoredSeasons }),
    ...(input.patrolsPerDay === undefined ? {} : { searchesPerDay: input.patrolsPerDay }),
    now: now(),
  });
  const budgetLine = overBudgetLogLine(scopeDecision);
  if (budgetLine !== null) console.log(budgetLine);
  const coolingLine = cooldownLogLine(scopeDecision.skipped);
  if (coolingLine !== null) console.log(coolingLine);
  // 键是 (account, title)，不是 title：标题跨账号共享（同一部剧两个用户都订），
  // 只按 title 过滤会让一家的冷却静默停掉另一家的订阅。
  const cooledOff = new Set(scopeDecision.skipped.map((entry) => patrolSkipKey(entry)));
  patrolStates = patrolStates.filter(
    (state) => !cooledOff.has(patrolSkipKey({ accountId: state.accountId, titleKey: state.title.id })),
  );

  // One drive at a time, several drives side by side (see runKeyedPool). The key
  // is the drive the run will actually land on: a state with no bound drive runs
  // on its account's default drive, so it must share that drive's key, not get
  // one of its own.
  const concurrency = input.maxConcurrentRuns ?? 1;
  const driveKeys =
    concurrency > 1
      ? await Promise.all(
          patrolStates.map(async (state) => {
            const drive = state.connectedStorageId ?? (await defaultDriveOf(state.accountId));
            // No drive at all → the process-wide fallback executor (env cookie / fake),
            // which every such account shares: one key for all of them.
            return drive ?? "no-connected-drive";
          }),
        )
      : [];
  const keyByState = new Map(patrolStates.map((state, index) => [state, driveKeys[index] ?? ""]));
  // A throw from one state's setup (drive client, DB reservation) is an infra
  // failure: it aborts the sweep as the serial loop did, so the caller can release
  // today's claimed slots and retry. Failures inside a run are outcomes, not throws.
  const perState = await runKeyedPool(
    patrolStates,
    { concurrency, keyOf: (state) => keyByState.get(state)! },
    (state) => patrolTrackedState({ input, state, now }),
  );
  return perState.filter((outcome): outcome is ScheduledType3Outcome => outcome !== null);
}

type ScheduledType3Input = Parameters<typeof runScheduledType3Monitoring>[0];

type ResolvedWorkerDependencies = Awaited<ReturnType<typeof resolveWorkerDeps>>;

function type3RunnerOptions(deps: ResolvedWorkerDependencies) {
  return {
    ...(deps.preferredLanguage === undefined ? {} : { preferredLanguage: deps.preferredLanguage }),
    ...(deps.qualityPreference === undefined ? {} : { qualityPreference: deps.qualityPreference }),
    ...(deps.storageProvider === undefined ? {} : { storageProvider: deps.storageProvider }),
    ...(deps.assrtToken === undefined ? {} : { assrtToken: deps.assrtToken }),
    ...(deps.jevJudge === undefined ? {} : { jevJudge: deps.jevJudge }),
    ...(deps.agentMemory === undefined ? {} : { agentMemory: deps.agentMemory }),
    ...(deps.titleResearch === undefined ? {} : { titleResearch: deps.titleResearch }),
  };
}

/** Claim and execute one durable manual search of an existing subscription. */
export async function runQueuedType3Monitoring(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  llmConfig?: { baseURL?: string; modelId?: string };
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  titleResearch?: TitleResearchOptions;
  storageParentDirectoryId?: string;
  animeStorageParentDirectoryId?: string;
  moviesParentDirectoryId?: string;
  syncSeasonMetadata?: SeasonMetadataSync;
  now?: () => string;
  resolveAccountContext?: ResolveAccountWorkerContext;
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  mayStartRun?: MayStartRun;
  claim?: QueueClaimOptions;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.mayStartRun && !input.mayStartRun()) return { status: "idle" };
  const claimed = await claimNextQueuedRun(input.repository, "type3_monitor", now(), input.claim);
  if (!claimed) return { status: "idle" };

  let resolvedLlmConfig: { baseURL?: string; modelId?: string } | undefined;
  try {
    const deps = await resolveWorkerDeps(
      input.resolveAccountContext,
      claimed.accountId,
      claimed.connectedStorageId,
      input,
    );
    resolvedLlmConfig = deps.llmConfig;
    const userTriggered = claimed.workflowRun.auditEvents.some((event) => event.type === "manual_subscription_search_queued");

    if (claimed.title.type === "movie") {
      const workflowStatus = await runQueuedType3Movie({ request: input, claimed, deps, userTriggered, now });
      return { status: "ran", workflowRunId: claimed.workflowRun.id, workflowStatus };
    }

    const workflowStatus = await runQueuedType3Season({ request: input, claimed, deps, userTriggered, now });
    return { status: "ran", workflowRunId: claimed.workflowRun.id, workflowStatus };
  } catch (error) {
    const handled = await handleWorkflowRunFailure({
      claimed,
      error,
      repository: input.repository,
      now,
      ...(resolvedLlmConfig === undefined ? {} : { llmConfig: resolvedLlmConfig }),
      ...(input.onAuthErrorFreeze === undefined ? {} : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
    });
    return handled.status === "auto_requeued"
      ? { status: "ran", workflowRunId: handled.workflowRunId, workflowStatus: "queued" }
      : { status: "failed", workflowRunId: handled.workflowRunId, errorMessage: handled.errorMessage };
  }
}

async function runQueuedType3Movie(input: {
  request: Parameters<typeof runQueuedType3Monitoring>[0];
  claimed: PersistedWorkflowRunSnapshot;
  deps: ResolvedWorkerDependencies;
  userTriggered: boolean;
  now: () => string;
}): Promise<WorkflowStatus> {
  const result = await runMovieAcquisitionV2AndPersist({
    title: input.claimed.title,
    categoryParentId: requireCategoryParent(input.deps.moviesParentDirectoryId),
    resourceProvider: input.deps.resourceProvider,
    storage: input.deps.storage,
    model: input.deps.model,
    repository: input.request.repository,
    accountId: input.claimed.accountId,
    connectedStorageId: input.claimed.connectedStorageId,
    ...type3RunnerOptions(input.deps),
    workflowRun: {
      id: input.claimed.workflowRun.id,
      startedAt: input.claimed.workflowRun.startedAt,
      finishedAt: null,
    },
    workflowKind: "type3_monitor",
    ...(input.userTriggered ? { notice: { trigger: "user" as const, routineIfNothingReplaced: false } } : {}),
    now: input.now,
  });
  return result.status;
}

type QueuedType3SyncInput = {
  request: Parameters<typeof runQueuedType3Monitoring>[0];
  claimed: PersistedWorkflowRunSnapshot;
  userTriggered: boolean;
};

async function syncManualType3Season(input: QueuedType3SyncInput): Promise<{ season: TrackedSeason; episodes: EpisodeState[] }> {
  const { season, episodes } = input.claimed;
  const sync = input.request.syncSeasonMetadata;
  if (!sync) {
    if (hasIncompleteEpisodeStates(season, episodes)) throw new Error("逐集状态不完整，无法同步元数据；请检查 TMDB 配置。");
    return { season, episodes };
  }
  const meta = await sync({ tmdbId: input.claimed.title.tmdbId, seasonNumber: season.seasonNumber, accountId: input.claimed.accountId });
  if (!meta || !Number.isInteger(meta.totalEpisodes) || meta.totalEpisodes <= 0 || meta.totalEpisodes > 10000 ||
      !Number.isInteger(meta.latestAiredEpisode) || meta.latestAiredEpisode < 0 || meta.latestAiredEpisode > meta.totalEpisodes) {
    throw new Error("季度元数据不可用或不完整，请稍后重试。");
  }
  const state = await input.request.repository.syncTrackedSeasonForManualSearch({
    workflowRunId: input.claimed.workflowRun.id, trackedSeasonId: season.id,
    accountId: input.claimed.accountId, connectedStorageId: input.claimed.connectedStorageId,
    totalEpisodes: meta.totalEpisodes, latestAiredEpisode: meta.latestAiredEpisode,
    expectedTotalEpisodes: season.totalEpisodes, expectedLatestAiredEpisode: season.latestAiredEpisode,
  });
  if (!state) throw new Error("补搜任务已取消或订阅已移除。");
  return { season: state.season, episodes: state.episodes };
}

async function syncQueuedType3Season(input: QueuedType3SyncInput): Promise<{ season: TrackedSeason; episodes: EpisodeState[] }> {
  if (input.userTriggered) return syncManualType3Season(input);
  let season = input.claimed.season;
  let episodes = input.claimed.episodes;
  if (!input.request.syncSeasonMetadata) return { season, episodes };

  try {
    const meta = await input.request.syncSeasonMetadata({
      tmdbId: input.claimed.title.tmdbId,
      seasonNumber: season.seasonNumber,
      accountId: input.claimed.accountId,
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
  } catch (error) {
    console.warn(
      `[manual-search] metadata sync failed tmdbId=${input.claimed.title.tmdbId} season=${season.seasonNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { season, episodes };
}

type QueuedType3SeasonInput = {
  request: Parameters<typeof runQueuedType3Monitoring>[0];
  claimed: PersistedWorkflowRunSnapshot;
  deps: ResolvedWorkerDependencies;
  userTriggered: boolean;
  now: () => string;
};

async function readCurrentManualSeason(input: QueuedType3SeasonInput, season: TrackedSeason): Promise<{ season: TrackedSeason; episodes: EpisodeState[] }> {
  const scope = { accountId: input.claimed.accountId, connectedStorageId: input.claimed.connectedStorageId };
  const run = await input.request.repository.getWorkflowRunSnapshot(input.claimed.workflowRun.id, scope);
  const current = await input.request.repository.getTrackedSeasonState(season.id, scope);
  if (!run || run.workflowRun.status !== "running" || !current ||
      current.connectedStorageId !== input.claimed.connectedStorageId || current.accountId !== input.claimed.accountId) {
    throw new Error("补搜任务已取消或订阅已移除。");
  }
  if (hasIncompleteEpisodeStates(current.season, current.episodes)) throw new Error("逐集状态同步不完整，请稍后重试。");
  if (current.episodes.some((episode) => !episode.obtained && episode.airStatus === "unknown")) {
    throw new Error("仍有集数播出状态未知，请稍后重试。");
  }
  return current;
}

async function finishManualIfNoMissing(input: QueuedType3SeasonInput, season: TrackedSeason, episodes: EpisodeState[]): Promise<boolean> {
  if (episodes.some((episode) => episode.airStatus === "aired" && !episode.obtained)) return false;
  await input.request.repository.saveWorkflowRunSnapshot({ ...input.claimed, season, episodes,
    workflowRun: { ...input.claimed.workflowRun, status: "succeeded", finishedAt: input.now(),
      progress: { activity: "同步完成，没有待搜索的已播缺集", phase: "finalize", percent: 100, updatedAt: input.now() },
      auditEvents: [...input.claimed.workflowRun.auditEvents, { type: "manual_subscription_no_missing", message: "同步后没有待搜索的已播缺集。" }] },
    keepCurrentEpisodes: true, requireTrackedSeason: true, requireRunningWorkflowRun: true, requireNoMissingEpisodes: true });
  const final = await input.request.repository.getWorkflowRunSnapshot(input.claimed.workflowRun.id, {
    accountId: input.claimed.accountId, connectedStorageId: input.claimed.connectedStorageId,
  });
  if (!final || final.workflowRun.status !== "succeeded") throw new Error("集数状态已变化或任务已取消，请重新补搜。");
  return true;
}

async function runQueuedType3Season(input: QueuedType3SeasonInput): Promise<WorkflowStatus> {
  if (input.userTriggered) {
    await input.request.repository.updateWorkflowRunProgress(input.claimed.workflowRun.id, {
      activity: "正在同步季度集数状态", phase: "search", percent: 0, updatedAt: input.now(),
    });
  }
  let { season, episodes } = await syncQueuedType3Season(input);
  if (input.userTriggered) {
    ({ season, episodes } = await readCurrentManualSeason(input, season));
    if (await finishManualIfNoMissing(input, season, episodes)) return "succeeded";
  }
  const result = await runType3MonitoringV2AndPersist({
    title: input.claimed.title,
    season,
    episodes,
    categoryParentId: requireCategoryParent(
      storageParentForTitle(
        input.claimed.title,
        input.deps.storageParentDirectoryId,
        input.deps.animeStorageParentDirectoryId,
      ),
    ),
    resourceProvider: input.deps.resourceProvider,
    storage: input.deps.storage,
    model: input.deps.model,
    repository: input.request.repository,
    accountId: input.claimed.accountId,
    connectedStorageId: input.claimed.connectedStorageId,
    ...type3RunnerOptions(input.deps),
    ...(input.userTriggered ? { notificationTrigger: "user" as const } : {}),
    workflowRun: {
      id: input.claimed.workflowRun.id,
      startedAt: input.claimed.workflowRun.startedAt,
      finishedAt: null,
    },
    now: input.now,
  });
  if (result.newlyObtainedCodes.length > 0) {
    const takenAt = await input.request.repository.recordPolicyMatch({
      accountId: input.claimed.accountId,
      titleKey: input.claimed.title.id,
      now: input.now(),
    });
    if (takenAt !== null) {
      console.log(`[manual-search] cooldown watermark for ${input.claimed.title.title} moved to ${takenAt}`);
    }
  }
  return result.status;
}

/** One tracked state's patrol; null when there is nothing to do for it. */
async function patrolTrackedState(args: {
  input: ScheduledType3Input;
  state: Awaited<ReturnType<WorkflowRepository["listAllTrackedSeasonStates"]>>[number];
  now: () => string;
}): Promise<ScheduledType3Outcome | null> {
  const { input, state, now } = args;
  {
    const deps = await resolveWorkerDeps(
      input.resolveAccountContext,
      state.accountId,
      state.connectedStorageId,
      input,
    );
    // Patrol dispatches by title.type: a film needs the MOVIE agent, not the
    // TV/anime agent (different semantics). (未上映/reserved films aren't tracked
    // yet; the air-time gate lands with that product state.)
    if (state.title.type === "movie") {
      return (await patrolMovie({ input, deps, state, now })) ?? null;
    }

    if (state.season.status !== "active" || state.episodes.length === 0) {
      return null;
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
          accountId: state.accountId,
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
      } catch (error) {
        console.warn(
          `[patrol] metadata sync failed tmdbId=${state.title.tmdbId} season=${state.season.seasonNumber}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const workflowRunId = input.createWorkflowRunId?.() ?? crypto.randomUUID();
    const startedAt = now();
    const staleActiveRunStartedBefore = staleStartedBefore(
      startedAt,
      input.staleActiveRunTimeoutMs,
    );

    if (input.mayStartRun && !input.mayStartRun()) {
      return { trackedSeasonId: season.id, status: "skipped_active" };
    }
    const reservation = await input.repository.reserveWorkflowRun({
      accountId: state.accountId,
      connectedStorageId: state.connectedStorageId,
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
      // Patrols run outside the queue drain. A replace, or a leftover recovery the
      // drain can claim mid-patrol, moves files in the same directories. The
      // janitor will not queue a recovery while this patrol is active, so the
      // exclusion holds both ways.
      blockIfTitleHasActiveKinds: ["replace_request", "staging_recovery"],
      // The state was read when the sweep started (then the drive's deps, a TMDB sync):
      // a season untracked since must not be tracked again by this reservation.
      requireTrackedSeason: true,
      ...(staleActiveRunStartedBefore === null
        ? {}
        : { staleActiveRunStartedBefore, staleFinishedAt: startedAt }),
    });
    if (reservation.status === "not_tracked") {
      return { trackedSeasonId: season.id, status: "skipped_untracked" };
    }
    if (reservation.status !== "reserved") {
      return { trackedSeasonId: season.id, status: "skipped_active" };
    }

    const runOnce = () =>
      runType3MonitoringV2AndPersist({
        title: state.title,
        season,
        episodes,
        categoryParentId: requireCategoryParent(
          storageParentForTitle(
            state.title,
            deps.storageParentDirectoryId,
            deps.animeStorageParentDirectoryId,
          ),
        ),
        resourceProvider: deps.resourceProvider,
        storage: deps.storage,
        model: deps.model,
        repository: input.repository,
        accountId: state.accountId,
        connectedStorageId: state.connectedStorageId,
        ...(deps.preferredLanguage === undefined
          ? {}
          : { preferredLanguage: deps.preferredLanguage }),
        ...(deps.qualityPreference === undefined
          ? {}
          : { qualityPreference: deps.qualityPreference }),
        ...(deps.storageProvider === undefined
          ? {}
          : { storageProvider: deps.storageProvider }),
        ...(deps.assrtToken === undefined
          ? {}
          : { assrtToken: deps.assrtToken }),
        ...(deps.jevJudge === undefined
          ? {}
          : { jevJudge: deps.jevJudge }),
        ...(deps.agentMemory === undefined
          ? {}
          : { agentMemory: deps.agentMemory }),
          // Web-reference tools, same per-account resolution as memory.
          ...(deps.titleResearch === undefined
            ? {}
            : { titleResearch: deps.titleResearch }),
        workflowRun: { id: workflowRunId, startedAt, finishedAt: null },
        now,
      });

    try {
      let result;
      try {
        result = await runOnce();
      } catch (firstError) {
        if (
          !isTransientForRun(firstError, deps.llmConfig) ||
          stagingFailureAuditEvents(firstError).length > 0 ||
          hasTransferAttemptedOnThrow(firstError)
        ) {
          throw firstError;
        }
        result = await runOnce();
      }
      // 批次 5 冷却期水位线：只在这一次真的采纳了资源时才往前走。
      //
      // 为什么不能按“跑完了”记：一次搜了但没命中的巡检（no_coverage）如果也移动水位线，就会不停重置冷却，
      // 那部作品会每次巡检都被重搜——而冷却存在的意义就是避免这份成本。
      // 也不能按“成功—开始跑”记：则早在预约阶段就记上了，而那时还没搜过。
      if (result.newlyObtainedCodes.length > 0) {
        const takenAt = await input.repository.recordPolicyMatch({
          accountId: state.accountId,
          titleKey: state.title.id,
          now: now(),
        });
        // null = 这部作品没配策略，正常（策略层是 opt-in 的）。
        if (takenAt !== null) {
          console.log(`[patrol] cooldown watermark for ${state.title.title} moved to ${takenAt}`);
        }
      }
      return {
        trackedSeasonId: state.season.id,
        status: "ran",
        workflowRunId,
        workflowStatus: result.status,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Workflow failed";
      console.log(
        `[workflow] run ${workflowRunId} type3_monitor failed` +
          ` (storage ${state.connectedStorageId ?? "-"}): ${summarizeErrorForNotification(errorMessage)}`,
      );
      await input.repository.saveWorkflowRunSnapshot({
        accountId: state.accountId,
        connectedStorageId: state.connectedStorageId,
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
            {
              type: "type3_scheduled",
              message: "Scheduled Type 3 monitoring reserved",
            },
            ...stagingFailureAuditEvents(error),
            { type: "workflow_failed", message: errorMessage },
          ],
        },
        episodes: state.episodes,
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
      await maybeFreezeOnBrandAuthError({
        connectedStorageId: state.connectedStorageId,
        error,
        ...(input.onAuthErrorFreeze === undefined
          ? {}
          : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
      });
      return {
        trackedSeasonId: state.season.id,
        status: "failed",
        workflowRunId,
        errorMessage,
      };
    }
  }
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
    onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
    mayStartRun?: MayStartRun;
  };
  deps: {
    resourceProvider: ResourceProvider;
    storage: StorageExecutor;
    model: LanguageModel;
    llmConfig: { baseURL?: string; modelId?: string } | undefined;
    preferredLanguage: string | undefined;
    qualityPreference: "high" | "medium" | undefined;
    storageProvider: string | undefined;
    assrtToken: string | undefined;
    jevJudge: JevJudge | undefined;
    agentMemory: boolean | undefined;
    titleResearch: TitleResearchOptions | undefined;
    moviesParentDirectoryId: string | undefined;
  };
  state: {
    accountId: string;
    connectedStorageId: string | null;
    title: MediaTitle;
    season: TrackedSeason;
    episodes: EpisodeState[];
  };
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
  const staleActiveRunStartedBefore = staleStartedBefore(
    startedAt,
    input.staleActiveRunTimeoutMs,
  );
  if (input.mayStartRun && !input.mayStartRun()) {
    return { trackedSeasonId: state.season.id, status: "skipped_active" };
  }
  const reservation = await input.repository.reserveWorkflowRun({
    accountId: state.accountId,
    connectedStorageId: state.connectedStorageId,
    title: state.title,
    season: state.season,
    workflowRun: {
      id: workflowRunId,
      kind: "movie_init",
      status: "running",
      trackedSeasonId: state.season.id,
      startedAt,
      finishedAt: null,
      auditEvents: [
        {
          type: "movie_patrol_scheduled",
          message: "Scheduled movie patrol reserved",
        },
      ],
    },
    episodes: state.episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    // Same as the TV patrol: a replace or a leftover recovery queued after the filter.
    blockIfTitleHasActiveKinds: ["replace_request", "staging_recovery"],
    // …and an untrack after the sweep read the film.
    requireTrackedSeason: true,
    ...(staleActiveRunStartedBefore === null
      ? {}
      : { staleActiveRunStartedBefore, staleFinishedAt: startedAt }),
  });
  if (reservation.status === "not_tracked") {
    return { trackedSeasonId: state.season.id, status: "skipped_untracked" };
  }
  if (reservation.status !== "reserved") {
    return { trackedSeasonId: state.season.id, status: "skipped_active" };
  }

  const runOnce = () =>
    runMovieAcquisitionV2AndPersist({
      title: state.title,
      categoryParentId: moviesParent,
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository: input.repository,
      accountId: state.accountId,
      connectedStorageId: state.connectedStorageId,
      ...(deps.preferredLanguage === undefined
        ? {}
        : { preferredLanguage: deps.preferredLanguage }),
      ...(deps.qualityPreference === undefined
        ? {}
        : { qualityPreference: deps.qualityPreference }),
      ...(deps.storageProvider === undefined
        ? {}
        : { storageProvider: deps.storageProvider }),
      ...(deps.assrtToken === undefined
        ? {}
        : { assrtToken: deps.assrtToken }),
      ...(deps.jevJudge === undefined
        ? {}
        : { jevJudge: deps.jevJudge }),
      ...(deps.agentMemory === undefined
        ? {}
        : { agentMemory: deps.agentMemory }),
        // Web-reference tools, same per-account resolution as memory.
        ...(deps.titleResearch === undefined
          ? {}
          : { titleResearch: deps.titleResearch }),
      // Reported in the sweep's daily digest, like the shows, not pushed on its own.
      notice: { trigger: "scheduled", routineIfNothingReplaced: false },
      workflowRun: { id: workflowRunId, startedAt, finishedAt: null },
      now,
    });

  try {
    let result;
    try {
      result = await runOnce();
    } catch (firstError) {
      if (
        !isTransientForRun(firstError, deps.llmConfig) ||
        stagingFailureAuditEvents(firstError).length > 0 ||
        hasTransferAttemptedOnThrow(firstError)
      ) {
        throw firstError;
      }
      result = await runOnce();
    }
    return {
      trackedSeasonId: state.season.id,
      status: "ran",
      workflowRunId,
      workflowStatus: result.status,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Workflow failed";
    console.log(
      `[workflow] run ${workflowRunId} movie_init failed` +
        ` (storage ${state.connectedStorageId ?? "-"}): ${summarizeErrorForNotification(errorMessage)}`,
    );
    await input.repository.saveWorkflowRunSnapshot({
      accountId: state.accountId,
      connectedStorageId: state.connectedStorageId,
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
          {
            type: "movie_patrol_scheduled",
            message: "Scheduled movie patrol reserved",
          },
          ...stagingFailureAuditEvents(error),
          { type: "workflow_failed", message: errorMessage },
        ],
      },
      episodes: state.episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    await maybeFreezeOnBrandAuthError({
      connectedStorageId: state.connectedStorageId,
      error,
      ...(input.onAuthErrorFreeze === undefined
        ? {}
        : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
    });
    return {
      trackedSeasonId: state.season.id,
      status: "failed",
      workflowRunId,
      errorMessage,
    };
  }
}

/**
 * The V2 directory lifecycle must verify-or-create the library category parent
 * (Movies/TV/Anime); a missing parent is a misconfiguration, not a silent
 * account-root fallback (fail loud — see acquisition-hard-details).
 */
export function requireCategoryParent(parent: string | undefined): string {
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
  /** Config that built `model` (failure-copy only — see AccountWorkerContext.llmConfig). */
  llmConfig?: { baseURL?: string; modelId?: string };
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  /** Web-reference tools for the agent (see TitleResearchOptions). */
  titleResearch?: TitleResearchOptions;
  moviesParentDirectoryId: string;
  now?: () => string;
  /** §7: resolve the claimed run's per-account 115 creds + landing CIDs. */
  resolveAccountContext?: ResolveAccountWorkerContext;
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  mayStartRun?: MayStartRun;
  /** The worker's drive filter and claim callback when queued runs go side by side. */
  claim?: QueueClaimOptions;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.mayStartRun && !input.mayStartRun()) {
    return { status: "idle" };
  }
  const claimed = await claimNextQueuedRun(input.repository, "movie_init", now(), input.claim);
  if (!claimed) {
    return { status: "idle" };
  }
  // As in runQueuedType2Workflow: the config of the model this run ended up using.
  let resolvedLlmConfig: { baseURL?: string; modelId?: string } | undefined;
  // Inside the try: a throw here (drive gone, settings cleared, a DB blip) must end the
  // claimed run through the failure handler, not leave it "running".
  try {
    const deps = await resolveWorkerDeps(
      input.resolveAccountContext,
      claimed.accountId,
      claimed.connectedStorageId,
      input,
    );
    resolvedLlmConfig = deps.llmConfig;
    const result = await runMovieAcquisitionV2AndPersist({
      title: claimed.title,
      categoryParentId:
        deps.moviesParentDirectoryId ?? input.moviesParentDirectoryId,
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository: input.repository,
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      ...(deps.preferredLanguage === undefined
        ? {}
        : { preferredLanguage: deps.preferredLanguage }),
      ...(deps.qualityPreference === undefined
        ? {}
        : { qualityPreference: deps.qualityPreference }),
      ...(deps.storageProvider === undefined
        ? {}
        : { storageProvider: deps.storageProvider }),
      ...(deps.assrtToken === undefined
        ? {}
        : { assrtToken: deps.assrtToken }),
      ...(deps.jevJudge === undefined
        ? {}
        : { jevJudge: deps.jevJudge }),
      ...(deps.agentMemory === undefined
        ? {}
        : { agentMemory: deps.agentMemory }),
        // Web-reference tools, same per-account resolution as memory.
        ...(deps.titleResearch === undefined
          ? {}
          : { titleResearch: deps.titleResearch }),
      workflowRun: {
        id: claimed.workflowRun.id,
        startedAt: claimed.workflowRun.startedAt,
        finishedAt: null,
      },
      now,
    });

    await triggerPostIngestSyncIfSucceeded(result.status, {
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      repository: input.repository,
      storage: deps.storage,
      title: claimed.title,
      categoryParentId: deps.moviesParentDirectoryId ?? input.moviesParentDirectoryId ?? "",
      baseUrl: deps.baseUrl,
      mediaServerCoordinator: deps.mediaServerCoordinator,
    });
    return {
      status: "ran",
      workflowRunId: claimed.workflowRun.id,
      workflowStatus: result.status,
    };
  } catch (error) {
    const handled = await handleWorkflowRunFailure({
      claimed,
      error,
      repository: input.repository,
      now,
      ...(resolvedLlmConfig === undefined ? {} : { llmConfig: resolvedLlmConfig }),
      ...(input.onAuthErrorFreeze === undefined
        ? {}
        : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
    });
    return handled.status === "auto_requeued"
      ? { status: "ran", workflowRunId: handled.workflowRunId, workflowStatus: "queued" }
      : { status: "failed", workflowRunId: handled.workflowRunId, errorMessage: handled.errorMessage };
  }
}

export async function runQueuedSeriesInitialization(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  /** Config that built `model` (failure-copy only — see AccountWorkerContext.llmConfig). */
  llmConfig?: { baseURL?: string; modelId?: string };
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  /** Web-reference tools for the agent (see TitleResearchOptions). */
  titleResearch?: TitleResearchOptions;
  storageParentDirectoryId: string;
  /** Separate landing parent for anime, so the 动漫 shelf is physically its own
   *  tree on 115 and never mixed into the TV shows directory. */
  animeStorageParentDirectoryId?: string;
  now?: () => string;
  /** §7: resolve the claimed run's per-account 115 creds + landing CIDs. */
  resolveAccountContext?: ResolveAccountWorkerContext;
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  mayStartRun?: MayStartRun;
  /** The worker's drive filter and claim callback when queued runs go side by side. */
  claim?: QueueClaimOptions;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.mayStartRun && !input.mayStartRun()) {
    return { status: "idle" };
  }
  const claimed = await claimNextQueuedRun(input.repository, "type1_package_init", now(), input.claim);
  if (!claimed) {
    return { status: "idle" };
  }
  const queuedEvent = claimed.workflowRun.auditEvents.find(
    (event) => event.type === "series_init_queued",
  );
  const seasons = (queuedEvent?.data?.["seasons"] ??
    []) as AcquisitionSeasonScope[];

  // As in runQueuedType2Workflow: the config of the model this run ended up using.
  let resolvedLlmConfig: { baseURL?: string; modelId?: string } | undefined;
  // Inside the try, as in the other queued runners.
  try {
    const deps = await resolveWorkerDeps(
      input.resolveAccountContext,
      claimed.accountId,
      claimed.connectedStorageId,
      input,
    );
    resolvedLlmConfig = deps.llmConfig;
    if (seasons.length === 0) {
      throw new Error(
        "Queued series initialization run is missing its season metadata",
      );
    }
    const categoryParentId = requireCategoryParent(
      storageParentForTitle(
        claimed.title,
        deps.storageParentDirectoryId,
        deps.animeStorageParentDirectoryId,
      ),
    );
    const result = await runSeriesInitializationV2AndPersist({
      title: claimed.title,
      seasons,
      categoryParentId,
      seasonQualityRecord: claimed.season.qualityPreference,
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository: input.repository,
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      ...(deps.preferredLanguage === undefined
        ? {}
        : { preferredLanguage: deps.preferredLanguage }),
      ...(deps.qualityPreference === undefined
        ? {}
        : { qualityPreference: deps.qualityPreference }),
      ...(deps.storageProvider === undefined
        ? {}
        : { storageProvider: deps.storageProvider }),
      ...(deps.assrtToken === undefined
        ? {}
        : { assrtToken: deps.assrtToken }),
      ...(deps.jevJudge === undefined
        ? {}
        : { jevJudge: deps.jevJudge }),
      ...(deps.agentMemory === undefined
        ? {}
        : { agentMemory: deps.agentMemory }),
        // Web-reference tools, same per-account resolution as memory.
        ...(deps.titleResearch === undefined
          ? {}
          : { titleResearch: deps.titleResearch }),
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
      connectedStorageId: claimed.connectedStorageId,
      title: claimed.title,
      season: firstSeason?.season ?? claimed.season,
      workflowRun: {
        ...claimed.workflowRun,
        status: result.status,
        finishedAt: now(),
        auditEvents: [
          ...claimed.workflowRun.auditEvents,
          ...result.auditEvents,
        ],
      },
      episodes: firstSeason?.episodes ?? [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    await triggerPostIngestSyncIfSucceeded(result.status, {
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      repository: input.repository,
      storage: deps.storage,
      title: claimed.title,
      categoryParentId,
      baseUrl: deps.baseUrl,
      mediaServerCoordinator: deps.mediaServerCoordinator,
    });

    return {
      status: "ran",
      workflowRunId: claimed.workflowRun.id,
      workflowStatus: result.status,
    };
  } catch (error) {
    const handled = await handleWorkflowRunFailure({
      claimed,
      error,
      repository: input.repository,
      now,
      ...(resolvedLlmConfig === undefined ? {} : { llmConfig: resolvedLlmConfig }),
      ...(input.onAuthErrorFreeze === undefined
        ? {}
        : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
    });
    return handled.status === "auto_requeued"
      ? { status: "ran", workflowRunId: handled.workflowRunId, workflowStatus: "queued" }
      : { status: "failed", workflowRunId: handled.workflowRunId, errorMessage: handled.errorMessage };
  }
}

import {
  DEFAULT_ACCOUNT_ID,
} from "@media-track/contracts";
import {
  type WorkflowRepository,
  type ResolveAccountWorkerContext,
  type QueueClaimOptions,
  type ResourceProvider,
  type StorageExecutor,
  type StagingJanitorDrive,
  type SeasonMetadataSync,
  type NotificationEvent,
  type StorageProvider,
  type MediaTitle,
  type VerifiedFile,
  CompositeResourceProvider,
  HaisouResourceProvider,
  PanSouResourceProvider,
  ProwlarrResourceProvider,
  createProtectedPan115CookieStorageExecutorFromEnv,
  createBootstrapPan115CookieStorageExecutor,
  createExecutorForBrand,
  buildBootstrapExecutorForBrand,
  getStorageBrand,
  isRegisteredStorageProvider,
  allowedResourceTypesForKinds,
  type ResourceType,
  runQueuedManualImport,
  runQueuedMovieAcquisition,
  runQueuedReplaceRequest,
  runQueuedStagingRecovery,
  runQueuedSeriesInitialization,
  runQueuedType2Workflow,
  enqueueUrgentReplaceRequests,
  runScheduledType3Monitoring,
  sweepOrphanStagingDirs,
  sendPushNotifications,
  resolveDriveSourceLabels,
  scheduledDigestItems,
  isRunOrItsSeasonRecord,
  FINISHED_RUN_RETENTION_MS,
  FakeResourceProvider,
  FakeStorageExecutor,
  episodeCode,
  formatDailyDigestPushText,
  prepareTrackingTarget,
  createTmdbMetadataProvider,
} from "@media-track/workflow";
import {
  getCurrentAccountId,
  getWorkflowRepository,
  hydratePan115CookieFromDb,
  isPan115CookieHydrated,
  setPan115CookieHydrated,
} from "../../../composition/runtime-container";
import {
  getAccountStorageCredentials,
  resolveQueueStorage,
  frozenDriveMessage,
  STORAGE_PROBES,
  makeTokenPersister,
  defaultDriveIdOf,
  freezeConnectedStorage,
  testConnection,
  workerHasConfiguredDrive,
  getAccountDriveFileManager,
  customDirNamesFromEnv,
} from "../../storage-drives";
import {
  getAccountScopedSettings,
  UpdateInProgressError,
  isUpdateInProgress,
} from "../../settings-system/application/system-settings-service";
import { runStartupMigrations } from "../../settings-system/application/system-settings-service";
import { seedDemoWorkflowRepository } from "../../../lib/demo-workflow";
import type { ForeignWorkFinding, ForeignWorkReview } from "../../catalog/contracts/catalog-types";
import {
  ASSRT_TOKEN_SETTING_KEY,
  AUTO_UPDATE_ENABLED_SETTING_KEY,
  AUTO_UPDATE_FAIL_STREAK_SETTING_KEY,
  AUTO_UPDATE_TIME_SETTING_KEY,
  beijingDateTime,
  getAgentModel,
  getAssrtToken,
  getAutoUpdateTime,
  getDailySweepTimes,
  getHaisouApiKey,
  getPatrolConcurrency,
  getPreferredLanguage,
  getProwlarrConfig,
  getQualityPreference,
  getTmdbAccesses,
  isAutoUpdateEnabled,
  JEV_BASE_URL_SETTING_KEY,
  LAST_SWEEP_CLAIMS_SETTING_KEY,
  LAST_SWEEP_COMPLETED_AT_SETTING_KEY,
  LLM_API_KEY_SETTING_KEY,
  LLM_BASE_URL_SETTING_KEY,
  LLM_MODEL_ID_SETTING_KEY,
  MAX_DAILY_SWEEP_TIMES,
  MAX_PATROL_CONCURRENCY,
  PANSOU_BASE_URL_SETTING_KEY,
  PANSOU_HEALTH_SETTING_KEY,
  parseAutoUpdateFailStreak,
  PATROL_CONCURRENCY_SETTING_KEY,
  PREFERRED_LANGUAGE_SETTING_KEY,
  PROWLARR_API_KEY_SETTING_KEY,
  PROWLARR_BASE_URL_SETTING_KEY,
  QUALITY_PREFERENCE_SETTING_KEY,
  readSweepClaims,
  resolveAgentModelConfig,
  resolveJevJudge,
  resolveTitleResearchOptions,
  TMDB_API_KEY_SETTING_KEY,
} from "../../../lib/runtime/settings-readers";
import { isDemoMode } from "../../../lib/demo-mode";
import { isAgentMemoryEnabled } from "../../../lib/agent-memory-server";
import { isUpdateHoldActive, whileInFlight } from "../../../lib/update-hold";
import { resolveIsDesktop } from "../../../lib/desktop-flag";
import { isLiveSearch } from "../../../lib/search-provider";
import {
  DEFAULT_PANSOU_BASE_URL,
  normalizePanSouBaseUrl,
  buildPanSouProviderChain,
  resolveUserPanSouBaseUrl,
  getPanSouAuth,
} from "../core/pansou-chain";

export function defaultQuality(): string {
  return "4K";
}

let fakeResourceProvider: ResourceProvider | null = null;
let fakeStorageExecutor: StorageExecutor | null = null;
const mayStartRun = () => !isUpdateHoldActive(Date.now());

export async function recoverOrphanedRuns(): Promise<number> {
  return getWorkflowRepository().requeueRunningWorkflowRuns();
}

/**
 * §7 P0 startup migration (idempotent): move a pre-multi-account deployment's
 * single global 115 cookie into a `connected_storages` row owned by the implicit
 * default account, with CIDs from the env the worker used to read. Single-user
 * deployments see no behavior change — the worker resolves the same cookie, just
 * from the per-account connection record. Best-effort; logged, never throws.
 */
export { runStartupMigrations };

/**
 * §7 form B: resolve the per-account worker context for a CLAIMED run. The worker
 * drains a cross-account queue; for each run it calls this with the run's owner so
 * the acquisition transfers to THAT account's 115 (cookie + landing CIDs), not a
 * shared one. model/resourceProvider/language stay global (shared author LLM/
 * PanSou) for v1 — per-account LLM/Prowlarr is a later refinement.
 */
export function buildAccountContextResolver(): ResolveAccountWorkerContext {
  return async (accountId: string, connectedStorageId?: string | null) => {
    // Per-account settings (account_settings → global → env) drive the agent
    // model, resource providers, language and quality — so each user's
    // acquisition searches with THEIR config (operator's global/env is the
    // shared fallback when an account hasn't set its own). The 115 storage +
    // landing CIDs are resolved per (account, storage) so the run lands on the
    // specific drive it was queued onto.
    const scoped = getAccountScopedSettings(accountId);
    const creds = await getAccountStorageCredentials(accountId, connectedStorageId);
    const parents = await getWorkerStorageParents(accountId, connectedStorageId, creds);
    const driveProvider = creds?.provider ?? "pan115";
    const [
      { model, llmConfig, preferredLanguage, qualityPreference },
      assrtToken,
      titleResearch,
      jevJudge,
      agentMemory,
      storage,
      resourceProvider,
    ] = await Promise.all([
      getAgentModel(scoped),
      getAssrtToken(scoped),
      resolveTitleResearchOptions(scoped),
      resolveJevJudge(scoped),
      isAgentMemoryEnabled(getWorkflowRepository(), accountId).catch((error: unknown) => {
        console.log(
          `[memory] agent_memory_enabled read failed (defaulting on): ${error instanceof Error ? error.message : String(error)}`,
        );
        return true;
      }),
      getWorkerStorageExecutor(accountId, connectedStorageId, creds),
      getWorkerResourceProvider(scoped, driveProvider, accountId),
    ]);
    return {
      storage,
      resourceProvider,
      storageProvider: driveProvider,
      model,
      // The worker uses this ONLY to pick the free-preset failure copy for THIS
      // account's acquisitions (isFreeLlmPreset) — multi-user accounts each get
      // their own Kilo/BYO verdict.
      llmConfig,
      ...(assrtToken === undefined ? {} : { assrtToken }),
      titleResearch,
      ...(jevJudge === undefined ? {} : { jevJudge }),
      agentMemory,
      ...(preferredLanguage === undefined ? {} : { preferredLanguage }),
      ...(qualityPreference === undefined ? {} : { qualityPreference }),
      storageParentDirectoryId: parents.tv,
      animeStorageParentDirectoryId: parents.anime,
      moviesParentDirectoryId: parents.movies,
    };
  };
}

/** 记录自建搜索源的最新健康结论,供设置页徽章读取(它每 8s 轮询,不能自己打网络)。
 *  幂等:值未变化就不写,避免每次搜索都产生一次 DB 写。 */
//  ⚠️ 必须按账号分键:多用户模式下一个进程服务多个账号,不分键会让账号 B 的
//  结论因为账号 A 刚写过同一个值而被跳过 —— 于是 B 的源挂了却永远不告警,
//  正是本 PR 要消灭的那种静默。
const lastRecordedPanSouHealth = new Map<string, string>();
async function recordPanSouHealth(healthy: boolean, accountId?: string): Promise<void> {
  const value = healthy ? "ok" : "unhealthy";
  try {
    // 有 request scope(设置页/HTTP)时用请求账号;worker 路径没有 request scope,
    // 必须用调用方传入的 run 所属账号 —— 否则多用户模式下所有健康结论都记到
    // acct_default 名下,B 用户永远看不到「自建源连不上」的告警。
    const resolved = accountId ?? (await getCurrentAccountId());
    if (lastRecordedPanSouHealth.get(resolved) === value) return;
    await getWorkflowRepository().setAccountSetting(
      resolved,
      PANSOU_HEALTH_SETTING_KEY,
      value,
    );
    lastRecordedPanSouHealth.set(resolved, value);
  } catch (error) {
    // 搜索不能因为一次设置写失败而失败。但不静默:打出来,否则就是本 PR 要修的病。
    console.warn(
      `[pansou-health] 记录健康态失败(不影响本次搜索): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Test-only: 清掉幂等缓存,免得跨用例串味。 */

/** Claim and run the next queued run. The in-process worker passes `claim` (its drive
 *  filter and claim callback) so several runs can go at once, never two on one drive;
 *  without it the oldest claimable run is taken, as before. */
export async function runNextQueuedWorkflow(claim?: QueueClaimOptions) {
  // An update is about to replace this process: start nothing new. Queued runs stay
  // queued and run on the new version.
  if (isUpdateHoldActive(Date.now())) {
    return { status: "idle" as const };
  }
  // In flight for the updater's busy check, from here to the claim it guards.
  return whileInFlight(() => runNextQueuedWorkflowNow(claim));
}

async function runNextQueuedWorkflowNow(claim: QueueClaimOptions | undefined) {
  const repository = getWorkflowRepository();
  // §7 form B: the worker resolves each CLAIMED run's account credentials via
  // resolveAccountContext (claim-first), so bob's acquisition lands in bob's 115.
  // The base deps below are the default account's, used as the fallback the
  // resolver overrides per run.
  const accountId = DEFAULT_ACCOUNT_ID;
  await hydratePan115CookieFromDb();
  // The user's language preference is standing context baked into the agent
  // instance (one global preference), so every workflow — movie, series, type2,
  // anime — searches with it. No per-workflow plumbing.
  const [
    { model, llmConfig, preferredLanguage, qualityPreference },
    baseCreds,
    resourceProvider,
  ] = await Promise.all([
    getAgentModel(getAccountScopedSettings(accountId)),
    getAccountStorageCredentials(accountId),
    getWorkerResourceProvider(),
  ]);
  const language = preferredLanguage === undefined ? {} : { preferredLanguage };
  const quality = qualityPreference === undefined ? {} : { qualityPreference };
  const [storage, parents] = await Promise.all([
    getWorkerStorageExecutor(accountId, undefined, baseCreds),
    getWorkerStorageParents(accountId, undefined, baseCreds),
  ]);
  const resolveAccountContext = buildAccountContextResolver();
  const startedAt = new Date().toISOString();
  const onAuthErrorFreeze = (id: string, reason: string) => freezeConnectedStorage(id, reason);
  const claimOption = claim === undefined ? {} : { claim };
  // Urgent user messages ("现在处理", written mid-run, or retry after a failure) get a
  // replace_request as soon as the queue is free — never waiting for the patrol.
  try {
    await enqueueUrgentReplaceRequests({ repository });
  } catch (error) {
    console.error(`[user-message] urgent scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const type2 = await runQueuedType2Workflow({
    repository,
    resourceProvider,
    storage,
    model,
    // Free-tier failure copy (Task 5): lets the worker's failure handler run
    // isFreeLlmPreset on the BASE model config; per-account runs override via
    // resolveAccountContext's llmConfig.
    llmConfig,
    ...language,
    ...quality,
    storageParentDirectoryId: parents.tv,
    animeStorageParentDirectoryId: parents.anime,
    resolveAccountContext,
    onAuthErrorFreeze,
    mayStartRun,
    ...claimOption,
  });
  if (type2.status !== "idle") {
    await pushNotificationsSince(repository, startedAt, { workflowRunId: type2.workflowRunId });
    return type2;
  }
  const series = await runQueuedSeriesInitialization({
    repository,
    resourceProvider,
    storage,
    model,
    // Free-tier failure copy (Task 5): lets the worker's failure handler run
    // isFreeLlmPreset on the BASE model config; per-account runs override via
    // resolveAccountContext's llmConfig.
    llmConfig,
    ...language,
    ...quality,
    storageParentDirectoryId: parents.tv,
    animeStorageParentDirectoryId: parents.anime,
    resolveAccountContext,
    onAuthErrorFreeze,
    mayStartRun,
    ...claimOption,
  });
  if (series.status !== "idle") {
    await pushNotificationsSince(repository, startedAt, { workflowRunId: series.workflowRunId });
    return series;
  }
  const movie = await runQueuedMovieAcquisition({
    repository,
    resourceProvider,
    storage,
    model,
    // Free-tier failure copy (Task 5): lets the worker's failure handler run
    // isFreeLlmPreset on the BASE model config; per-account runs override via
    // resolveAccountContext's llmConfig.
    llmConfig,
    ...language,
    ...quality,
    moviesParentDirectoryId: parents.movies,
    resolveAccountContext,
    onAuthErrorFreeze,
    mayStartRun,
    ...claimOption,
  });
  if (movie.status !== "idle") {
    await pushNotificationsSince(repository, startedAt, { workflowRunId: movie.workflowRunId });
    return movie;
  }
  const replace = await runQueuedReplaceRequest({
    repository,
    resourceProvider,
    storage,
    model,
    // Free-tier failure copy (Task 5): lets the worker's failure handler run
    // isFreeLlmPreset on the BASE model config; per-account runs override via
    // resolveAccountContext's llmConfig.
    llmConfig,
    ...language,
    ...quality,
    storageParentDirectoryId: parents.tv,
    animeStorageParentDirectoryId: parents.anime,
    moviesParentDirectoryId: parents.movies,
    resolveAccountContext,
    onAuthErrorFreeze,
    mayStartRun,
    ...claimOption,
    // A work with 待换 episodes skips the patrol, where TMDB sync normally happens.
    ...syncOption(),
  });
  if (replace.status !== "idle") {
    await pushNotificationsSince(repository, startedAt, { workflowRunId: replace.workflowRunId });
    return replace;
  }
  // Manual import. Placed before the patrol and the staging recovery: the user is
  // waiting on it, and it holds a title lock, so leaving it queued blocks that
  // title's other work. A movie goes under the movie parent; a season under TV/Anime.
  const manualImport = await runQueuedManualImport({
    repository,
    storage,
    categoryParentDirectoryId: parents.tv,
    storageParentDirectoryId: parents.tv,
    animeStorageParentDirectoryId: parents.anime,
    moviesParentDirectoryId: parents.movies,
    resolveAccountContext,
    onAuthErrorFreeze,
    ...claimOption,
  });
  if (manualImport.status !== "idle") {
    return manualImport;
  }
  // Leftover staging heals itself. No notification and no push — llmConfig is
  // still passed so a free-preset 429/5xx transient error triggers auto-requeue
  // instead of terminally failing the recovery run.
  return runQueuedStagingRecovery({
    repository,
    resourceProvider,
    storage,
    model,
    llmConfig,
    ...language,
    ...quality,
    resolveAccountContext,
    onAuthErrorFreeze,
    mayStartRun,
    ...claimOption,
  });
}

/** The in-process worker's limit on queued runs going at once (same setting as the patrol). */
export async function getWorkerConcurrency(): Promise<number> {
  return getPatrolConcurrency(getWorkflowRepository());
}



async function pushNotificationsSince(
  targetRepository: WorkflowRepository,
  sinceIso: string,
  /** The sweep always sends its digest; a queue drain (a patrol-queued replace run)
   *  skips one that would only say nothing changed (see scheduledDigestItems).
   *  `workflowRunId`: push only that run's notifications (its own record or its
   *  per-season ones). A queued run passes its own id, since other runs going beside
   *  it write notifications in the same window and each pushes its own when it finishes. */
  opts: { sweep?: boolean; workflowRunId?: string } = {},
): Promise<void> {
  try {
    // Cross-account: the drain/sweep may have completed runs for several accounts.
    // Each notification is tagged with its owning account so it goes to THAT
    // user's channels (push config resolved per-account: account → global → env).
    // since is applied in the repository BEFORE the limit so a large sweep's
    // earliest notifications are not crowded out by newer already_current noise.
    // Cap is high enough for a full patrol of a large library; still bounded.
    const recent = (
      await targetRepository.listRecentNotificationsWithAccount({
        since: sinceIso,
        limit: 10_000,
      })
    ).filter(
      (entry) =>
        opts.workflowRunId === undefined || isRunOrItsSeasonRecord(entry.notification.workflowRunId, opts.workflowRunId),
    );
    if (recent.length === 0) {
      return;
    }

    type RecentEntry = { connectedStorageId: string | null; notification: NotificationEvent };
    const byAccount = new Map<string, RecentEntry[]>();
    for (const { accountId, connectedStorageId, notification } of recent) {
      const list = byAccount.get(accountId) ?? [];
      list.push({ connectedStorageId, notification });
      byAccount.set(accountId, list);
    }

    for (const [accountId, entries] of byAccount) {
      const settings = getAccountScopedSettings(accountId);
      // Source-drive tags: only when this account has ≥2 drives mounted (else the
      // map is empty and no message carries a source). Resolution is null/unknown
      // safe (legacy run or unbound drive → that entry is simply not tagged).
      const drives = await targetRepository.listConnectedStorages(accountId);
      const sourceLabels = resolveDriveSourceLabels(entries, drives);

      const notifications = entries.map((entry) => entry.notification);
      // A scheduled sweep touches many shows; collapse this account's into ONE
      // digest. User-triggered events stay per-resource — each its own message.
      const scheduled = scheduledDigestItems(notifications, { skipIfOnlyRoutine: opts.sweep !== true });
      const individual = notifications.filter((notification) => notification.trigger !== "scheduled");

      for (const notification of individual) {
        const sourceLabel = sourceLabels.get(notification.id);
        try {
          await sendPushNotifications({ repository: settings, notification, ...(sourceLabel ? { sourceLabel } : {}) });
        } catch (error) {
          console.error(
            `[media-track] push for ${notification.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (scheduled.length > 0) {
        const digest: NotificationEvent = {
          id: `digest_${accountId}_${sinceIso}`,
          workflowRunId: scheduled[0]!.workflowRunId,
          kind: "daily_digest",
          title: "每日巡检",
          body: formatDailyDigestPushText(scheduled, { sourceLabelById: sourceLabels }),
          createdAt: new Date().toISOString(),
          trigger: "scheduled",
        };
        try {
          await sendPushNotifications({ repository: settings, notification: digest });
        } catch (error) {
          console.error(
            `[media-track] digest push failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } catch (error) {
    console.error(`[media-track] notification push batch failed: ${String(error)}`);
  }
}

/**
 * 把 media-identity 的解析失败翻译成用户可见的 `unsupported` 结果。
 *
 * 抽出来是因为「畸形 id」与「不是这个种类的 id」必须给不同文案，而这个判断在两个入口
 * （预定/获取）都要用。内联到两个函数里会把它们的复杂度各推高 2——ESLint 上限 15，
 * `queueCandidateSeries` 已经因此红过一次。
 */

type ScheduledType3Result = {
  outcomes: Awaited<ReturnType<typeof runScheduledType3Monitoring>>;
  skipped?: "already_swept_today" | "before_scheduled_time" | "update_in_progress";
  scheduledFor?: string;
};

export async function runScheduledType3(options?: { force?: boolean }): Promise<ScheduledType3Result> {
  // Checked before any slot is claimed, so a scheduled patrol skipped here still runs
  // on the new version once the update is done.
  if (isUpdateHoldActive(Date.now())) {
    return { skipped: "update_in_progress", outcomes: [] };
  }
  // In flight for the updater's busy check: reservations and staging cleanup must not
  // be cut by a swap. The manual 立即巡检 and cron routes come through here too.
  return whileInFlight(() => runScheduledType3Now(options));
}

async function runScheduledType3Now(options?: { force?: boolean }): Promise<ScheduledType3Result> {
  const repository = getWorkflowRepository();
  let claimedNow: string[] = [];
  let priorClaims: string[] = [];
  let claimDate = "";
  if (!options?.force) {
    const times = await getDailySweepTimes(repository);
    const { date, hhmm } = beijingDateTime();
    priorClaims = await readSweepClaims(repository, date);
    const due = times.filter((slot) => hhmm >= slot && !priorClaims.includes(slot));
    if (due.length === 0) {
      // 还有未到点的 slot → 今天还会再跑，如实报 before_scheduled_time + 下一个
      // 时间点；只有过了最后一个 slot 且全部认领过才是 already_swept_today。
      const next = times.find((slot) => slot > hhmm);
      if (next) {
        return { skipped: "before_scheduled_time", scheduledFor: next, outcomes: [] };
      }
      return { skipped: "already_swept_today", outcomes: [] };
    }
    // 先认领后跑（含本次到期的全部 slot）。认领是普通 setSetting（非原子 CAS），
    // 极端并发双触发理论上可能都读到旧认领而各跑一次——进程内 worker 是单例串行
    // tick，外部 ping 撞车时下游 per-season reserveWorkflowRun 保证幂等（重复
    // sweep 的 run 全部 skipped_active），故不为此引入跨引擎原子机制。整体失败在
    // catch 里回滚到 priorClaims，下一个 tick 重试今天而不是等到明天。
    claimDate = date;
    claimedNow = due;
    await repository.setSetting(
      LAST_SWEEP_CLAIMS_SETTING_KEY,
      JSON.stringify({ date, slots: [...new Set([...priorClaims, ...due])].sort() }),
    );
  }
  const startedAt = new Date().toISOString();
  // Opportunistic history GC: drop finished runs (and children) older than 30d so
  // the claim/activity paths stay lean. Best-effort — never blocks the sweep.
  try {
    const cutoff = new Date(Date.parse(startedAt) - FINISHED_RUN_RETENTION_MS).toISOString();
    const pruned = await repository.pruneFinishedWorkflowRuns(cutoff);
    if (pruned > 0) {
      console.log(`[patrol] pruned ${pruned} finished workflow run(s) older than 30d`);
    }
  } catch (error) {
    console.error(
      `[patrol] pruneFinishedWorkflowRuns failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // 机会性死链回收（任务单 S3.4，P8）：过期软链此前只被读取过滤、从不删除，
  // 表无限增长。永久链（115 分享没了）永不回收。Best-effort，不阻断了巡检。
  try {
    const reaped = await repository.reapExpiredDeadLinks();
    if (reaped > 0) {
      console.log(`[patrol] reaped ${reaped} expired soft dead-link(s)`);
    }
    const stats = await repository.deadLinkStats();
    if (stats.softExpired > 0 || stats.permanent > 50) {
      // 可回收残留（不该发生）或永久链堆积时的可见信号（P8 风控感知）。
      console.log(
        `[patrol] dead-links: total=${stats.total} permanent=${stats.permanent} ` +
          `softActive=${stats.softActive} softExpired=${stats.softExpired}`,
      );
    }
  } catch (error) {
    console.error(
      `[patrol] dead-link reap failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let result: Awaited<ReturnType<typeof runScheduledType3Monitoring>>;
  // Set when an update hold stopped a show from being reserved mid-sweep: the sweep is
  // then not complete, and its slots must stay open for the new version.
  let heldBack = false;
  try {
    await hydratePan115CookieFromDb();
    const sync = tmdbSeasonMetadataSync();
    const accountId = await getCurrentAccountId();
    const { model, llmConfig, preferredLanguage, qualityPreference } = await getAgentModel(getAccountScopedSettings(accountId));
    const parents = await getWorkerStorageParents(accountId);
    result = await runScheduledType3Monitoring({
      repository,
      resourceProvider: await getWorkerResourceProvider(),
      storage: await getWorkerStorageExecutor(accountId),
      model,
      llmConfig,
      ...(preferredLanguage === undefined ? {} : { preferredLanguage }),
      ...(qualityPreference === undefined ? {} : { qualityPreference }),
      storageParentDirectoryId: parents.tv,
      animeStorageParentDirectoryId: parents.anime,
      moviesParentDirectoryId: parents.movies,
      staleActiveRunTimeoutMs: 30 * 60 * 1000,
      maxConcurrentRuns: await getPatrolConcurrency(repository),
      resolveDriveId: defaultDriveIdOf,
      resolveAccountContext: buildAccountContextResolver(),
      onAuthErrorFreeze: (id, reason) => freezeConnectedStorage(id, reason),
      mayStartRun: () => {
        const allowed = mayStartRun();
        if (!allowed) heldBack = true;
        return allowed;
      },
      ...(sync ? { syncSeasonMetadata: sync } : {}),
    });
    // Release this call's slots (as on a failure) and do not stamp a completed sweep,
    // so the new version patrols the rest today. Seasons that did run are only re-checked.
    const stopForUpdate = async () => {
      if (claimedNow.length > 0) {
        await repository.setSetting(
          LAST_SWEEP_CLAIMS_SETTING_KEY,
          JSON.stringify({ date: claimDate, slots: priorClaims }),
        );
      }
      await pushNotificationsSince(repository, startedAt, { sweep: true });
      return { skipped: "update_in_progress" as const, outcomes: result };
    };
    if (heldBack) return await stopForUpdate();
    try {
      const janitor = await sweepOrphanStagingDirs({
        repository,
        drives: await stagingJanitorDrives(),
        now: new Date().toISOString(),
        mayStartRun,
      });
      if (janitor.held) heldBack = true;
    } catch (error) {
      console.error(
        `[patrol] staging janitor failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The janitor stopped for an update, or the hold started after both had passed their
    // checks: either way the new version should run today's sweep, so do not mark it done.
    if (heldBack || !mayStartRun()) return await stopForUpdate();
    await repository.setSetting(LAST_SWEEP_COMPLETED_AT_SETTING_KEY, new Date().toISOString());
    await pushNotificationsSince(repository, startedAt, { sweep: true });
    return { outcomes: result };
  } catch (error) {
    // The sweep failed before completing — release THIS call's claims (keep the
    // prior ones) so the next ping retries today's due slots instead of skipping
    // until tomorrow. Per-season failures are swallowed inside the monitor, so
    // this only fires on infra-level errors.
    if (claimedNow.length > 0) {
      try {
        await repository.setSetting(
          LAST_SWEEP_CLAIMS_SETTING_KEY,
          JSON.stringify({ date: claimDate, slots: priorClaims }),
        );
      } catch {
        // best-effort release; nothing else to do
      }
    }
    throw error;
  }
}

/**
 * The Type 3 sweep's TMDB re-sync (the GUI's `sync_all`): refresh each tracked
 * season's aired/total from TMDB so the sweep discovers episodes that aired
 * after tracking began. Returns undefined when TMDB isn't configured, leaving
 * the sweep on stored counts.
 */
function syncOption(): { syncSeasonMetadata?: SeasonMetadataSync } {
  const sync = tmdbSeasonMetadataSync();
  return sync ? { syncSeasonMetadata: sync } : {};
}

function tmdbSeasonMetadataSync(): SeasonMetadataSync | undefined {
  if (!isLiveSearch()) {
    return undefined;
  }
  return async ({ tmdbId, seasonNumber }) => {
    const target = await prepareTrackingTarget({
      tmdbId,
      mediaType: "tv",
      seasonNumber,
      qualityPreference: defaultQuality(),
      metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId()))),
    });
    return {
      latestAiredEpisode: target.season.latestAiredEpisode,
      totalEpisodes: target.season.totalEpisodes,
    };
  };
}

/** One fresh executor per connected drive. Frozen drives are handed over with an
 *  empty executor — the janitor skips them before any call. A drive whose
 *  executor cannot be built is omitted; the rest of the patrol still runs. */
async function stagingJanitorDrives(): Promise<StagingJanitorDrive[]> {
  const repository = getWorkflowRepository();
  const drives: StagingJanitorDrive[] = [];
  for (const account of await repository.listAccounts()) {
    for (const storage of await repository.listConnectedStorages(account.id)) {
      if (storage.status !== "active") {
        drives.push({
          accountId: account.id,
          storageId: storage.id,
          status: storage.status,
          provider: storage.provider,
          tvCid: storage.tvCid,
          animeCid: storage.animeCid,
          executor: {},
        });
        continue;
      }
      try {
        drives.push({
          accountId: account.id,
          storageId: storage.id,
          status: storage.status,
          provider: storage.provider,
          tvCid: storage.tvCid,
          animeCid: storage.animeCid,
          executor: await getWorkerStorageExecutor(account.id, storage.id),
        });
      } catch (error) {
        console.error(
          `[patrol] staging janitor: executor for ${storage.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return drives;
}

async function seedDemoIfEmpty(targetRepository: WorkflowRepository): Promise<void> {
  const tracked = await targetRepository.listTrackedSeasonStates();
  if (tracked.length > 0) {
    return;
  }
  await seedDemoWorkflowRepository(targetRepository);
}


export async function getWorkerResourceProvider(
  settings: { getSetting(key: string): Promise<string | null> } = getWorkflowRepository(),
  provider: string = "pan115",
  accountId?: string,
): Promise<ResourceProvider> {
  // accountId 仅用于健康结论回写(recordPanSouHealth)。多账户场景下,worker 在
  // claim 后按 run 所属账号重建 provider(resolveWorkerDeps: ctx.resourceProvider
  // ?? base),走的是 buildAccountContextResolver 那条带 accountId 的路径;这里的
  // base provider 只在无 resolver(单用户/兜底)时被实际使用,此时 getCurrentAccountId()
  // 正确地返回 default 账号,所以两处都不丢账号作用域。
  if (process.env.MEDIA_TRACK_WORKFLOW_ADAPTER === "pansou") {
    // Per-brand assembly: a quark drive gets PanSou restricted to quark links and
    // NO Prowlarr (磁力 115-only); a 115 drive gets PanSou(115/magnet) + Prowlarr.
    const kinds: readonly string[] = isRegisteredStorageProvider(provider)
      ? getStorageBrand(provider).resourceProviderKinds
      : ["pansou-115", "prowlarr"];
    // 夸克 → quark-only links; 光鸭 → guangya + magnet; 115 → 115 + magnet.
    const allowedTypes: ResourceType[] = allowedResourceTypesForKinds(kinds);
    const providers: Array<{ name: string; provider: ResourceProvider }> = [
      {
        name: "pansou",
        // 用户配了自建源(DB 或 compose 注入的 env)就包一层 fallback:自建源挂掉时
        // 退到官方源续命,并把结果标 degraded —— 而不是像事故里那样静默报「没找到」。
        provider: buildPanSouProviderChain({
          userBaseURL: resolveUserPanSouBaseUrl(
            await settings.getSetting(PANSOU_BASE_URL_SETTING_KEY),
          ),
          allowedTypes,
          // 自建源开了认证就把凭据带进去。官方源那一侧由 buildPanSouProviderChain
          // 决定不带（把用户令牌送到第三方既无用又泄露），这里只负责把库里的
          // 凭据解析成 auth 形态。
          auth: await getPanSouAuth(settings),
          // 把每次真实搜索观察到的结论回写,设置页徽章才有东西可读。缺了这条,
          // 告警在生产中永远不触发:保存时探活只写 "ok",而本次事故恰恰是
          // 「保存时好的、之后才挂」。写失败不能影响搜索本身,所以 catch 后
          // 只记日志——但**不静默**,否则又是本 PR 要消灭的那个毛病。
          onSourceHealth: (healthy) => {
            void recordPanSouHealth(healthy, accountId);
          },
        }),
      },
    ];
    if (kinds.includes("prowlarr")) {
      const prowlarr = await getProwlarrConfig(settings);
      if (prowlarr.baseURL && prowlarr.apiKey) {
        providers.push({
          name: "prowlarr",
          provider: new ProwlarrResourceProvider({ baseURL: prowlarr.baseURL, apiKey: prowlarr.apiKey }),
        });
      }
    }
    const haisouApiKey = await getHaisouApiKey(settings);
    if (haisouApiKey) {
      providers.push({
        name: "haisou",
        provider: new HaisouResourceProvider({ apiKey: haisouApiKey, allowedTypes }),
      });
    }
    return providers.length > 1
      ? new CompositeResourceProvider({ providers })
      : providers[0]!.provider;
  }
  fakeResourceProvider ??= new FakeResourceProvider({
    keywordResults: {
      "翘楚 4K": [
        {
          title: "翘楚 S01E01-S01E12 4K",
        },
      ],
      "绝命毒师 4K": [
        {
          title: "绝命毒师 S01E01-S01E07 4K",
        },
      ],
    },
  });
  return fakeResourceProvider;
}

/** Opaque credential blob for token-auth brands (authKind "token"):
 *  光鸭 {accessToken,refreshToken,deviceId?}; 天翼 {sessionKey,accessToken,
 *  refreshToken,familySessionKey?}. Deliberately untyped here — each brand's
 *  client validates its own shape downstream. ⚠️ 天翼's durable identity lives at
 *  payload.meta.loginName, NOT in this blob: makeTokenPersister replaces the
 *  payload with blob+meta on every renewal, so a top-level loginName the client
 *  happens to include is transient and must not be relied on. */
type TokenCredential = Record<string, unknown>;

/** §7: the account's 115 credentials (cookie + category CIDs) from its
 *  connected_storages record. null when the account hasn't connected a 115 yet
 *  (then the worker falls back to the legacy env cookie / env CIDs). */
interface AccountStorageCredentials {
  id: string;
  /** The drive's brand — drives executor/probe/resource dispatch (tree model). */
  provider: string;
  status: "active" | "frozen";
  /** Cookie credential for cookie-auth brands (115/夸克). Empty for token-auth
   *  brands (光鸭/天翼), which carry their token blob in `credential` instead. */
  cookie: string;
  /** Token blob for token-auth brands (光鸭/天翼). null for cookie-auth brands. */
  credential: TokenCredential | null;
  rootCid: string | null;
  moviesCid: string | null;
  tvCid: string | null;
  animeCid: string | null;
}

/** Pull a drive's brand-appropriate credential out of its connected_storage
 *  payload. Cookie brands (115/夸克) store a cookie string; token brands (光鸭/
 *  天翼) store a token blob — routed by the registry's authKind (unregistered
 *  providers fall back to the cookie shape). Returns a presence flag the
 *  resolver uses the SAME way it used a non-empty cookie. */
function extractStorageCredential(
  provider: string,
  payload: unknown,
): { cookie: string; credential: TokenCredential | null } {
  const brand = isRegisteredStorageProvider(provider) ? getStorageBrand(provider) : null;
  if (brand?.authKind === "token") {
    // Token brands store an opaque credential blob. It counts as "connected" iff
    // every brand-required key (registry: requiredCredentialKeys) is a non-empty
    // string — 光鸭 needs accessToken+refreshToken (deviceId optional, rides along
    // in the blob); 天翼 needs the sessionKey/accessToken/refreshToken trio. Return
    // the raw blob as-is (the brand client trims/validates the rest downstream);
    // any required key missing → not-connected, exactly like an empty cookie.
    const blob = (payload ?? {}) as Record<string, unknown>;
    // A token brand with no requiredCredentialKeys is a REGISTRY MISCONFIG, not a
    // connected drive: `[].every(...)` is vacuously true, so without this guard any
    // payload (even {}) would silently pass. Require a non-empty key list.
    const requiredKeys = brand.requiredCredentialKeys ?? [];
    const ok =
      requiredKeys.length > 0 &&
      requiredKeys.every((key) => typeof blob[key] === "string" && (blob[key] as string).trim().length > 0);
    return ok ? { cookie: "", credential: blob } : { cookie: "", credential: null };
  }
  const cookie = (payload as { cookie?: string } | null)?.cookie?.trim() ?? "";
  return { cookie, credential: null };
}

/**
 * Provision a drive's media tree (Mediary Scout/{Movies,TV,Anime}) under the
 * account root and return the CIDs. Uses an UNRESTRICTED bootstrap executor — a
 * fresh drive has no write scope yet, and the scope is meant to come FROM these
 * dirs (the catch-22 that left 115 drives stuck "目录待建"). Bounded, idempotent
 * (find-or-create, no deletes). 115 root and 夸克 root are both "0"; 光鸭 root is
 * ""; 天翼 personal-cloud root is "-11".
 */
// Storage drive provisioning, probes and credential resolution re-exported from features/storage-drives
export {
  testConnection,
  STORAGE_PROBES,
  workerHasConfiguredDrive,
  getAccountDriveFileManager,
  customDirNamesFromEnv,
};

async function getWorkerStorageExecutor(
  accountId: string = DEFAULT_ACCOUNT_ID,
  connectedStorageId?: string | null,
  preloadedCreds?: AccountStorageCredentials | null,
): Promise<StorageExecutor> {
  const adapter = process.env.MEDIA_TRACK_STORAGE_ADAPTER;
  if (adapter === "fake") {
    fakeStorageExecutor ??= new FakeStorageExecutor({
      transferOutcomes: fakeTransferOutcomes(),
    });
    return fakeStorageExecutor;
  }
  const creds =
    preloadedCreds !== undefined
      ? preloadedCreds
      : await getAccountStorageCredentials(accountId, connectedStorageId);
  if (creds) {
    // Scope writes to THIS drive's own provisioned dirs — not the global env CIDs
    // (which belong to the default account's drive). Dispatch by the drive's
    // brand: 115 → Storage115Executor, quark → QuarkStorageExecutor.
    const scopeCids = [creds.rootCid, creds.moviesCid, creds.tvCid, creds.animeCid].filter(
      (cid): cid is string => Boolean(cid),
    );
    // Token-auth brands (光鸭/天翼) authenticate with a rotating credential blob
    // (not a cookie): pass the credential + a persist hook so a mid-run refresh
    // writes the new blob back into this drive's payload. Cookie brands (115/
    // 夸克) keep the cookie path untouched.
    if (isRegisteredStorageProvider(creds.provider) && getStorageBrand(creds.provider).authKind === "token") {
      return createExecutorForBrand({
        provider: creds.provider,
        credential: creds.credential ?? {},
        scopeCids,
        env: process.env,
        onCredentialRefresh: makeTokenPersister(accountId, creds.id, creds.provider),
      });
    }
    return createExecutorForBrand({
      provider: creds.provider,
      cookie: creds.cookie,
      scopeCids,
      env: process.env,
    });
  }
  if (adapter === "115") {
    // No drive bound yet → legacy env-cookie 115 path (fresh deploy bootstrap).
    return createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });
  }
  if (adapter !== undefined && adapter !== "fake" && adapter !== "115") {
    throw new Error(`MEDIA_TRACK_STORAGE_ADAPTER_UNSUPPORTED: ${adapter}`);
  }
  fakeStorageExecutor ??= new FakeStorageExecutor({
    transferOutcomes: fakeTransferOutcomes(),
  });
  return fakeStorageExecutor;
}

/**
 * The landing parent CIDs for a run's account. Sourced from the account's
 * connected_storage (set at connect-time directory provision); falls back to the
 * env CIDs when the account has no connected drive or the adapter is fake.
 */
async function getWorkerStorageParents(
  accountId: string = DEFAULT_ACCOUNT_ID,
  connectedStorageId?: string | null,
  preloadedCreds?: AccountStorageCredentials | null,
): Promise<{
  tv: string;
  anime: string;
  movies: string;
}> {
  const creds =
    process.env.MEDIA_TRACK_STORAGE_ADAPTER !== "fake"
      ? preloadedCreds !== undefined
        ? preloadedCreds
        : await getAccountStorageCredentials(accountId, connectedStorageId)
      : null;
  return {
    tv: creds?.tvCid || storageParentDirectoryId(),
    anime: creds?.animeCid || creds?.tvCid || animeParentDirectoryId(),
    movies: creds?.moviesCid || moviesParentDirectoryId(),
  };
}

/** Acquire-time LLM pre-check (issue #52)，随出厂免费预设收窄：对**生效配置**
 *  （resolveAgentModelConfig：DB → env → FREE_LLM_PRESET 回落）跑 llmConfigError。
 *  零配置 → 回落补齐 baseURL/modelId → 校验通过 → 返 null 不拦（开箱即用语义
 *  保留，#52 原先拦的「完全没配」场景已不存在）；半截配置（DB 或 env 的
 *  baseURL/modelId 一空一非空——saveLlmConfigAction 允许存这种行）→ 回落不
 *  触发（回落只认两键全空）→ 返回可行动文案，点击获取时友好拦截。不拦的话
 *  run 会入队，单用户（默认账号）路径的 getAgentModel 在 claim 之前抛
 *  llmConfigError，异常传出 drain（background-worker 只 console.error）→ run
 *  永久 queued、无失败卡、无通知 —— ghost run。fake/demo adapter 不需要 LLM
 *  → 恒 null（永不拦 demo/fake）。签名与 actions.ts 的调用点保持不变。 */

function fakeTransferOutcomes() {
  const outcomes: Record<string, { status: "succeeded"; providerMessage: string; files: VerifiedFile[] }> = {};
  for (let snapshotNumber = 1; snapshotNumber <= 20; snapshotNumber += 1) {
    const candidateId = `snapshot_${snapshotNumber}_candidate_1`;
    outcomes[candidateId] = {
      status: "succeeded",
      providerMessage: "fake transfer completed",
      files: episodeCodes(1, 24).map((code) => fakeVerifiedFile(candidateId, code)),
    };
  }
  return outcomes;
}

function fakeVerifiedFile(candidateId: string, code: string): VerifiedFile {
  return {
    id: `${candidateId}_${code}`,
    storageDirectoryId: "assigned_by_fake_storage",
    name: `Demo.${code}.mkv`,
    sizeBytes: 1_000_000_000,
    episodeCode: code,
    providerFileId: `provider_${candidateId}_${code}`,
  };
}

function episodeCodes(seasonNumber: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => episodeCode(seasonNumber, index + 1));
}

export function storageDirectoryIdForCandidate(_candidateId: string): string {
  // Empty means "let the Type 2 workflow create the canonical
  // `Title (Year)/Season N` directory under the configured parent".
  return process.env.MEDIA_TRACK_DEFAULT_TV_STORAGE_DIRECTORY_ID ?? "";
}

function storageParentDirectoryId(): string {
  return (
    process.env.MEDIA_TRACK_TV_PARENT_CID ??
    process.env.MEDIA_TRACK_115_TEST_ROOT_CID ??
    "fake_library_root"
  );
}

/**
 * Separate 115 landing parent for anime. Falls back to the TV parent when
 * MEDIA_TRACK_ANIME_PARENT_CID is unset, so anime simply co-locates with TV
 * until a dedicated Anime directory is configured.
 */
function animeParentDirectoryId(): string {
  return process.env.MEDIA_TRACK_ANIME_PARENT_CID ?? storageParentDirectoryId();
}

export type { ForeignWorkFinding, ForeignWorkReview };

function moviesParentDirectoryId(): string {
  return (
    process.env.MEDIA_TRACK_MOVIES_PARENT_CID ??
    process.env.MEDIA_TRACK_115_TEST_ROOT_CID ??
    "fake_movies_root"
  );
}

export {
  getWorkerStorageExecutor,
  getWorkerStorageParents,
};
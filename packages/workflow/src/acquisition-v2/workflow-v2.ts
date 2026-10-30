import type { AgentMemoryStore } from "../domain/agent-memory.js";
import type { LanguageModel } from "ai";
import type { ResourceProvider, StorageExecutor } from "../domain/ports.js";
import type { AuditEvent } from "../domain.js";
import {
  bindRecoveryDirectories,
  ensureSeasonAcquisitionDirectories,
  stagingCleanupUnverifiedAuditEvent,
  stagingKeptAuditEvent,
  stagingLeakAuditEvent,
  withStagingCleanup,
  type StagingCleanupUnverified,
  type StagingKeptUnmoved,
  type StagingLeak,
  type StagingRecoveryDirectories,
  type AcquisitionDirectories,
} from "./directory-lifecycle.js";
import type { DeadLinkStore } from "./dead-links.js";
import { readLandedSize } from "./landed-size.js";
import type { AgentToolEvent } from "./activity.js";
import { runAcquisitionV2, type AcquisitionV2Outcome, type RunAcquisitionV2Request, type RunAcquisitionV2Result } from "./orchestrator.js";
import type { JevJudge } from "../providers/jev-judge.js";
import { syncSeasonNeed } from "./sync-need.js";
import { RunStateMachine, type Compensation, type RunState } from "./run-state-machine.js";
import type { SearchProfile } from "./search-profile.js";

/**
 * Phase 7c — the outer workflow orchestration (TV/anime). It is the same
 * resource-sync shape for every situation (init / ongoing / patrol): ensure the
 * directory tree (verify-or-create), sync the need (应有 vs 实有 → cross-season
 * missing), run the strong agent over the sandbox if anything is missing, then
 * reconcile by re-reading storage. Returns facts; persistence/notification is the
 * caller's (runner's) job. No live side effects beyond the injected executor.
 */
export interface V2WorkflowSeason {
  seasonNumber: number;
  /** Aired up to this episode (should-exist = E01..latestAiredEpisode). */
  latestAiredEpisode: number;
}

export interface RunAcquisitionV2WorkflowRequest {
  provider: ResourceProvider;
  executor: StorageExecutor;
  model: LanguageModel;
  workflowRunId: string;
  title: { name: string; year: number; aliases: string[]; tmdbId: number };
  /** Library category parent (Movies/TV/Anime), chosen by title.type upstream. */
  categoryParentId: string;
  seasons: V2WorkflowSeason[];
  qualityPreference: string;
  /** 实有 = the DB obtained marks for this title (the agent's prior markObtained).
   *  Empty for a first acquisition; the type-3 patrol passes the DB's obtained
   *  episode codes so the need = aired − 实有 (NOT a 115 scan). */
  priorObtained?: string[];
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  /** TMDB origin_country of the title — when it includes CN the TV/anime prompt skips
   *  the 中文 subtitle floor (国产剧/动漫 natively Chinese-spoken). */
  originCountries?: string[];
  searchHints?: string;
  qualityGuidance?: string;
  /** The task's fine-grained search profile — enables the anime taboo-keyword
   *  validator (warnings only, never blocking). 病2b。 */
  searchProfile?: SearchProfile;
  /** The run's drive brand ("pan115" | "quark") — selects brand-specific skill. */
  storageProvider?: string;
  /** assrt token (Settings → 字幕来源). Undefined = 字幕流程不触发。 */
  assrtToken?: string;
  /** Optional Jev candidate prefilter (see orchestrator.jevJudge). */
  jevJudge?: JevJudge;
  deadLinkStore?: DeadLinkStore;
  /** Agent memory (see orchestrator.memory). */
  memory?: { store: AgentMemoryStore; accountId: string; drive?: string };
  /** A replace_request run (see orchestrator.userRequest). Its episodes join the
   *  agent's need, and the run goes ahead even when nothing is missing. */
  userRequest?: RunAcquisitionV2Request["userRequest"];
  /** See orchestrator.protectExisting. */
  protectExisting?: RunAcquisitionV2Request["protectExisting"];
  /** See orchestrator.rejectedLookup. */
  rejectedLookup?: RunAcquisitionV2Request["rejectedLookup"];
  /** See orchestrator.linkHistory. */
  linkHistory?: RunAcquisitionV2Request["linkHistory"];
  /** Leftover staging. The orphan dir is the staging handle; season dirs are resolved
   *  under `showDirectoryId`. The agent runs even when the DB already says complete. */
  stagingRecovery?: StagingRecoveryDirectories;
  /** Web-reference tools (alternate titles, fan-season ↔ TMDB episode mapping). */
  titleResearch?: { web: { llmBaseURL?: string; llmApiKey?: string; timeoutMs?: number; limit?: number } };
  onProgress?: (event: AgentToolEvent) => void;
}

export interface RunAcquisitionV2WorkflowResult {
  directories: AcquisitionDirectories;
  /** 终态生命周期（任务单 S3.2）。失败路径走抛错，终态记进日志。 */
  runState?: RunState;
  /** 本 run 登记且已执行的补偿清单（暂存销毁等；失败路径见日志）。 */
  compensations?: readonly Compensation[];
  /** The missing set computed before the agent ran. */
  missingBefore: string[];
  outcome: AcquisitionV2Outcome;
  agentText: string;
  /** Re-synced from real storage after the agent: what is still missing / obtained. */
  stillMissing: string[];
  obtained: string[];
  providerAhead: string[];
  /** Real landed video files across the season dirs (best-effort, post-run); fuels
   *  the notification's true per-episode size. Absent when the read failed/empty. */
  landedFileCount?: number;
  landedBytes?: number;
  auditEvents: AuditEvent[];
  /** Present only on a replace_request run (see orchestrator). */
  replacement?: RunAcquisitionV2Result["replacement"];
}

const EMPTY_OUTCOME: AcquisitionV2Outcome = { resourceSnapshots: [], decisions: [], transferAttempts: [] };

export async function runAcquisitionV2Workflow(
  request: RunAcquisitionV2WorkflowRequest,
): Promise<RunAcquisitionV2WorkflowResult> {
  // 任务单 S3.2：显式生命周期状态机。粗粒度——agent 内部的步骤 trace 仍以它自己
  // 的记录为准；这里记录 workflow 拥有的阶段边界，并让失败路径的补偿显式化。
  // runner 在调用前已认领（CLAIM），machine 在此创建并立即推进到执行态。
  const fsm = RunStateMachine.create();
  fsm.send({ type: "CLAIM" });

  // 7a — verify-or-create the directory tree, get scoped handles.
  // A recovery adopts the leftover dir and does not create a new staging dir.
  const directories = request.stagingRecovery
    ? await bindRecoveryDirectories({
        ...request.stagingRecovery,
        executor: request.executor,
        seasons: request.seasons.map((season) => season.seasonNumber),
      })
    : await ensureSeasonAcquisitionDirectories({
        executor: request.executor,
        categoryParentId: request.categoryParentId,
        showName: request.title.name,
        year: request.title.year,
        tmdbId: request.title.tmdbId,
        seasons: request.seasons.map((season) => season.seasonNumber),
        workflowRunId: request.workflowRunId,
      });

  // Harness-level leak guard: whatever the agent does (covers, fails, or
  // reportNoCoverage), the run's staging dir is discarded when this returns or
  // throws — the 斗破苍穹 335-file leak fix. The agent keeps its own discardStaging
  // (and normally calls it); this is the deterministic backstop.
  // The cleanup reads the show dir back afterwards: a delete the provider quietly
  // ignored (123 file/trash + string FileId, 2026-09-20) must surface as a
  // `staging_leaked` audit event instead of vanishing behind {removed:true}.
  fsm.send({ type: "DIRS_READY" });

  const leaks: StagingLeak[] = [];
  const unverified: StagingCleanupUnverified[] = [];
  const kept: StagingKeptUnmoved[] = [];
  // Assigned inside runAcquisitionV2 the moment the sandbox exists, so a throw
  // from the agent loop still lets this finally see files whose move failed.
  const unmovedStaging: { read: (() => string[]) | null } = { read: null };
  const terminalCleanup: { read: (() => boolean) | null } = { read: null };
  let result: RunAcquisitionV2WorkflowResult;
  try {
    result = await withStagingCleanup(
    {
      executor: request.executor,
      stagingDirectoryId: directories.stagingDirectoryId,
      parentDirectoryId: directories.showDirectoryId,
      onLeak: (leak) => leaks.push(leak),
      onCleanupUnverified: (event) => unverified.push(event),
      keep: () => {
        const fileCount = unmovedStaging.read?.().length ?? 0;
        return fileCount > 0 ? { fileCount } : null;
      },
      // The adopted leftover can be the only copy. A throw must not delete it,
      // and a normal exit deletes it only after discardStaging. finish does not.
      ...(request.stagingRecovery
        ? { preserveOnThrow: true, discardOnNormalReturn: () => terminalCleanup.read?.() ?? false }
        : {}),
      onKept: (event) => kept.push(event),
    },
    async () => {
  const seasonsForSync = request.seasons.map((season) => ({
    seasonNumber: season.seasonNumber,
    latestAiredEpisode: season.latestAiredEpisode,
  }));
  const priorObtained = request.priorObtained ?? [];

  // 7b — sync the need from the DB marks (应有 − 实有). No 115 scan, no parser.
  const before = syncSeasonNeed({ seasons: seasonsForSync, obtained: priorObtained });
  // A user request runs the agent even on a complete library: the episodes to
  // replace are obtained (the old file is there), so they are never "missing".
  // A leftover may be the only copy of an episode the DB already calls obtained.
  fsm.send({ type: "SEARCHED" });
  if (before.missing.length === 0 && !request.userRequest && !request.stagingRecovery) {
    // Already current — no agent run, no side effects (the type-3 no-op path).
    fsm.send({ type: "NOTHING_TO_DO" });
    return {
      directories,
      missingBefore: [],
      outcome: EMPTY_OUTCOME,
      agentText: "",
      stillMissing: [],
      obtained: before.obtained,
      providerAhead: before.providerAhead,
      auditEvents: [],
      runState: fsm.state,
      compensations: fsm.pendingCompensations,
    };
  }

  fsm.send({ type: "CANDIDATES_READY" });

  // Run the strong TV/anime agent over the sandbox.
  const v2 = await runAcquisitionV2({
    provider: request.provider,
    executor: request.executor,
    model: request.model,
    workflowRunId: request.workflowRunId,
    target: {
      kind: "tv",
      title: request.title.name,
      aliases: request.title.aliases,
      year: request.title.year,
      seasons: request.seasons.map((season) => season.seasonNumber),
      // Only the truly missing ones: episodes to replace join the need inside the
      // orchestrator and are described separately in the USER REQUESTS block.
      missingEpisodes: before.missing,
      qualityPreference: request.qualityPreference,
      ...(request.title.tmdbId ? { tmdbId: request.title.tmdbId } : {}),
    },
    stagingDirectoryId: directories.stagingDirectoryId,
    targetSeasonDirectoryIds: directories.seasonDirectoryIds,
    ...(request.searchBudget === undefined ? {} : { searchBudget: request.searchBudget }),
    ...(request.maxSteps === undefined ? {} : { maxSteps: request.maxSteps }),
    ...(request.preferredLanguage === undefined ? {} : { preferredLanguage: request.preferredLanguage }),
    ...(request.originCountries === undefined ? {} : { originCountries: request.originCountries }),
    ...(request.searchHints === undefined ? {} : { searchHints: request.searchHints }),
    ...(request.qualityGuidance === undefined ? {} : { qualityGuidance: request.qualityGuidance }),
    ...(request.searchProfile === undefined ? {} : { searchProfile: request.searchProfile }),
    ...(request.storageProvider === undefined ? {} : { storageProvider: request.storageProvider }),
    ...(request.assrtToken === undefined ? {} : { assrtToken: request.assrtToken }),
    ...(request.jevJudge === undefined ? {} : { jevJudge: request.jevJudge }),
    ...(request.deadLinkStore ? { deadLinkStore: request.deadLinkStore } : {}),
    ...(request.memory ? { memory: request.memory } : {}),
    ...(request.userRequest ? { userRequest: request.userRequest } : {}),
    ...(request.stagingRecovery
      ? { stagingRecovery: true as const, protectExisting: { episodes: "unknown" as const } }
      : request.protectExisting
        ? { protectExisting: request.protectExisting }
        : {}),
    ...(request.rejectedLookup ? { rejectedLookup: request.rejectedLookup } : {}),
    ...(request.linkHistory ? { linkHistory: request.linkHistory } : {}),
    ...(request.titleResearch === undefined ? {} : { titleResearch: request.titleResearch }),
    ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    unmovedStaging,
    ...(request.stagingRecovery ? { terminalCleanup } : {}),
  });

  // Reconcile from the AGENT'S coverage (its markObtained), NOT a 115 re-scan:
  // 实有 after = prior DB marks ∪ what the agent marked this run (§1.13/§7b).
  // An episode the user asked to replace is in priorObtained, so it stays obtained
  // whether or not the replacement landed. The agent's side carries such an episode
  // only once it was reported replaced (sandbox finish): one declared file-less and
  // reported not_found never becomes obtained on a bare mark.
  const after = syncSeasonNeed({
    seasons: seasonsForSync,
    obtained: [...priorObtained, ...v2.coverage.obtained],
  });

  // Best-effort real landed size for the notification (true per-episode bytes,
  // not a claimed quality). Reads AFTER the acquisition succeeded; on the heavy
  // run where the 115 call budget is spent this returns undefined rather than
  // throwing, so the size is simply omitted — never failing a good run.
  // A replace run skips it (like the movie path): its season dirs hold the old
  // AND the new copies, and the replace notification drops the size anyway.
  const landed = request.userRequest
    ? undefined
    : await readLandedSize(request.executor, Object.values(directories.seasonDirectoryIds));

  // 粗粒度阶段标记：agent 已跑完落库/核对/整理/去重；暂存销毁由 withStagingCleanup
  // 在返回前保证（那正是 fsm 登记的补偿）。
  fsm.send({ type: "TRANSFER_STARTED" });
  fsm.send({ type: "LANDED" });
  fsm.send({ type: "INSPECTED" });
  fsm.send({ type: "ORGANIZED" });
  fsm.send({ type: "DEDUPED" });
  fsm.send({ type: "PURGED" });
  return {
    directories,
    missingBefore: before.missing,
    outcome: v2.outcome,
    agentText: v2.text,
    stillMissing: after.missing,
    obtained: after.obtained,
    providerAhead: after.providerAhead,
    auditEvents: v2.auditEvents,
    runState: fsm.state,
    compensations: fsm.pendingCompensations,
    ...(landed ? { landedFileCount: landed.fileCount, landedBytes: landed.totalBytes } : {}),
    ...(v2.replacement ? { replacement: v2.replacement } : {}),
  };
    },
  );
  const stagingEvents = [
    ...leaks.map((leak) => stagingLeakAuditEvent(leak)),
    ...unverified.map((event) => stagingCleanupUnverifiedAuditEvent(event)),
    ...kept.map((event) => stagingKeptAuditEvent(event)),
  ];
  if (stagingEvents.length === 0) {
    return result;
  }
  return {
    ...result,
    auditEvents: [...result.auditEvents, ...stagingEvents],
  };
  } catch (error) {
    // Saga 失败路径（任务单 S3.2）：FAIL → sagaCompensating。暂存清理由
    // withStagingCleanup 的 finally 已经执行——那正是 fsm 登记的补偿；这里做
    // 一致性互检（清单非空却什么都没清是不可能的），标记补偿完成后原样上抛，
    // 由 runner 记 failed。补偿清单进日志，排障时看得见做了什么。
    fsm.send({ type: "FAIL", reason: error instanceof Error ? error.message : String(error) });
    const kinds = fsm.pendingCompensations.map((compensation) => compensation.kind);
    if (kinds.length > 0) {
      fsm.send({ type: "COMPENSATED" });
    }
    console.log(
      `[workflow] run ${request.workflowRunId} saga: compensations=[${kinds.join(", ") || "none"}] → ${fsm.state}`,
    );
    throw error;
  }
}

import type { AgentMemoryStore } from "../domain/agent-memory.js";
import type { LanguageModel } from "ai";
import type { MediaTitle } from "../domain.js";
import type { ResourceProvider, StorageExecutor } from "../domain/ports.js";
import {
  bridgeV2WorkflowToResult,
  type BridgedV2Result,
  type V2BridgeMode,
  type V2BridgeSeasonIntent,
} from "./workflow-v2-bridge.js";
import type { DeadLinkStore } from "./dead-links.js";
import type { JevJudge } from "../providers/jev-judge.js";
import { runAcquisitionV2Workflow, type RunAcquisitionV2WorkflowRequest } from "./workflow-v2.js";
import { getQualityGuidance, getSearchRecipe, searchProfile } from "./search-profile.js";
import type { AgentToolEvent } from "./activity.js";
import { ensureMediaLibraryDirectory } from "../domain/media-library-folder.js";
import { StorageArchiveAdapter } from "../storage/storage-archive-adapter.js";
import { MediaOrganizer } from "../execution/media-organizer.js";
import { episodeCodeFromFileName } from "../domain/episode-code.js";

function defaultNowIso(): string {
  return new Date().toISOString();
}

/**
 * Phase 7d — the single TV/anime acquisition entry on the V2 engine. type2 init,
 * series init, and type3 patrol are all the SAME resource-sync workflow
 * (verify-or-create dirs → sync need → strong agent → reconcile); they differ
 * only in the notification framing, captured by `mode`. Returns the bridged
 * per-season WorkflowResult facts; persistence is the runner's job.
 */
export interface RunTvAcquisitionV2Request {
  title: MediaTitle;
  mode: V2BridgeMode;
  seasons: V2BridgeSeasonIntent[];
  /** Library category parent (Movies/TV/Anime), chosen by title.type upstream. */
  categoryParentId: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  workflowRunId: string;
  /** 实有 = the DB obtained marks (agent's prior markObtained); empty for a first
   *  acquisition, the type-3 patrol passes the DB obtained codes. */
  priorObtained?: string[];
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  /** Global quality preference ("high"/"medium"); undefined = 不限 (no guidance). */
  qualityPreference?: "high" | "medium";
  /** The run's drive brand ("pan115" | "quark") — selects brand-specific skill. */
  storageProvider?: string;
  /** assrt token (Settings → 字幕来源). Undefined = 字幕流程不触发。 */
  assrtToken?: string;
  /** Optional Jev candidate prefilter (Settings); resolved per account by the worker. */
  jevJudge?: JevJudge;
  deadLinkStore?: DeadLinkStore;
  /** Agent memory (see orchestrator.memory). */
  memory?: { store: AgentMemoryStore; accountId: string; drive?: string };
  /** A replace_request run (see orchestrator.userRequest). */
  userRequest?: RunAcquisitionV2WorkflowRequest["userRequest"];
  /** See orchestrator.protectExisting. */
  protectExisting?: RunAcquisitionV2WorkflowRequest["protectExisting"];
  /** See orchestrator.rejectedLookup. */
  rejectedLookup?: RunAcquisitionV2WorkflowRequest["rejectedLookup"];
  /** See orchestrator.linkHistory. */
  linkHistory?: RunAcquisitionV2WorkflowRequest["linkHistory"];
  policyFilter?: RunAcquisitionV2WorkflowRequest["policyFilter"];
  policyFileValidator?: RunAcquisitionV2WorkflowRequest["policyFileValidator"];
  subscriptionSearchKeywords?: RunAcquisitionV2WorkflowRequest["subscriptionSearchKeywords"];
  /** Leftover staging dir adopted as this run's staging. See workflow-v2. */
  stagingRecovery?: RunAcquisitionV2WorkflowRequest["stagingRecovery"];
  /** Web-reference tools (alternate titles, fan-season ↔ TMDB episode mapping). */
  titleResearch?: RunAcquisitionV2WorkflowRequest["titleResearch"];
  /** Override the routine-patrol notification when a user explicitly reruns a tracked season. */
  notificationTrigger?: "scheduled" | "user";
  onProgress?: (event: AgentToolEvent) => void;
  now?: () => string;
}

export async function runTvAcquisitionV2(request: RunTvAcquisitionV2Request): Promise<BridgedV2Result> {
  if (request.seasons.length === 0) {
    throw new Error("runTvAcquisitionV2 requires at least one season in scope");
  }
  // The fine-grained profile drives BOTH the keyword recipe and the quality
  // guidance (e.g. anime → "4K is scarce, don't over-search for it").
  const profile = searchProfile({
    type: request.title.type,
    originCountries: request.title.originCountries ?? [],
  });
  const qualityGuidance = getQualityGuidance(profile, request.qualityPreference);

  const discoveredObtainedSet = new Set<string>();
  if (!request.userRequest && !request.stagingRecovery) {
    try {
      const showDirectoryId = await ensureMediaLibraryDirectory({
        executor: request.storage,
        parentId: request.categoryParentId,
        title: request.title.title,
        year: request.title.year ?? "—",
        tmdbId: request.title.tmdbId,
      });

      const archiveAdapter = new StorageArchiveAdapter({
        storage: request.storage,
        rootCid: request.categoryParentId,
      });
      const organizer = new MediaOrganizer({
        storage: request.storage,
        archiveAdapter,
      });

      const childDirs = await request.storage.listChildDirectories(showDirectoryId);

      // 1. Recover any uncleaned staging directories directly into Season folders
      for (const dir of childDirs) {
        if (/^staging-/i.test(dir.name)) {
          try {
            await organizer.organizeStagingDirectory({
              stagingDirectoryId: dir.id,
              showDirectoryId,
              title: request.title.title,
              type: request.title.type === "anime" ? "anime" : "tv",
              year: request.title.year,
              tmdbId: request.title.tmdbId,
              fallbackCategoryParentId: request.categoryParentId,
            });
          } catch {
            // best-effort
          }
        }
      }

      // 2. Scan Season folders to discover already obtained episodes on disk
      const freshChildDirs = await request.storage.listChildDirectories(showDirectoryId);
      for (const dir of freshChildDirs) {
        const seasonMatch = /^Season\s+(\d+)$/i.exec(dir.name);
        if (!seasonMatch?.[1]) continue;
        const seasonNum = Number(seasonMatch[1]);
        const videos = await request.storage.listVideoFiles(dir.id);
        for (const v of videos) {
          const code = episodeCodeFromFileName(v.name, seasonNum);
          if (code) {
            discoveredObtainedSet.add(code);
          }
        }
      }
    } catch {
      // Pre-flight probe failed; proceed without pre-flight hints
    }
  }

  const mergedPriorObtained = Array.from(
    new Set([...(request.priorObtained ?? []), ...discoveredObtainedSet]),
  );

  const v2 = await runAcquisitionV2Workflow({
    provider: request.resourceProvider,
    executor: request.storage,
    model: request.model,
    workflowRunId: request.workflowRunId,
    title: {
      name: request.title.title,
      year: request.title.year ?? 0,
      aliases: request.title.aliases ?? [],
      tmdbId: request.title.tmdbId,
    },
    categoryParentId: request.categoryParentId,
    seasons: request.seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      latestAiredEpisode: season.latestAiredEpisode,
    })),
    qualityPreference: request.seasons[0]!.qualityPreference,
    searchHints: getSearchRecipe(profile),
    searchProfile: profile,
    ...(qualityGuidance === "" ? {} : { qualityGuidance }),
    priorObtained: mergedPriorObtained,
    ...(request.searchBudget === undefined ? {} : { searchBudget: request.searchBudget }),
    ...(request.maxSteps === undefined ? {} : { maxSteps: request.maxSteps }),
    ...(request.preferredLanguage === undefined ? {} : { preferredLanguage: request.preferredLanguage }),
    ...(request.title.originCountries === undefined ? {} : { originCountries: request.title.originCountries }),
    ...(request.storageProvider === undefined ? {} : { storageProvider: request.storageProvider }),
    ...(request.assrtToken === undefined ? {} : { assrtToken: request.assrtToken }),
    ...(request.jevJudge === undefined ? {} : { jevJudge: request.jevJudge }),
    ...(request.deadLinkStore ? { deadLinkStore: request.deadLinkStore } : {}),
    ...(request.memory ? { memory: request.memory } : {}),
    ...(request.userRequest ? { userRequest: request.userRequest } : {}),
    ...(request.protectExisting ? { protectExisting: request.protectExisting } : {}),
    ...(request.rejectedLookup ? { rejectedLookup: request.rejectedLookup } : {}),
    ...(request.linkHistory ? { linkHistory: request.linkHistory } : {}),
    ...(request.policyFilter ? { policyFilter: request.policyFilter } : {}),
    ...(request.policyFileValidator ? { policyFileValidator: request.policyFileValidator } : {}),
    ...(request.subscriptionSearchKeywords === undefined
      ? {}
      : { subscriptionSearchKeywords: request.subscriptionSearchKeywords }),
    ...(request.stagingRecovery ? { stagingRecovery: request.stagingRecovery } : {}),
    ...(request.titleResearch === undefined ? {} : { titleResearch: request.titleResearch }),
    ...(request.onProgress ? { onProgress: request.onProgress } : {}),
  });

  const bridged = bridgeV2WorkflowToResult({
    title: request.title,
    mode: request.stagingRecovery ? "staging_recovery" : request.mode,
    seasons: request.seasons,
    v2,
    workflowRunId: request.workflowRunId,
    now: request.now ?? defaultNowIso,
    ...(request.notificationTrigger === undefined ? {} : { notificationTrigger: request.notificationTrigger }),
  });
  return v2.replacement ? { ...bridged, replacement: v2.replacement } : bridged;
}

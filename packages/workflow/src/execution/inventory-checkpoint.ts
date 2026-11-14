import { DEFAULT_ACCOUNT_ID, createEpisodeStates, reconcileVerifiedFiles, type MediaTitle } from "../domain/domain.js";
import type { RunTvAcquisitionV2Request } from "../acquisition-v2/run-tv-v2.js";
import type { WorkflowRepository } from "../persistence/repository.js";

/** Commit verified existing files before acquisition can fail, without completing its run. */
export function inventoryCheckpoint(input: {
  repository: WorkflowRepository;
  title: MediaTitle;
  workflowRun: { id: string };
  accountId?: string;
  connectedStorageId?: string | null;
  now?: () => string;
}): NonNullable<RunTvAcquisitionV2Request["onInventory"]> {
  return async ({ seasonNumber, directoryId, files }) => {
    if (files.length === 0) return;
    const scope = { accountId: input.accountId ?? DEFAULT_ACCOUNT_ID, connectedStorageId: input.connectedStorageId ?? null };
    const tracked = (await input.repository.listTrackedSeasonStates(scope)).find((state) =>
      state.title.id === input.title.id && state.season.seasonNumber === seasonNumber);
    if (!tracked) return; // A concurrent untrack wins; discovery must not revive it.
    const now = (input.now ?? (() => new Date().toISOString()))();
    const season = { ...tracked.season, storageDirectoryId: directoryId };
    const episodes = reconcileVerifiedFiles({ season, files,
      episodes: createEpisodeStates({ trackedSeasonId: season.id, seasonNumber,
        totalEpisodes: season.totalEpisodes, latestAiredEpisode: season.latestAiredEpisode }),
    });
    await input.repository.saveWorkflowRunSnapshot({
      ...scope, title: tracked.title, season, episodes,
      workflowRun: { id: `inventory_${input.workflowRun.id}_s${seasonNumber}`, kind: "type2_init", status: "succeeded",
        trackedSeasonId: season.id, startedAt: now, finishedAt: now,
        auditEvents: [{ type: "inventory_reconciled", message: `已核验 ${files.length} 个现有视频文件`, data: { sourceRunId: input.workflowRun.id, seasonNumber } }],
      },
      resourceSnapshots: [], decisions: [], transferAttempts: [], notifications: [],
      mergeCurrentEpisodes: true, requireTrackedSeason: true, inventoryDirectoryId: directoryId,
    });
  };
}

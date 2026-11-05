import type { MediaTitle, TrackedSeason, WorkflowRepository } from "@media-track/workflow";
import {
  inspectStorageBeforeAcquisition,
  adoptExistingMovie,
  adoptExistingTvSeason,
} from "@media-track/workflow";
import { getAccountDriveFileManager } from "../../storage-drives";
import type { CandidateTrackingRequestResult } from "../contracts/acquisition-types";

/**
 * 电影订阅前置探测：如果网盘已有完整落盘文件，直接纳入管理，阻断不必要的 PanSou 搜索与下载
 */
export async function tryInspectAndAdoptMovie(input: {
  accountId: string;
  executionAccountId: string;
  workspaceId: string | null;
  movie: { title: MediaTitle; keyword: string };
  repo: WorkflowRepository;
  sharedMode: boolean;
}): Promise<{ adopted: boolean; result?: CandidateTrackingRequestResult }> {
  try {
    const fileManager = await getAccountDriveFileManager(input.executionAccountId, input.workspaceId);
    if (!fileManager) return { adopted: false };

    const storageRecord = input.workspaceId
      ? await input.repo.getConnectedStorageById(input.workspaceId)
      : null;

    const inspectRes = await inspectStorageBeforeAcquisition({
      storage: fileManager,
      mediaKind: "movie",
      title: input.movie.title.title,
      year: input.movie.title.year,
      tmdbId: input.movie.title.tmdbId,
      categoryParentId: storageRecord?.moviesCid || "0",
    });

    if (
      inspectRes.mediaKind === "movie" &&
      inspectRes.matched &&
      inspectRes.completeness === "full" &&
      inspectRes.videoFiles.length > 0
    ) {
      const runId = await adoptExistingMovie({
        title: input.movie.title,
        repository: input.repo,
        accountId: input.executionAccountId,
        connectedStorageId: input.workspaceId,
        directoryId: inspectRes.folderId ?? (storageRecord?.moviesCid || "0"),
        videoFiles: inspectRes.videoFiles,
      });

      if (input.sharedMode) {
        await input.repo.createMediaRequest({
          accountId: input.accountId,
          mediaTitleId: input.movie.title.id,
          seasonNumber: null,
          status: "ready",
          workflowRunId: runId,
        });
      }

      return {
        adopted: true,
        result: {
          status: "already_tracked",
          workflowRunId: runId,
          trackedSeasonId: `${input.movie.title.id}_movie`,
          message: "检测到网盘已存在该电影完整文件，已自动补全订阅并纳入媒体库！",
        },
      };
    }
  } catch (error) {
    console.warn(`[storage-preflight] movie inspection error: ${String(error)}`);
  }
  return { adopted: false };
}

interface TvAdoptionContext {
  accountId: string;
  executionAccountId: string;
  workspaceId: string | null;
  target: { title: MediaTitle; season: TrackedSeason };
  repo: WorkflowRepository;
  sharedMode: boolean;
}

async function executeTvSeasonAdoption(
  ctx: TvAdoptionContext,
  sRes: { seasonNumber: number; seasonDirectoryId?: string | undefined; completeness: string; existingEpisodes: Array<{ episodeCode: string; seasonNumber: number; episodeNumber: number; fileId: string; fileName: string; sizeBytes: number }> },
  showDirectoryId?: string,
): Promise<CandidateTrackingRequestResult> {
  const isFull = sRes.completeness === "full";
  const runId = await adoptExistingTvSeason({
    title: ctx.target.title,
    season: ctx.target.season,
    repository: ctx.repo,
    accountId: ctx.executionAccountId,
    connectedStorageId: ctx.workspaceId,
    directoryId: sRes.seasonDirectoryId ?? showDirectoryId ?? undefined,
    existingEpisodes: sRes.existingEpisodes,
    isFull,
  });

  if (ctx.sharedMode) {
    await ctx.repo.createMediaRequest({
      accountId: ctx.accountId,
      mediaTitleId: ctx.target.title.id,
      seasonNumber: ctx.target.season.seasonNumber,
      status: isFull ? "ready" : "queued",
      workflowRunId: runId,
    });
  }

  const message = isFull
    ? `检测到网盘已存在第 ${ctx.target.season.seasonNumber} 季全部剧集 (${sRes.existingEpisodes.length} 集)，已自动补全并归档！`
    : `检测到网盘已存在 ${sRes.existingEpisodes.length} 集，已自动关联已有集数，缺集转入后台获取！`;

  return {
    status: isFull ? "already_tracked" : "queued",
    workflowRunId: runId,
    trackedSeasonId: ctx.target.season.id,
    message,
  };
}

/**
 * 剧集季订阅前置探测：全量存在则直接标记完成，部分存在则标记已有集数并让后台仅补全缺集
 */
export async function tryInspectAndAdoptTv(input: {
  accountId: string;
  executionAccountId: string;
  workspaceId: string | null;
  target: { title: MediaTitle; season: TrackedSeason };
  repo: WorkflowRepository;
  sharedMode: boolean;
}): Promise<{ adopted: boolean; result?: CandidateTrackingRequestResult }> {
  try {
    const fileManager = await getAccountDriveFileManager(input.executionAccountId, input.workspaceId);
    if (!fileManager) return { adopted: false };

    const storageRecord = input.workspaceId
      ? await input.repo.getConnectedStorageById(input.workspaceId)
      : null;

    const categoryCid = storageRecord?.tvCid ?? storageRecord?.animeCid ?? undefined;
    const inspectRes = await inspectStorageBeforeAcquisition({
      storage: fileManager,
      mediaKind: "tv",
      title: input.target.title.title,
      year: input.target.title.year,
      tmdbId: input.target.title.tmdbId,
      categoryParentId: categoryCid || "0",
      seasons: [
        {
          seasonNumber: input.target.season.seasonNumber,
          totalEpisodes: input.target.season.totalEpisodes,
          latestAiredEpisode: input.target.season.latestAiredEpisode,
        },
      ],
    });

    if (inspectRes.mediaKind !== "tv" || !inspectRes.matched || inspectRes.seasons.length === 0) {
      return { adopted: false };
    }

    const sRes =
      inspectRes.seasons.find((s) => s.seasonNumber === input.target.season.seasonNumber) ??
      inspectRes.seasons[0];

    if (!sRes || sRes.existingEpisodes.length === 0) {
      return { adopted: false };
    }

    const result = await executeTvSeasonAdoption(input, sRes, inspectRes.showDirectoryId);
    return { adopted: true, result };
  } catch (error) {
    console.warn(`[storage-preflight] tv inspection error: ${String(error)}`);
  }
  return { adopted: false };
}

export interface SeriesTargetInput {
  title: MediaTitle;
  seasons: Array<{
    seasonNumber: number;
    totalEpisodes: number;
    latestAiredEpisode: number;
  }>;
  keyword: string;
}

interface SeriesAdoptionContext {
  accountId: string;
  executionAccountId: string;
  workspaceId: string | null;
  target: SeriesTargetInput;
  repo: WorkflowRepository;
  sharedMode: boolean;
}

async function adoptAllFullSeasons(
  ctx: SeriesAdoptionContext,
  inspectRes: { showDirectoryId?: string | undefined; seasons: Array<{ seasonNumber: number; seasonDirectoryId?: string | undefined; existingEpisodes: Array<{ episodeCode: string; seasonNumber: number; episodeNumber: number; fileId: string; fileName: string; sizeBytes: number }> }> },
): Promise<string | null> {
  let lastRunId: string | null = null;
  for (const s of ctx.target.seasons) {
    const sRes = inspectRes.seasons.find((r) => r.seasonNumber === s.seasonNumber);
    if (!sRes) continue;

    const trackedSeason: TrackedSeason = {
      id: `${ctx.target.title.id}_s${s.seasonNumber}`,
      mediaTitleId: ctx.target.title.id,
      seasonNumber: s.seasonNumber,
      status: "completed",
      qualityPreference: "4K",
      storageDirectoryId: sRes.seasonDirectoryId ?? inspectRes.showDirectoryId ?? "0",
      totalEpisodes: s.totalEpisodes,
      latestAiredEpisode: s.latestAiredEpisode,
      latestAiredSource: "metadata",
    };

    lastRunId = await adoptExistingTvSeason({
      title: ctx.target.title,
      season: trackedSeason,
      repository: ctx.repo,
      accountId: ctx.executionAccountId,
      connectedStorageId: ctx.workspaceId,
      directoryId: sRes.seasonDirectoryId ?? inspectRes.showDirectoryId ?? undefined,
      existingEpisodes: sRes.existingEpisodes,
      isFull: true,
    });
  }

  if (ctx.sharedMode) {
    await ctx.repo.createMediaRequest({
      accountId: ctx.accountId,
      mediaTitleId: ctx.target.title.id,
      seasonNumber: null,
      status: "ready",
      workflowRunId: lastRunId,
    });
  }

  return lastRunId;
}

/**
 * 全剧订阅前置探测：若全剧各季全量落盘，直接纳管并标记完成
 */
export async function tryInspectAndAdoptSeries(input: {
  accountId: string;
  executionAccountId: string;
  workspaceId: string | null;
  target: SeriesTargetInput;
  repo: WorkflowRepository;
  sharedMode: boolean;
}): Promise<{ adopted: boolean; result?: CandidateTrackingRequestResult }> {
  try {
    const fileManager = await getAccountDriveFileManager(input.executionAccountId, input.workspaceId);
    if (!fileManager) return { adopted: false };

    const storageRecord = input.workspaceId
      ? await input.repo.getConnectedStorageById(input.workspaceId)
      : null;

    const categoryCid = storageRecord?.tvCid ?? storageRecord?.animeCid ?? undefined;
    const inspectRes = await inspectStorageBeforeAcquisition({
      storage: fileManager,
      mediaKind: "tv",
      title: input.target.title.title,
      year: input.target.title.year,
      tmdbId: input.target.title.tmdbId,
      categoryParentId: categoryCid || "0",
      seasons: input.target.seasons.map((s) => ({
        seasonNumber: s.seasonNumber,
        totalEpisodes: s.totalEpisodes,
        latestAiredEpisode: s.latestAiredEpisode,
      })),
    });

    if (inspectRes.mediaKind !== "tv" || !inspectRes.matched || inspectRes.seasons.length === 0) {
      return { adopted: false };
    }

    const allFull = input.target.seasons.every((ts) => {
      const sRes = inspectRes.seasons.find((s) => s.seasonNumber === ts.seasonNumber);
      return sRes && sRes.completeness === "full";
    });

    if (!allFull) {
      return { adopted: false };
    }

    const lastRunId = await adoptAllFullSeasons(input, inspectRes);
    return {
      adopted: true,
      result: {
        status: "already_tracked",
        workflowRunId: lastRunId,
        trackedSeasonId: `${input.target.title.id}_s${input.target.seasons[0]?.seasonNumber ?? 1}`,
        message: "检测到网盘已存在该剧全部季集文件，已自动补全并归档！",
      },
    };
  } catch (error) {
    console.warn(`[storage-preflight] series inspection error: ${String(error)}`);
  }
  return { adopted: false };
}

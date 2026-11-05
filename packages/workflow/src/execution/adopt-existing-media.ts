import type {
  EpisodeState,
  MediaTitle,
  TrackedSeason,
  VerifiedFile,
  WorkflowRun,
} from "../domain/domain.js";
import { createEpisodeStates, reconcileVerifiedFiles } from "../domain/domain.js";
import type { WorkflowRepository } from "../persistence/repository.js";
import type { ExistingEpisodeItem } from "../storage/storage-preflight-inspector.js";

export interface AdoptExistingMovieInput {
  title: MediaTitle;
  repository: WorkflowRepository;
  accountId?: string | undefined;
  connectedStorageId?: string | null | undefined;
  directoryId: string;
  videoFiles: Array<{ id: string; name: string; sizeBytes?: number }>;
  qualityPreference?: string | undefined;
  now?: () => string;
}

export interface AdoptExistingTvSeasonInput {
  title: MediaTitle;
  season: TrackedSeason;
  repository: WorkflowRepository;
  accountId?: string | undefined;
  connectedStorageId?: string | null | undefined;
  directoryId?: string | undefined;
  existingEpisodes: ExistingEpisodeItem[];
  isFull: boolean;
  now?: () => string;
}

/**
 * 将网盘中已存在的电影文件自动纳入追踪管理，标记为完成，避免重复下载
 */
export async function adoptExistingMovie(input: AdoptExistingMovieInput): Promise<string> {
  const now = input.now ? input.now() : new Date().toISOString();
  const runId = crypto.randomUUID();

  const season: TrackedSeason = {
    id: `${input.title.id}_movie`,
    mediaTitleId: input.title.id,
    seasonNumber: 1,
    status: "completed",
    qualityPreference: input.qualityPreference ?? "4K",
    storageDirectoryId: input.directoryId,
    totalEpisodes: 1,
    latestAiredEpisode: 1,
    latestAiredSource: "manual",
  };

  const episodes: EpisodeState[] = [
    {
      trackedSeasonId: season.id,
      episodeCode: "S01E01",
      airDate: null,
      title: input.title.title,
      airStatus: "aired",
      obtained: true,
      metadataStatus: "confirmed",
      verifiedFileIds: input.videoFiles.map((f) => f.id),
    },
  ];

  const workflowRun: WorkflowRun = {
    id: runId,
    kind: "movie_init",
    status: "succeeded",
    trackedSeasonId: season.id,
    startedAt: now,
    finishedAt: now,
    auditEvents: [
      {
        type: "existing_media_adopted",
        message: "检测到网盘已存在电影文件，自动补全订阅并归档至媒体库",
        data: {
          directoryId: input.directoryId,
          fileCount: input.videoFiles.length,
          fileNames: input.videoFiles.map((f) => f.name),
        },
      },
    ],
  };

  await input.repository.saveWorkflowRunSnapshot({
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
    title: input.title,
    season,
    workflowRun,
    episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });

  return runId;
}

/**
 * 将网盘中已存在的电视剧/动漫季集自动纳入追踪管理
 * 若全量落盘则标记 completed 阻断后续下载；若部分落盘则标记已有集数并让后台 worker 仅补全缺集
 */
export async function adoptExistingTvSeason(input: AdoptExistingTvSeasonInput): Promise<string> {
  const now = input.now ? input.now() : new Date().toISOString();
  const runId = crypto.randomUUID();

  const updatedSeason: TrackedSeason = {
    ...input.season,
    status: input.isFull ? "completed" : "active",
    storageDirectoryId: input.directoryId ?? input.season.storageDirectoryId,
  };

  const initialEpisodes = createEpisodeStates({
    trackedSeasonId: input.season.id,
    seasonNumber: input.season.seasonNumber,
    totalEpisodes: input.season.totalEpisodes,
    latestAiredEpisode: input.season.latestAiredEpisode,
  });

  const verifiedFiles: VerifiedFile[] = input.existingEpisodes.map((ep) => ({
    id: ep.fileId,
    storageDirectoryId: updatedSeason.storageDirectoryId,
    name: ep.fileName,
    sizeBytes: ep.sizeBytes,
    episodeCode: ep.episodeCode,
    providerFileId: ep.fileId,
    relativePath: ep.fileName,
  }));

  const episodes = reconcileVerifiedFiles({
    season: updatedSeason,
    episodes: initialEpisodes,
    files: verifiedFiles,
  });

  const workflowRun: WorkflowRun = {
    id: runId,
    kind: "type2_init",
    status: input.isFull ? "succeeded" : "queued",
    trackedSeasonId: updatedSeason.id,
    startedAt: now,
    finishedAt: input.isFull ? now : null,
    auditEvents: [
      {
        type: "existing_media_adopted",
        message: input.isFull
          ? `检测到网盘已存在该季全部剧集 (${input.existingEpisodes.length} 集)，自动补全订阅并归档`
          : `检测到网盘已存在 ${input.existingEpisodes.length} 集，自动补全已有集数，缺集转入后台获取`,
        data: {
          existingCount: input.existingEpisodes.length,
          isFull: input.isFull,
          directoryId: updatedSeason.storageDirectoryId,
        },
      },
    ],
  };

  await input.repository.saveWorkflowRunSnapshot({
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
    title: input.title,
    season: updatedSeason,
    workflowRun,
    episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });

  return runId;
}

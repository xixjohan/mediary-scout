import { DEFAULT_ACCOUNT_ID, type MediaTitle } from "@media-track/contracts";
import {
  buildMovieCandidateId,
  buildTvCandidateId,
  parseMovieCandidateId,
  parseTvCandidateId,
  prepareMovieTarget,
  prepareSeriesTarget,
  createTmdbMetadataProvider,
  queueMovieAcquisition,
  queueSeriesInitialization,
  queueTrackingInitialization,
  reserveMovie,
  importForeignWorkAsMovie,
  llmConfigError,
  type CandidateTrackingRequest,
} from "@media-track/workflow";
import {
  getWorkflowRepository,
  getCurrentAccountId,
  requireAuthenticatedAccountId,
} from "../../../composition/runtime-container";
import { resolveQueueStorage, frozenDriveMessage } from "../../storage-drives";
import {
  getAccountScopedSettings,
  UpdateInProgressError,
  isUpdateInProgress,
} from "../../settings-system/application/system-settings-service";
import {
  getTmdbAccesses,
  resolveAgentModelConfig,
} from "../../../lib/runtime/settings-readers";
import { isLiveSearch } from "../../../lib/search-provider";
import {
  findDemoCandidateByTmdbId,
  findDemoCandidateById,
} from "../../../lib/demo-candidates";
import { isUpdateHoldActive, whileInFlight } from "../../../lib/update-hold";
import {
  type CandidateTrackingRequestResult,
  type CandidateReserveRequestResult,
} from "../contracts/acquisition-types";
import {
  getWorkerStorageExecutor,
  getWorkerStorageParents,
  defaultQuality,
} from "./worker-runner-service";

export async function movieTargetFromTmdbId(
  tmdbId: number,
): Promise<{ title: MediaTitle; keyword: string } | null> {
  if (isLiveSearch()) {
    return prepareMovieTarget({
      tmdbId,
      qualityPreference: defaultQuality(),
      metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId()))),
    });
  }
  const candidate = findDemoCandidateByTmdbId(tmdbId);
  if (!candidate || candidate.mediaType !== "movie") {
    return null;
  }
  const title: MediaTitle = {
    id: buildMovieCandidateId({ source: "tmdb", id: candidate.tmdbId }),
    tmdbId: candidate.tmdbId,
    type: "movie",
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    releaseDate: candidate.releaseDate ?? null,
    aliases:
      candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
    posterPath: candidate.posterPath,
    backdropPath: candidate.backdropPath,
    overview: candidate.overview,
  };
  return { title, keyword: candidate.title };
}

export type { CandidateReserveRequestResult };

/**
 * 预定 an unreleased film: track it (carrying its release date) WITHOUT running
 * the agent. The daily patrol's air-time gate acquires it once it releases.
 * Movies only (TV/anime have no reserve concept).
 */

function unsupportedCandidateId(
  reason: MediaIdParseReason,
  candidateId: string,
  wrongKindMessage: string,
): { status: "unsupported"; message: string } {
  if (reason === "malformed") {
    console.warn(`[media-identity] candidate id 畸形（${reason}）: ${candidateId}`);
    return { status: "unsupported", message: "资源标识无法识别，请刷新页面后重试。" };
  }
  return { status: "unsupported", message: wrongKindMessage };
}


async function trackingTargetFromCandidateId(candidateId: string): Promise<{
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
} | null> {
  const parsed = parseTvCandidateId(candidateId);
  if (!parsed.ok) {
    if (parsed.reason === "malformed") {
      console.warn(`[media-identity] trackingTargetFromCandidateId 收到畸形 id: ${candidateId}`);
    }
    return null;
  }

  if (isLiveSearch()) {
    return prepareTrackingTarget({
      tmdbId: parsed.value.id,
      mediaType: "tv",
      seasonNumber: parsed.value.seasonNumber,
      qualityPreference: defaultQuality(),
      storageDirectoryId: storageDirectoryIdForCandidate(candidateId),
      metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId()))),
    });
  }

  const candidate = findDemoCandidateById(candidateId);
  if (!candidate || candidate.mediaType !== "tv") {
    return null;
  }
  return targetFromSearchCandidate(candidate, parsed.value.seasonNumber, candidateId);
}

function targetFromSearchCandidate(
  candidate: MediaSearchCandidate,
  seasonNumber: number,
  candidateId: string,
): {
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
} | null {
  const season = candidate.seasons.find((item) => item.seasonNumber === seasonNumber);
  if (!season) {
    return null;
  }
  const titleId = buildTitleId({ source: "tmdb", mediaKind: "tv", id: candidate.tmdbId });
  const title: MediaTitle = {
    id: titleId,
    tmdbId: candidate.tmdbId,
    type: "tv",
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    aliases: candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
  };
  const trackedSeason: TrackedSeason = {
    id: candidateId,
    mediaTitleId: title.id,
    seasonNumber,
    // Freshly tracked = nothing obtained yet → "active" even for a 完结 show.
    // The bridge grades it "completed" only once fully obtained (see
    // workflow-v2-bridge bridgeSeason). Marking it completed on airing alone made
    // the patrol skip 完结剧-with-gaps forever.
    status: "active",
    qualityPreference: defaultQuality(),
    storageDirectoryId: storageDirectoryIdForCandidate(candidateId),
    totalEpisodes: season.episodeCount,
    latestAiredEpisode: season.latestAiredEpisode,
    latestAiredSource: "metadata",
  };
  return {
    title,
    season: trackedSeason,
    keyword: candidate.title.trim(), // quality NEVER in the keyword (search-methodology law)
  };
}

/** 供用户态资源搜索端点复用（W2）。此前是模块私有；端点要拿同一个按品牌装配的
 *  provider 链，另起一套会让两处的 kind 集合悄悄漂移。 */

export async function queueCandidateTracking(
  candidateId: string,
  connectedStorageId?: string | null,
): Promise<CandidateTrackingRequestResult> {
  let accountId: string;
  try {
    accountId = await requireAuthenticatedAccountId();
  } catch (error) {
    return {
      status: "unsupported",
      message: error instanceof Error ? error.message : "未登录，无法获取。",
    };
  }
  const workspace = await resolveQueueStorage(accountId, connectedStorageId);
  if (workspace.unknown) {
    return { status: "unsupported", message: "网盘工作区不可用（未找到或暂时无法访问），请刷新后重试。" };
  }
  if (workspace.frozen) {
    return { status: "unsupported", message: frozenDriveMessage(workspace.provider, "获取") };
  }
  const movieParsed = parseMovieCandidateId(candidateId);
  if (movieParsed.ok) {
    const movieTmdbId = movieParsed.value.id;
    const movie = await movieTargetFromTmdbId(movieTmdbId);
    if (!movie) {
      return { status: "unsupported", message: "无法获取该电影的信息。" };
    }
    const request = await queueMovieAcquisition({
      title: movie.title,
      keyword: movie.keyword,
      repository: getWorkflowRepository(),
      accountId,
      connectedStorageId: workspace.id,
    });
    return {
      status: request.status === "queued" ? "queued" : request.status,
      workflowRunId: request.workflowRunId,
      trackedSeasonId: `${movie.title.id}_movie`,
    };
  }

  const target = await trackingTargetFromCandidateId(candidateId);
  if (!target) {
    return {
      status: "unsupported",
      message: "暂时只支持剧集第 1 季的后台获取。",
    };
  }

  const request = await queueTrackingInitialization({
    title: target.title,
    season: target.season,
    keyword: target.keyword,
    repository: getWorkflowRepository(),
    accountId,
    connectedStorageId: workspace.id,
  });
  const status = request.status === "completed" ? "queued" : request.status;

  return {
    status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: request.trackedSeasonId,
  };
}

/**
 * Crash recovery for the single-instance in-process worker: any run still
 * "running" when the server (re)starts is orphaned by a dead worker (only this
 * process executes runs), so requeue it to be claimed again — EXCEPT kinds with
 * no queue claimer (see `isQueueClaimableKind`), which are terminal-failed
 * instead: parking those in `queued` strands them and blocks the season.
 * Returns the requeued count (terminal-failed runs are not counted).
 */

export async function reserveCandidate(
  candidateId: string,
  connectedStorageId?: string | null,
): Promise<CandidateReserveRequestResult> {
  let accountId: string;
  try {
    accountId = await requireAuthenticatedAccountId();
  } catch (error) {
    return {
      status: "unsupported",
      message: error instanceof Error ? error.message : "未登录，无法预定。",
    };
  }
  const movieParsed = parseMovieCandidateId(candidateId);
  if (!movieParsed.ok) {
    // malformed 与「不是电影」是两回事：前者说明 id 本身坏了（数据污染/客户端乱传），
    // 后者才是功能边界。混成一句「只有电影可以预定」会让人去查不存在的限制。
    return unsupportedCandidateId(movieParsed.reason, candidateId, "只有电影可以预定。");
  }
  const movie = await movieTargetFromTmdbId(movieParsed.value.id);
  if (!movie) {
    return { status: "unsupported", message: "无法获取该电影的信息。" };
  }
  const workspace = await resolveQueueStorage(accountId, connectedStorageId);
  if (workspace.unknown) {
    return { status: "unsupported", message: "网盘工作区不可用（未找到或暂时无法访问），请刷新后重试。" };
  }
  if (workspace.frozen) {
    return { status: "unsupported", message: frozenDriveMessage(workspace.provider, "预定") };
  }
  const request = await reserveMovie({
    title: movie.title,
    repository: getWorkflowRepository(),
    accountId,
    connectedStorageId: workspace.id,
  });
  return { status: request.status, trackedSeasonId: `${movie.title.id}_movie` };
}

/**
 * Outbound push rides on the feed: whatever notifications a run persisted
 * are delivered to every user-configured channel (DB config > env). Delivery
 * failures are logged, never thrown — the run already succeeded.
 */

export async function queueCandidateSeries(
  candidateId: string,
  connectedStorageId?: string | null,
): Promise<CandidateTrackingRequestResult> {
  const parsed = parseTvCandidateId(candidateId);
  if (!parsed.ok) {
    return unsupportedCandidateId(parsed.reason, candidateId, "暂时只支持剧集的全剧获取。");
  }
  let accountId: string;
  try {
    accountId = await requireAuthenticatedAccountId();
  } catch (error) {
    return {
      status: "unsupported",
      message: error instanceof Error ? error.message : "未登录，无法获取。",
    };
  }
  const workspace = await resolveQueueStorage(accountId, connectedStorageId);
  if (workspace.unknown) {
    return { status: "unsupported", message: "网盘工作区不可用（未找到或暂时无法访问），请刷新后重试。" };
  }
  if (workspace.frozen) {
    return { status: "unsupported", message: frozenDriveMessage(workspace.provider, "获取") };
  }
  if (isLiveSearch()) {
    const target = await prepareSeriesTarget({
      tmdbId: parsed.value.id,
      qualityPreference: defaultQuality(),
      metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getAccountScopedSettings(accountId))),
    });
    const request = await queueSeriesInitialization({
      title: target.title,
      seasons: target.seasons,
      keyword: target.keyword,
      repository: getWorkflowRepository(),
      accountId,
      connectedStorageId: workspace.id,
    });
    return {
      status: request.status === "queued" ? "queued" : request.status,
      workflowRunId: request.workflowRunId,
      trackedSeasonId: `${target.title.id}_s${target.seasons[0]?.seasonNumber ?? 1}`,
    };
  }

  const candidate = findDemoCandidateById(candidateId);
  if (!candidate || candidate.mediaType !== "tv") {
    return { status: "unsupported", message: "暂时只支持剧集的全剧获取。" };
  }
  const request = await queueSeriesInitialization({
    title: {
      id: buildTitleId({ source: "tmdb", mediaKind: "tv", id: candidate.tmdbId }),
      tmdbId: candidate.tmdbId,
      type: "tv",
      title: candidate.title,
      originalTitle: candidate.originalTitle,
      year: candidate.year,
      aliases:
        candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
    },
    seasons: candidate.seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.episodeCount,
      latestAiredEpisode: season.latestAiredEpisode,
    })),
    keyword: candidate.title.trim(), // quality NEVER in the keyword (search-methodology law)
    repository: getWorkflowRepository(),
    accountId,
    connectedStorageId: workspace.id,
  });
  return {
    status: request.status === "queued" ? "queued" : request.status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: buildTvCandidateId({ source: "tmdb", id: candidate.tmdbId, seasonNumber: 1 }),
  };
}

/** Daily auto-update. The worker calls this every tick (3 s): with the switch off it reads
 *  one setting and returns, and it looks at GitHub and the updater once a day, after the
 *  set hour. The day is used up whatever the outcome (no update, offline, a state that says
 *  wait): the next look is tomorrow. */
export { runAutoUpdateIfDue };

/**
 * 每日巡检（per-slot 认领 + 合并补跑）。任何触发源（worker tick / cron / 手动）都
 * 打这里：每次找出「已到点且今天未认领」的时间点，一次性全部认领并只跑一次 sweep
 * ——常开机器各 slot 准点触发；迟启动（桌面）自动补跑一次；错过整天不重放。桌面与
 * 容器同一语义（原 ignoreTimeGate 特例已退役）。`force` 跑完整 sweep 但不认领任何
 * slot（run-now 不得吞掉计划任务）。
 */

export async function acquireLlmPreflightError(
  arg:
    | string
    | {
        settings: { getSetting(key: string): Promise<string | null> };
        env?: NodeJS.ProcessEnv;
      },
): Promise<string | null> {
  const settings = typeof arg === "string" ? getAccountScopedSettings(arg) : arg.settings;
  const env = typeof arg === "string" ? process.env : arg.env ?? process.env;
  if (env.MEDIA_TRACK_AGENT_ADAPTER !== "vercel-ai") {
    return null;
  }
  const resolved = await resolveAgentModelConfig(settings, env);
  return llmConfigError(resolved);
}


export async function importForeignWorkFiles(input: {
  providerFileIds: string[];
  movieTitle: string;
  year: number;
}): Promise<{ movieDirectoryId: string; movedFileIds: string[] }> {
  // Count as in flight: this creates a folder and moves files on the drive. A container
  // swap mid-way would leave the folder made and the files half moved, and the retry
  // then fails. /api/update/busy waits for this to settle before the updater swaps.
  return whileInFlight(async () => {
    // Recheck the hold now that this import is counted in flight. The action checks it too,
    // but between that check and this increment the updater could take the hold and see
    // inFlightCount() === 0 (busy:false), then swap mid-move. Ordering the increment before
    // this check closes that gap: if the hold is on here, the swap has not been cleared yet.
    if (isUpdateHoldActive(Date.now())) throw new UpdateInProgressError();
    // Foreign-work UI is free-text title/year only (no TMDB id). Folder stays the
    // legacy `Title (Year)` form on purpose — `importForeignWorkAsMovie` supports
    // `{tmdb-N}` only when a caller passes tmdbId.
    const accountId = await getCurrentAccountId();
    const parents = await getWorkerStorageParents(accountId);
    return importForeignWorkAsMovie({
      storage: await getWorkerStorageExecutor(accountId),
      providerFileIds: input.providerFileIds,
      movieTitle: input.movieTitle,
      year: input.year,
      moviesParentDirectoryId: parents.movies,
    });
  });
}

function moviesParentDirectoryId(): string {
  return (
    process.env.MEDIA_TRACK_MOVIES_PARENT_CID ??
    process.env.MEDIA_TRACK_115_TEST_ROOT_CID ??
    "fake_movies_root"
  );
}

// ---------------------------------------------------------------------------
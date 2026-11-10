import { NextResponse, type NextRequest } from "next/server";
import {
  buildTitleId,
  adoptExistingMovie,
  adoptExistingTvSeason,
  episodeCodeFromFileName,
  type MediaTitle,
  type TrackedSeason,
  type ExistingEpisodeItem,
} from "@media-track/workflow";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getAccountDriveFileManager } from "../../../../../lib/workflow-runtime";
import { getWorkflowRepository } from "../../../../../composition/runtime-container";
import { seriesTargetFor } from "../../../../../lib/series-target";

interface ReviewItemParams {
  jobId: string;
  itemId: string;
  accountId: string;
  storageId?: string | undefined;
  body: {
    tmdbId?: number | undefined;
    mediaType?: "movie" | "tv" | undefined;
    title?: string | undefined;
    year?: number | undefined;
  };
  item: NonNullable<Awaited<ReturnType<ReturnType<typeof getWorkflowRepository>["listReverseScanItems"]>>[0]>;
  job: NonNullable<Awaited<ReturnType<ReturnType<typeof getWorkflowRepository>["getReverseScanJob"]>>>;
}

async function resolveVideoFiles(
  discoveredFilesJson: string,
  folderId: string,
  fileManager: Awaited<ReturnType<typeof getAccountDriveFileManager>>,
): Promise<Array<{ id: string; name: string; sizeBytes: number }>> {
  try {
    const parsed = JSON.parse(discoveredFilesJson);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {}
  if (!fileManager) return [];
  const listing = await fileManager.listDirectory(folderId);
  return listing.items
    .filter((f) => !f.isFolder && (f.type === "video" || /\.(mp4|mkv|avi|mov|iso|ts)$/i.test(f.name)))
    .map((f) => ({ id: f.id, name: f.name, sizeBytes: f.sizeBytes }));
}

async function adoptTvItemFromReview(params: {
  titleObj: MediaTitle;
  videoFiles: Array<{ id: string; name: string; sizeBytes: number }>;
  folderId: string;
  repo: ReturnType<typeof getWorkflowRepository>;
  accountId: string;
  storageId?: string | undefined;
}): Promise<void> {
  const { titleObj, videoFiles, folderId, repo, accountId, storageId } = params;
  let targetSeason: { totalEpisodes: number; latestAiredEpisode: number } | undefined;
  try {
    const target = await seriesTargetFor(titleObj.tmdbId);
    targetSeason = target?.seasons.find((s) => s.seasonNumber === 1);
  } catch {}

  const existingEpisodes: ExistingEpisodeItem[] = [];
  for (const v of videoFiles) {
    const code = episodeCodeFromFileName(v.name, 1);
    const epMatch = code ? /[Ss](\d{1,2})[Ee](\d{1,4})/i.exec(code) : null;
    const finalEpisode = epMatch ? Number(epMatch[2]) : existingEpisodes.length + 1;
    existingEpisodes.push({
      episodeCode: code ?? `S01E${String(finalEpisode).padStart(2, "0")}`,
      seasonNumber: 1,
      episodeNumber: finalEpisode,
      fileId: v.id,
      fileName: v.name,
      sizeBytes: v.sizeBytes,
    });
  }

  const totalEpisodes = targetSeason?.totalEpisodes ?? Math.max(existingEpisodes.length, 1);
  const latestAired = targetSeason?.latestAiredEpisode ?? totalEpisodes;
  const isFull = existingEpisodes.length >= latestAired && latestAired > 0;

  const trackedSeason: TrackedSeason = {
    id: `${titleObj.id}_s1`,
    mediaTitleId: titleObj.id,
    seasonNumber: 1,
    status: isFull ? "completed" : "active",
    qualityPreference: "1080p",
    storageDirectoryId: folderId,
    totalEpisodes,
    latestAiredEpisode: latestAired,
    latestAiredSource: "metadata",
  };

  await adoptExistingTvSeason({
    title: titleObj,
    season: trackedSeason,
    repository: repo,
    accountId,
    connectedStorageId: storageId,
    directoryId: folderId,
    existingEpisodes,
    isFull,
  });
}

async function handleReviewAccept(params: ReviewItemParams): Promise<NextResponse> {
  const { jobId, itemId, accountId, storageId, body, item, job } = params;
  const tmdbId = body.tmdbId ?? item.matchedTmdbId;
  const mediaType = body.mediaType ?? item.matchedMediaType ?? "movie";
  const resolvedTitle = body.title ?? item.matchedTitle ?? item.parsedTitle ?? item.folderName;
  const resolvedYear = body.year ?? item.parsedYear ?? 2024;

  if (!tmdbId) {
    return NextResponse.json({ error: "缺少 TMDB ID，无法确认入库" }, { status: 422 });
  }

  const repo = getWorkflowRepository();
  const fileManager = await getAccountDriveFileManager(accountId, storageId);
  const videoFiles = await resolveVideoFiles(item.discoveredFilesJson, item.folderId, fileManager);

  const mediaKind: "movie" | "tv" = mediaType === "movie" ? "movie" : "tv";
  const titleObj: MediaTitle = {
    id: buildTitleId({ source: "tmdb", mediaKind, id: tmdbId }),
    tmdbId,
    type: mediaKind,
    title: resolvedTitle,
    originalTitle: resolvedTitle,
    year: resolvedYear,
    aliases: [],
    posterPath: item.matchedPosterPath ?? null,
  };

  if (mediaType === "movie") {
    await adoptExistingMovie({
      title: titleObj,
      repository: repo,
      accountId,
      connectedStorageId: job.storageId,
      directoryId: item.folderId,
      videoFiles,
    });
  } else {
    await adoptTvItemFromReview({
      titleObj,
      videoFiles,
      folderId: item.folderId,
      repo,
      accountId,
      storageId: job.storageId,
    });
  }

  await repo.updateReverseScanItem(itemId, {
    reviewStatus: "user_accepted",
    matchedTmdbId: tmdbId,
    matchedMediaType: mediaType,
    matchedTitle: resolvedTitle,
  });

  await repo.updateReverseScanJob(jobId, {
    autoIngestedTitles: job.autoIngestedTitles + 1,
    pendingReviewTitles: Math.max(0, job.pendingReviewTitles - 1),
  });

  return NextResponse.json({
    success: true,
    message: `已成功纳管「${resolvedTitle}」至媒体库！`,
  });
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  let body: {
    jobId: string;
    itemId: string;
    action: "accept" | "ignore";
    tmdbId?: number | undefined;
    mediaType?: "movie" | "tv" | undefined;
    title?: string | undefined;
    year?: number | undefined;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求格式无效" }, { status: 400 });
  }

  const { jobId, itemId, action } = body;
  if (!jobId || !itemId || !action) {
    return NextResponse.json({ error: "缺少必要参数" }, { status: 400 });
  }

  try {
    const repo = getWorkflowRepository();
    const job = await repo.getReverseScanJob(jobId);
    if (!job || job.accountId !== accountId) {
      return NextResponse.json({ error: "扫描任务不存在" }, { status: 404 });
    }

    const items = await repo.listReverseScanItems(jobId);
    const item = items.find((i) => i.id === itemId);
    if (!item) {
      return NextResponse.json({ error: "扫描项不存在" }, { status: 404 });
    }

    if (action === "ignore") {
      await repo.updateReverseScanItem(itemId, { reviewStatus: "ignored" });
      await repo.updateReverseScanJob(jobId, {
        pendingReviewTitles: Math.max(0, job.pendingReviewTitles - 1),
      });
      return NextResponse.json({ success: true, message: "已忽略该项" });
    }

    if (action === "accept") {
      return handleReviewAccept({
        jobId,
        itemId,
        accountId,
        storageId: job.storageId,
        body,
        item,
        job,
      });
    }

    return NextResponse.json({ error: "不支持的操作" }, { status: 400 });
  } catch (error) {
    console.error("[storage/scan/review] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "确认操作失败" },
      { status: 500 },
    );
  }
}
